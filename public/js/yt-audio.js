// ═══════════════════════════════════════════════════════════
// YouTubeAudioEngine — Drop-in replacement for AudioEngine
// that plays audio via YouTube IFrame Player API.
// Provides the same interface so game.js works unchanged.
// ═══════════════════════════════════════════════════════════

class YouTubeAudioEngine {
  constructor() {
    this.player = null;
    this.videoId = null;
    this.started = false;
    this.duration = 0;
    this._ready = false;
    this._readyPromise = null;
    this._readyResolve = null;
    this._startTime = 0;  // performance.now() when play() was called
    this._startOffset = 0;
    this._paused = false;
    this._pauseTime = 0;

    // Audio health: 1.0 = pristine, 0.0 = wrecked
    this.health = { high: 1, mid: 1, low: 1 };
    this.healthTargets = { high: 1, mid: 1, low: 1 };

    // Web Audio context for SFX only (synthesized sounds)
    this.ctx = null;
    this.sfxGain = null;

    // Container for the hidden YouTube player
    this._container = null;
  }

  init() {
    // Create Web Audio context for SFX
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.35;
      this.sfxGain.connect(this.ctx.destination);
    }
  }

  // Load YouTube IFrame API if not already loaded
  static _apiLoaded = false;
  static _apiReady = false;
  static _apiReadyPromise = null;

  static ensureAPI() {
    if (YouTubeAudioEngine._apiReadyPromise) return YouTubeAudioEngine._apiReadyPromise;
    YouTubeAudioEngine._apiReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) {
        YouTubeAudioEngine._apiReady = true;
        resolve();
        return;
      }
      // Set up the global callback
      const existingCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        YouTubeAudioEngine._apiReady = true;
        if (existingCallback) existingCallback();
        resolve();
      };
      if (!YouTubeAudioEngine._apiLoaded) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
        YouTubeAudioEngine._apiLoaded = true;
      }
    });
    return YouTubeAudioEngine._apiReadyPromise;
  }

  async load(videoId) {
    this.init();
    this.videoId = videoId;

    await YouTubeAudioEngine.ensureAPI();

    // Destroy previous player if any
    if (this.player) {
      try { this.player.destroy(); } catch (e) {}
    }

    // Create hidden container
    if (!this._container) {
      this._container = document.createElement('div');
      this._container.id = 'yt-player-container';
      this._container.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;';
      document.body.appendChild(this._container);
    }

    // Create player div
    const playerDiv = document.createElement('div');
    playerDiv.id = 'yt-player-' + Date.now();
    this._container.innerHTML = '';
    this._container.appendChild(playerDiv);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('YouTube player failed to load'));
      }, 15000);

      this.player = new YT.Player(playerDiv.id, {
        width: '1',
        height: '1',
        videoId: videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            clearTimeout(timeout);
            this._ready = true;
            this.duration = this.player.getDuration();
            resolve();
          },
          onError: (e) => {
            clearTimeout(timeout);
            reject(new Error('YouTube player error: ' + e.data));
          },
        },
      });
    });
  }

  getBuffer() {
    // No AudioBuffer in YouTube mode — return null
    // Caller should use algorithmic beatmap instead
    return null;
  }

  play(offset) {
    if (!this.player || !this._ready) return;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();

    const startOffset = offset || 0;
    this._startOffset = startOffset;

    this.player.seekTo(startOffset, true);
    this.player.playVideo();

    this._startTime = performance.now() / 1000 - startOffset;
    this.started = true;
    this._paused = false;
  }

  stop() {
    if (this.player && this._ready) {
      try { this.player.pauseVideo(); } catch (e) {}
    }
    this.started = false;
  }

  pause() {
    if (!this.started) return;
    this._pauseTime = this.getCurrentTime();
    this._paused = true;
    if (this.player && this._ready) {
      try { this.player.pauseVideo(); } catch (e) {}
    }
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    if (this.player && this._ready) {
      this.player.seekTo(this._pauseTime, true);
      this.player.playVideo();
      this._startTime = performance.now() / 1000 - this._pauseTime;
    }
  }

  getCurrentTime() {
    if (this._paused) return this._pauseTime;
    if (!this.started) return 0;
    // Use performance.now for smooth timing (YouTube getCurrentTime updates slowly)
    return performance.now() / 1000 - this._startTime;
  }

  getDuration() {
    if (this.player && this._ready) {
      return this.player.getDuration();
    }
    return this.duration || 0;
  }

  // ─── Audio Degradation (simulated via YouTube volume) ────

  degradeBand(band) {
    if (this.healthTargets[band] === undefined) return;
    this.healthTargets[band] = Math.max(0, this.healthTargets[band] - 0.25);
  }

  restoreBand(band) {
    if (this.healthTargets[band] === undefined) return;
    this.healthTargets[band] = Math.min(1, this.healthTargets[band] + 0.15);
  }

  updateDegradation(dt) {
    const speed = 3;
    for (const band of ['high', 'mid', 'low']) {
      this.health[band] += (this.healthTargets[band] - this.health[band]) * speed * dt;
    }

    // Map average health to YouTube player volume (100 = full, 30 = degraded floor)
    const avgHealth = this.getAverageHealth();
    const volume = 30 + Math.round(avgHealth * 70);
    if (this.player && this._ready) {
      try { this.player.setVolume(volume); } catch (e) {}
    }
  }

  getAverageHealth() {
    return (this.health.high + this.health.mid + this.health.low) / 3;
  }

  resetHealth() {
    this.health = { high: 1, mid: 1, low: 1 };
    this.healthTargets = { high: 1, mid: 1, low: 1 };
    if (this.player && this._ready) {
      try { this.player.setVolume(100); } catch (e) {}
    }
  }

  // ─── EQ Pulse (no-op for YouTube — effects are visual only) ──

  pulseEQ(band) {
    // In YouTube mode, the visual combo feedback still works;
    // we just can't pulse the actual audio EQ
  }

  triggerEffect() {
    // Simulated: brief volume dip
    if (this.player && this._ready) {
      const currentVol = this.player.getVolume();
      this.player.setVolume(Math.max(10, currentVol - 30));
      setTimeout(() => {
        if (this.player && this._ready) {
          this.player.setVolume(currentVol);
        }
      }, 200);
    }
  }

  // ─── Stutter on Miss (simulated via volume) ──────────
  stutterOnMiss() {
    if (!this.player || !this._ready) return;
    const vol = this.player.getVolume();
    this.player.setVolume(0);
    setTimeout(() => {
      if (!this.player || !this._ready) return;
      this.player.setVolume(vol);
      setTimeout(() => {
        if (!this.player || !this._ready) return;
        this.player.setVolume(0);
        setTimeout(() => {
          if (!this.player || !this._ready) return;
          this.player.setVolume(vol);
        }, 30);
      }, 50);
    }, 30);
  }

  // ─── Synthesized SFX (same as AudioEngine) ──────────

  playSFX(type) {
    if (!this.ctx || !this.sfxGain) return;

    if (type === 'drop') {
      this._playSFXTone(50, 0.4, 0.6, 'sine');
      this._playSFXTone(100, 0.2, 0.4, 'sine', 0.02);
      this._playSFXNoise(0.15, 0.5);
    } else if (type === 'drop-fail') {
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

  // ─── Visualizer data (simulated) ────────────────────
  getFrequencyData() {
    // Generate fake frequency data based on time for visual effect
    if (!this.started || this._paused) return null;
    const t = this.getCurrentTime();
    const data = new Uint8Array(128);
    for (let i = 0; i < 128; i++) {
      // Create a visually interesting pattern that pulses
      const base = Math.sin(t * 4 + i * 0.1) * 40 + 80;
      const health = this.getAverageHealth();
      data[i] = Math.max(0, Math.min(255, base * health + Math.random() * 30));
    }
    return data;
  }

  getWaveformData() {
    return null;
  }
}

window.YouTubeAudioEngine = YouTubeAudioEngine;
