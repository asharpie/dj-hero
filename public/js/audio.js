// ═══════════════════════════════════════════════════════════
// AudioEngine — Web Audio API wrapper for single-track playback
// with audio degradation, SFX, and beat drop support
// ═══════════════════════════════════════════════════════════

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.deck = null;
    this.started = false;
    this.startTime = 0;
    this.pauseTime = 0;

    // Audio health: 1.0 = pristine, 0.0 = wrecked
    this.health = { high: 1, mid: 1, low: 1 };
    this.healthTargets = { high: 1, mid: 1, low: 1 };

    // Distortion for low-health
    this.distortion = null;
    this.distortionMix = null;
    this.cleanMix = null;

    // SFX
    this.sfxGain = null;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.masterGain.connect(this.ctx.destination);

    // SFX output (separate from music)
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.35;
    this.sfxGain.connect(this.ctx.destination);

    // Distortion node for degraded audio
    this.distortion = this.ctx.createWaveShaper();
    this.distortion.curve = this._makeDistortionCurve(80);
    this.distortion.oversample = '4x';

    // Wet/dry mix for distortion
    this.distortionMix = this.ctx.createGain();
    this.distortionMix.gain.value = 0;
    this.cleanMix = this.ctx.createGain();
    this.cleanMix.gain.value = 1;

    this.deck = this._createDeck();
  }

  _makeDistortionCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; ++i) {
      const x = i * 2 / samples - 1;
      curve[i] = (3 + amount) * x * 20 * deg / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  _createDeck() {
    const ctx = this.ctx;
    const deck = {
      buffer: null,
      source: null,
      gainNode: ctx.createGain(),
      eqHigh: ctx.createBiquadFilter(),
      eqMid: ctx.createBiquadFilter(),
      eqLow: ctx.createBiquadFilter(),
      analyser: ctx.createAnalyser(),
      playing: false,
    };

    // EQ setup
    deck.eqHigh.type = 'highshelf';
    deck.eqHigh.frequency.value = 3200;
    deck.eqHigh.gain.value = 0;

    deck.eqMid.type = 'peaking';
    deck.eqMid.frequency.value = 1000;
    deck.eqMid.Q.value = 0.7;
    deck.eqMid.gain.value = 0;

    deck.eqLow.type = 'lowshelf';
    deck.eqLow.frequency.value = 320;
    deck.eqLow.gain.value = 0;

    // Analyser
    deck.analyser.fftSize = 256;

    // Chain: source → eqHigh → eqMid → eqLow → gainNode → [clean + distortion mix] → analyser → master
    deck.eqHigh.connect(deck.eqMid);
    deck.eqMid.connect(deck.eqLow);
    deck.eqLow.connect(deck.gainNode);
    deck.gainNode.gain.value = 1;

    // Clean path
    deck.gainNode.connect(this.cleanMix);
    this.cleanMix.connect(deck.analyser);

    // Distortion path
    deck.gainNode.connect(this.distortion);
    this.distortion.connect(this.distortionMix);
    this.distortionMix.connect(deck.analyser);

    deck.analyser.connect(this.masterGain);

    return deck;
  }

  async load(url) {
    this.init();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.deck.buffer = audioBuffer;
    return audioBuffer;
  }

  getBuffer() {
    return this.deck?.buffer || null;
  }

  play(offset) {
    this.init();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const startOffset = offset || 0;
    const deck = this.deck;
    if (!deck.buffer) return;

    if (deck.source) {
      try { deck.source.stop(); } catch (e) {}
    }

    deck.source = this.ctx.createBufferSource();
    deck.source.buffer = deck.buffer;
    deck.source.connect(deck.eqHigh);
    deck.source.start(0, startOffset);
    deck.playing = true;

    this.startTime = this.ctx.currentTime - startOffset;
    this.started = true;
  }

  stop() {
    const deck = this.deck;
    if (deck && deck.source) {
      try { deck.source.stop(); } catch (e) {}
      deck.source = null;
      deck.playing = false;
    }
    this.started = false;
  }

  pause() {
    if (!this.started) return;
    this.pauseTime = this.getCurrentTime();
    this.stop();
  }

  resume() {
    if (this.pauseTime > 0) {
      this.play(this.pauseTime);
    }
  }

  getCurrentTime() {
    if (!this.started) return this.pauseTime || 0;
    return this.ctx.currentTime - this.startTime;
  }

  getDuration() {
    return this.deck?.buffer?.duration || 0;
  }

  // ─── Audio Degradation System ────────────────────

  // Called on miss — degrades the EQ band for that lane
  degradeBand(band) {
    if (!this.healthTargets[band] && this.healthTargets[band] !== 0) return;
    this.healthTargets[band] = Math.max(0, this.healthTargets[band] - 0.25);
  }

  // Called on hit — restores the EQ band for that lane
  restoreBand(band) {
    if (!this.healthTargets[band] && this.healthTargets[band] !== 0) return;
    this.healthTargets[band] = Math.min(1, this.healthTargets[band] + 0.15);
  }

  // Call each frame to smoothly animate health
  updateDegradation(dt) {
    if (!this.deck) return;
    const speed = 3; // interpolation speed
    for (const band of ['high', 'mid', 'low']) {
      this.health[band] += (this.healthTargets[band] - this.health[band]) * speed * dt;

      const h = this.health[band];
      const filterMap = { high: this.deck.eqHigh, mid: this.deck.eqMid, low: this.deck.eqLow };
      // At health 1.0 → 0 dB cut. At health 0.0 → -30 dB cut
      filterMap[band].gain.value = -30 * (1 - h);
    }

    // Distortion mix based on average health
    const avgHealth = (this.health.high + this.health.mid + this.health.low) / 3;
    const distAmt = Math.max(0, 0.4 * (1 - avgHealth));
    this.distortionMix.gain.value = distAmt;
    this.cleanMix.gain.value = 1 - distAmt * 0.5;
  }

  getAverageHealth() {
    return (this.health.high + this.health.mid + this.health.low) / 3;
  }

  resetHealth() {
    this.health = { high: 1, mid: 1, low: 1 };
    this.healthTargets = { high: 1, mid: 1, low: 1 };
  }

  // ─── EQ Pulse (brief flash on hit for feedback) ──

  pulseEQ(band) {
    const deck = this.deck;
    if (!deck) return;
    // Brief positive boost for tactile feel, then return to health-driven level
    const filterMap = { high: deck.eqHigh, mid: deck.eqMid, low: deck.eqLow };
    const filter = filterMap[band];
    if (!filter) return;

    const now = this.ctx.currentTime;
    const currentGain = -30 * (1 - this.health[band]);
    filter.gain.cancelScheduledValues(now);
    filter.gain.setValueAtTime(6, now);
    filter.gain.linearRampToValueAtTime(currentGain, now + 0.12);
  }

  // Trigger a filter sweep effect
  triggerEffect() {
    const deck = this.deck;
    if (!deck) return;

    const now = this.ctx.currentTime;
    deck.eqHigh.gain.cancelScheduledValues(now);
    deck.eqHigh.gain.setValueAtTime(-18, now);
    deck.eqHigh.gain.linearRampToValueAtTime(-30, now + 0.1);
    deck.eqHigh.gain.linearRampToValueAtTime(-30 * (1 - this.health.high), now + 0.3);
  }

  // ─── Synthesized Sound Effects ───────────────────

  // Brief volume stutter on miss — the music hiccups
  stutterOnMiss() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(0.8, now);
    this.masterGain.gain.setValueAtTime(0, now + 0.01);
    this.masterGain.gain.setValueAtTime(0.8, now + 0.06);
    this.masterGain.gain.setValueAtTime(0, now + 0.08);
    this.masterGain.gain.linearRampToValueAtTime(0.8, now + 0.14);
  }

  playSFX(type) {
    if (!this.ctx || !this.sfxGain) return;
    const now = this.ctx.currentTime;

    if (type === 'drop') {
      // Big sub-bass boom + white noise burst
      this._playSFXTone(50, 0.4, 0.6, 'sine');
      this._playSFXTone(100, 0.2, 0.4, 'sine', 0.02);
      this._playSFXNoise(0.15, 0.5);
    } else if (type === 'drop-fail') {
      // Descending sad tone
      this._playSFXTone(300, 0.2, 0.3, 'sawtooth');
      this._playSFXTone(150, 0.2, 0.3, 'sawtooth', 0.15);
    }
  }

  _playSFXTone(freq, duration, volume, waveType, delay) {
    const now = this.ctx.currentTime + (delay || 0);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = waveType || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  _playSFXNoise(duration, volume) {
    const now = this.ctx.currentTime;
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2000;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    source.start(now);
    source.stop(now + duration + 0.01);
  }

  getWaveformData() {
    const deck = this.deck;
    if (!deck || !deck.analyser) return null;
    const data = new Uint8Array(deck.analyser.frequencyBinCount);
    deck.analyser.getByteTimeDomainData(data);
    return data;
  }

  getFrequencyData() {
    const deck = this.deck;
    if (!deck || !deck.analyser) return null;
    const data = new Uint8Array(deck.analyser.frequencyBinCount);
    deck.analyser.getByteFrequencyData(data);
    return data;
  }
}

window.AudioEngine = AudioEngine;
