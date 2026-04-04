// ═══════════════════════════════════════════════════════════
// DJGame — Core game logic, input handling, and canvas rendering
// ═══════════════════════════════════════════════════════════

class DJGame {
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = audioEngine;

    // Game state
    this.state = 'idle'; // idle | playing | paused | finished
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.crowdMeter = 0.5;
    this.hits = { perfect: 0, great: 0, good: 0, miss: 0 };

    // Beatmap
    this.notes = [];
    this.drops = [];
    this.difficulty = 'medium';
    this.gameDuration = 0;

    // Beat drop state
    this.activeDrop = null;
    this.dropState = 'none'; // none | building | holding | released
    this.dropHoldStart = 0;
    this.dropAllKeysHeld = false;

    // Rendering
    this.scrollSpeed = 400;
    this.hitZoneYRatio = 0.82;
    this.laneColors = ['#00e5ff', '#ff00ff', '#ffea00', '#00ff88'];
    this.laneNames = ['HIGH', 'MID', 'LOW', 'FX'];
    this.particles = [];
    this.hitFlashes = [];
    this.judgmentTexts = [];

    // Combo effects
    this.comboRings = [];
    this.screenShake = { x: 0, y: 0, intensity: 0 };
    this.comboPulse = 0;
    this.lastComboMilestone = 0;

    // Hold note tracking: which hold note is active per lane
    this.activeHolds = [null, null, null, null];

    // Input
    this.keysDown = {};
    this.keyMapping = {
      'd': { lane: 0 },
      'f': { lane: 1 },
      'j': { lane: 2 },
      'k': { lane: 3 },
    };

    // Timing windows (seconds)
    this.windows = {
      perfect: 0.045,
      great: 0.09,
      good: 0.14,
    };

    // Animation
    this.lastTimestamp = 0;
    this.animFrameId = null;

    // Callbacks
    this.onStateChange = null;
    this.onScoreUpdate = null;
    this.onGameEnd = null;
    this.onKeyUpdate = null;

    // Competitive side-by-side mode
    this.competitiveMode = false;
    this.opponentKeys = {};
    this.opponentScore = 0;
    this.opponentCombo = 0;
    this.opponentName = '';

    // Battle Royale mode
    this.brMode = false;
    this.brMyName = '';
    this.brPlayers = []; // [{ username, isBot, score, combo, eliminated, keys }]

    this._boundKeyDown = this._handleKeyDown.bind(this);
    this._boundKeyUp = this._handleKeyUp.bind(this);
  }

  // ─── Setup ───────────────────────────────────────

  loadBeatmap(beatmap, difficulty, duration) {
    // Add a lead-in offset so early notes scroll in from the top
    const leadIn = 2.0; // seconds of lead-in before first note
    this.leadIn = leadIn;

    this.notes = beatmap.notes.map(n => ({ ...n, time: n.time + leadIn }));
    this.drops = (beatmap.drops || []).map(d => ({
      ...d,
      scored: false,
      buildStart: d.buildStart + leadIn,
      dropTime: d.dropTime + leadIn,
    }));
    this.difficulty = difficulty;
    this.gameDuration = duration + leadIn;

    // Base scroll speed by difficulty, scaled by BPM for speed-based difficulty
    const baseSpeed = { easy: 320, medium: 420, hard: 540, master: 600 }[difficulty] || 420;
    const bpm = beatmap.bpm || 120;
    const bpmScale = 0.7 + (bpm / 120) * 0.3; // 1.0 at 120 BPM, faster songs = faster scroll
    this.scrollSpeed = Math.round(baseSpeed * bpmScale);
  }

  setCompetitiveMode(enabled, opponentName) {
    this.competitiveMode = enabled;
    this.opponentName = opponentName || '';
  }

  updateOpponentState(data) {
    if (data.keys) this.opponentKeys = data.keys;
    if (data.score !== undefined) this.opponentScore = data.score;
    if (data.combo !== undefined) this.opponentCombo = data.combo;
  }

  setBRMode(enabled, myName, players) {
    this.brMode = enabled;
    this.brMyName = myName || '';
    this.brPlayers = (players || []).filter(p => p.username !== myName).map(p => ({
      username: p.username,
      isBot: p.isBot,
      score: p.score || 0,
      combo: p.combo || 0,
      eliminated: p.eliminated || false,
      keys: p.keys || {},
    }));
  }

  updateBRPlayers(players) {
    const myName = this.brMyName;
    for (const p of players) {
      if (p.username === myName) continue;
      const existing = this.brPlayers.find(bp => bp.username === p.username);
      if (existing) {
        existing.score = p.score || 0;
        existing.combo = p.combo || 0;
        existing.eliminated = p.eliminated || false;
        existing.keys = p.keys || {};
      }
    }
  }

  start() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.crowdMeter = 0.5;
    this.hits = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.particles = [];
    this.hitFlashes = [];
    this.judgmentTexts = [];
    this.comboRings = [];
    this.screenShake = { x: 0, y: 0, intensity: 0 };
    this.comboPulse = 0;
    this.lastComboMilestone = 0;
    this.activeDrop = null;
    this.dropState = 'none';

    this.activeHolds = [null, null, null, null];

    this.audio.resetHealth();

    for (const n of this.notes) { n.hit = false; n.missed = false; n.rating = null; }
    for (const d of this.drops) { d.scored = false; }

    this.state = 'playing';
    this.lastTimestamp = performance.now();

    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);

    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);

    this._gameLoop(performance.now());
  }

  stop() {
    this.state = 'idle';
    window.removeEventListener('keydown', this._boundKeyDown);
    window.removeEventListener('keyup', this._boundKeyUp);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.audio.pause();
    if (this.onStateChange) this.onStateChange('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.audio.resume();
    this.lastTimestamp = performance.now();
    this._gameLoop(performance.now());
    if (this.onStateChange) this.onStateChange('playing');
  }

  // ─── Input ───────────────────────────────────────

  _handleKeyDown(e) {
    const key = e.key.toLowerCase();

    if (key === 'escape') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      return;
    }

    if (this.state !== 'playing') return;
    if (this.keysDown[key]) return;
    this.keysDown[key] = true;

    const mapping = this.keyMapping[key];
    if (mapping) {
      e.preventDefault();
      if (this.onKeyUpdate) this.onKeyUpdate({ ...this.keysDown });
      // Don't trigger hit checks during beat drops (avoids mash penalty)
      if (this.activeDrop && this.dropState === 'building') return;
      this._checkHit(mapping.lane);
      return;
    }
  }

  _handleKeyUp(e) {
    const key = e.key.toLowerCase();
    this.keysDown[key] = false;

    const mapping = this.keyMapping[key];
    if (mapping) {
      if (this.onKeyUpdate) this.onKeyUpdate({ ...this.keysDown });
      // Don't process hold releases during beat drops
      if (this.activeDrop && this.dropState === 'building') return;

      const lane = mapping.lane;
      const holdNote = this.activeHolds[lane];
      if (holdNote) {
        const currentTime = this.audio.getCurrentTime();
        const holdEnd = holdNote.time + holdNote.duration;
        const diff = Math.abs(currentTime - holdEnd);
        if (diff <= this.windows.good) {
          // Completed hold
          holdNote.holdCompleted = true;
          this._registerHit('great', lane);
        } else if (currentTime >= holdEnd) {
          // Released after hold ended — still counts as completed
          holdNote.holdCompleted = true;
          this._registerHit('good', lane);
        } else if (currentTime < holdEnd - this.windows.good) {
          // Released too early — break combo
          this.combo = 0;
          this.lastComboMilestone = 0;
          this.audio.stutterOnMiss();
        }
        this.activeHolds[lane] = null;
      }
    }
  }

  _checkHit(lane) {
    const currentTime = this.audio.getCurrentTime();

    let bestNote = null;
    let bestDiff = Infinity;

    for (const note of this.notes) {
      if (note.hit || note.missed) continue;
      if (note.lane !== lane) continue;

      const diff = Math.abs(note.time - currentTime);
      if (diff < bestDiff && diff <= this.windows.good) {
        bestDiff = diff;
        bestNote = note;
      }
    }

    if (bestNote) {
      let rating;
      if (bestDiff <= this.windows.perfect) rating = 'perfect';
      else if (bestDiff <= this.windows.great) rating = 'great';
      else rating = 'good';

      bestNote.hit = true;
      bestNote.rating = rating;

      // If hold note, start tracking
      if (bestNote.type === 'hold' && bestNote.duration > 0) {
        this.activeHolds[lane] = bestNote;
      }

      this._registerHit(rating, lane);
    } else {
      // Mash penalty: pressed a key with no note nearby
      // Small combo break and crowd penalty to discourage button mashing
      if (this.combo > 0) {
        this.combo = Math.max(0, this.combo - 5);
      }
      this.crowdMeter = Math.max(0, this.crowdMeter - 0.008);
      if (this.onScoreUpdate) this.onScoreUpdate(this.score, this.combo, this.crowdMeter);
    }
  }

  _registerHit(rating, lane) {
    const points = { perfect: 300, great: 200, good: 100 };
    const multiplier = this.combo < 10 ? 1 : this.combo < 30 ? 2 : this.combo < 60 ? 4 : 8;

    this.score += points[rating] * multiplier;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.hits[rating]++;

    const crowdGain = { perfect: 0.025, great: 0.015, good: 0.008 };
    this.crowdMeter = Math.min(1, this.crowdMeter + crowdGain[rating]);

    // Audio feedback — restore health on hit
    if (lane < 3) {
      const band = ['high', 'mid', 'low'][lane];
      this.audio.restoreBand(band);
      this.audio.pulseEQ(band);
    } else {
      this.audio.triggerEffect();
    }

    // Visual feedback
    this._spawnParticles(lane, rating);
    this._spawnJudgment(lane, rating);

    // Combo milestone effects
    this._checkComboMilestone();

    if (this.onScoreUpdate) this.onScoreUpdate(this.score, this.combo, this.crowdMeter);
  }

  // ─── Update ──────────────────────────────────────

  _update(dt) {
    if (this.state !== 'playing') return;

    const currentTime = this.audio.getCurrentTime();

    // Update audio degradation each frame
    this.audio.updateDegradation(dt);

    // Check for missed notes (skip during active beat drops)
    for (const note of this.notes) {
      if (!note.hit && !note.missed && note.time < currentTime - this.windows.good) {
        // Don't penalize misses during a beat drop
        if (this.activeDrop && this.dropState === 'building') {
          note.hit = true;
          note.rating = 'good';
          continue;
        }
        note.missed = true;
        this.combo = 0;
        this.lastComboMilestone = 0;
        this.hits.miss++;
        this.crowdMeter = Math.max(0, this.crowdMeter - 0.02);

        // Degrade the frequency band for this lane
        if (note.lane < 3) {
          const band = ['high', 'mid', 'low'][note.lane];
          this.audio.degradeBand(band);
        }
        this.audio.stutterOnMiss();

        if (this.onScoreUpdate) this.onScoreUpdate(this.score, this.combo, this.crowdMeter);
      }
    }

    // Check for hold notes that expired without completing
    for (let lane = 0; lane < 4; lane++) {
      const holdNote = this.activeHolds[lane];
      if (holdNote) {
        const holdEnd = holdNote.time + holdNote.duration;
        if (currentTime > holdEnd + this.windows.good) {
          // Expired without release — still count as completed if key was held through
          const keys = ['d', 'f', 'j', 'k'];
          if (this.keysDown[keys[lane]]) {
            holdNote.holdCompleted = true;
            this._registerHit('good', lane);
          } else {
            this.combo = 0;
            this.lastComboMilestone = 0;
            this.audio.stutterOnMiss();
          }
          this.activeHolds[lane] = null;
        }
      }
    }

    // Beat drop logic
    this._updateDrop(currentTime);

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 300 * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // Update hit flashes
    for (let i = this.hitFlashes.length - 1; i >= 0; i--) {
      this.hitFlashes[i].life -= dt;
      if (this.hitFlashes[i].life <= 0) this.hitFlashes.splice(i, 1);
    }

    // Update judgment texts
    for (let i = this.judgmentTexts.length - 1; i >= 0; i--) {
      const j = this.judgmentTexts[i];
      j.y -= 60 * dt;
      j.life -= dt;
      if (j.life <= 0) this.judgmentTexts.splice(i, 1);
    }

    // Update combo rings
    for (let i = this.comboRings.length - 1; i >= 0; i--) {
      const r = this.comboRings[i];
      r.radius += r.speed * dt;
      r.life -= dt;
      if (r.life <= 0) this.comboRings.splice(i, 1);
    }

    // Screen shake decay
    this.screenShake.intensity *= Math.pow(0.02, dt);
    if (this.screenShake.intensity > 0.5) {
      this.screenShake.x = (Math.random() - 0.5) * this.screenShake.intensity;
      this.screenShake.y = (Math.random() - 0.5) * this.screenShake.intensity;
    } else {
      this.screenShake.x = 0;
      this.screenShake.y = 0;
    }

    // Combo pulse decay
    this.comboPulse *= Math.pow(0.05, dt);

    // Check game end
    if (currentTime >= this.gameDuration) {
      this.state = 'finished';
      if (this.onGameEnd) this.onGameEnd(this._getResults());
    }
  }

  // ─── Rendering ───────────────────────────────────

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = rect.width;
    this.H = rect.height;
  }

  _getLayout() {
    const W = this.W;
    const H = this.H;
    const laneW = Math.min(72, W * 0.08);
    const highwayW = laneW * 4;

    if (this.brMode) {
      // BR mode: center highway + 4 mini boards left, 4 mini boards right
      // Mini boards are in 2x2 grids on each side
      const miniScale = 0.38;
      const miniLaneW = Math.round(laneW * miniScale);
      const miniW = miniLaneW * 4;
      const miniH = Math.round(H * miniScale);
      const centerX = W / 2 - highwayW / 2;
      // Left 2x2 grid
      const leftMargin = Math.max(8, centerX - miniW * 2 - 24) / 2;
      // Right 2x2 grid starts after center highway
      const rightStart = W / 2 + highwayW / 2;
      const miniGapX = 6;
      const miniGapY = 6;
      const leftGridX = leftMargin;
      const rightGridX = rightStart + Math.max(8, (W - rightStart - miniW * 2 - miniGapX) / 2);
      const gridTopY = Math.round((H - miniH * 2 - miniGapY) / 2);

      const miniBoards = [];
      // Left 2x2: positions [0,0], [1,0], [0,1], [1,1]
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          miniBoards.push({
            x: leftGridX + col * (miniW + miniGapX),
            y: gridTopY + row * (miniH + miniGapY),
            w: miniW,
            h: miniH,
            laneW: miniLaneW,
          });
        }
      }
      // Right 2x2
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          miniBoards.push({
            x: rightGridX + col * (miniW + miniGapX),
            y: gridTopY + row * (miniH + miniGapY),
            w: miniW,
            h: miniH,
            laneW: miniLaneW,
          });
        }
      }

      return {
        W, H,
        laneW,
        highwayW,
        hitZoneY: H * this.hitZoneYRatio,
        highway: { x: Math.max(10, centerX), w: highwayW },
        miniBoards,
        miniScale,
      };
    }

    if (this.competitiveMode) {
      // Side-by-side: player on left, opponent on right
      const gap = Math.max(40, W * 0.06);
      const playerX = W / 4 - highwayW / 2;
      const opponentX = W * 3 / 4 - highwayW / 2;
      return {
        W, H,
        laneW,
        highwayW,
        hitZoneY: H * this.hitZoneYRatio,
        highway: { x: Math.max(10, playerX), w: highwayW },
        opponentHighway: { x: Math.min(W - highwayW - 10, opponentX), w: highwayW },
      };
    }

    const centerX = W / 2;
    return {
      W, H,
      laneW,
      highwayW,
      hitZoneY: H * this.hitZoneYRatio,
      highway: { x: centerX - highwayW / 2, w: highwayW },
    };
  }

  _render() {
    const ctx = this.ctx;
    const L = this._getLayout();
    const currentTime = this.audio.getCurrentTime();

    // Screen shake transform
    ctx.save();
    ctx.translate(this.screenShake.x, this.screenShake.y);

    // Background — changes based on combo tier
    this._drawComboBackground(ctx, L);

    // Draw highway
    this._drawHighway(ctx, L, L.highway, this.notes, currentTime);

    // Draw drop zone overlay
    this._drawDropZone(ctx, L, currentTime);

    // Draw health bars
    this._drawHealthBars(ctx, L);

    // Draw waveform and progress
    this._drawCenter(ctx, L, currentTime);

    // Draw particles
    this._drawParticles(ctx);

    // Draw combo rings
    this._drawComboRings(ctx, L);

    // Draw judgment texts
    this._drawJudgments(ctx);

    // Draw combo burst
    if (this.combo >= 10) {
      this._drawComboBurst(ctx, L);
    }

    // Draw opponent highway in competitive mode
    if (this.competitiveMode && L.opponentHighway) {
      this._drawOpponentHighway(ctx, L, currentTime);
    }

    // Draw BR mini boards
    if (this.brMode && L.miniBoards) {
      this._drawBRMiniBoards(ctx, L, currentTime);
    }

    ctx.restore();
  }

  _drawHighway(ctx, L, deckLayout, notes, currentTime) {
    const { x, w } = deckLayout;
    const { laneW, hitZoneY, H } = L;

    // Highway background
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fillRect(x, 0, w, H);

    // Lane dividers
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * laneW, 0);
      ctx.lineTo(x + i * laneW, H);
      ctx.stroke();
    }

    // Scrolling grid lines
    const gridSpacing = 60;
    const gridOffset = (currentTime * this.scrollSpeed) % gridSpacing;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    for (let y = -gridOffset; y < H; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.stroke();
    }

    // Hit zone glow
    const gradient = ctx.createLinearGradient(x, hitZoneY - 20, x, hitZoneY + 20);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, hitZoneY - 20, w, 40);

    // Hit zone line
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, hitZoneY);
    ctx.lineTo(x + w, hitZoneY);
    ctx.stroke();

    // Lane indicators at hit zone
    for (let lane = 0; lane < 4; lane++) {
      const lx = x + lane * laneW + laneW / 2;
      const color = this.laneColors[lane];

      ctx.beginPath();
      ctx.arc(lx, hitZoneY, laneW * 0.35, 0, Math.PI * 2);
      ctx.strokeStyle = color + '55';
      ctx.lineWidth = 2;
      ctx.stroke();

      const keys = ['d', 'f', 'j', 'k'];
      if (this.keysDown[keys[lane]]) {
        ctx.fillStyle = color + '33';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
      }

      // Key label below circle
      ctx.fillStyle = this.keysDown[keys[lane]] ? color : 'rgba(255,255,255,0.5)';
      ctx.font = 'bold ' + Math.max(14, laneW * 0.28) + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(keys[lane].toUpperCase(), lx, hitZoneY + laneW * 0.4);
    }

    // Draw notes
    this._drawNotes(ctx, L, deckLayout, notes, currentTime);

    // Draw hit flashes
    for (const flash of this.hitFlashes) {
      const lx = x + flash.lane * laneW;
      const alpha = flash.life / flash.maxLife;
      ctx.globalAlpha = alpha * 0.3;
      ctx.fillStyle = flash.color;
      ctx.fillRect(lx, hitZoneY - 30, laneW, 60);
      ctx.globalAlpha = 1;
    }
  }

  _drawOpponentHighway(ctx, L, currentTime) {
    const deck = L.opponentHighway;
    const { x, w } = deck;
    const { laneW, hitZoneY, H } = L;
    const keys = ['d', 'f', 'j', 'k'];

    // Dimmed highway background
    ctx.fillStyle = 'rgba(255,255,255,0.015)';
    ctx.fillRect(x, 0, w, H);

    // Lane dividers
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * laneW, 0);
      ctx.lineTo(x + i * laneW, H);
      ctx.stroke();
    }

    // Grid lines
    const gridSpacing = 60;
    const gridOffset = (currentTime * this.scrollSpeed) % gridSpacing;
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    for (let y = -gridOffset; y < H; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.stroke();
    }

    // Hit zone line
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, hitZoneY);
    ctx.lineTo(x + w, hitZoneY);
    ctx.stroke();

    // Lane indicators showing opponent's keypresses
    for (let lane = 0; lane < 4; lane++) {
      const lx = x + lane * laneW + laneW / 2;
      const color = this.laneColors[lane];

      ctx.beginPath();
      ctx.arc(lx, hitZoneY, laneW * 0.35, 0, Math.PI * 2);
      ctx.strokeStyle = color + '44';
      ctx.lineWidth = 2;
      ctx.stroke();

      if (this.opponentKeys[keys[lane]]) {
        ctx.fillStyle = color + '33';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
      }

      // Key label
      ctx.fillStyle = this.opponentKeys[keys[lane]] ? color : 'rgba(255,255,255,0.3)';
      ctx.font = 'bold ' + Math.max(12, laneW * 0.24) + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(keys[lane].toUpperCase(), lx, hitZoneY + laneW * 0.4);
    }

    // Draw notes on opponent's highway (same beatmap, dimmed)
    ctx.globalAlpha = 0.5;
    this._drawNotes(ctx, L, deck, this.notes, currentTime);
    ctx.globalAlpha = 1;

    // Opponent name label above highway
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.opponentName || 'Opponent', x + w / 2, 22);

    // Opponent score/combo below name
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textBaseline = 'top';
    ctx.fillText('Score: ' + this.opponentScore.toLocaleString() + '  Combo: ' + this.opponentCombo, x + w / 2, 26);
  }

  _drawBRMiniBoards(ctx, L, currentTime) {
    const players = this.brPlayers;
    const boards = L.miniBoards;
    const keys = ['d', 'f', 'j', 'k'];

    for (let i = 0; i < boards.length && i < players.length; i++) {
      const board = boards[i];
      const player = players[i];
      const { x, y, w, h, laneW: mLaneW } = board;
      const mHitZoneY = y + h * this.hitZoneYRatio;

      ctx.save();

      // Clip to mini board area
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();

      // Background
      if (player.eliminated) {
        ctx.fillStyle = 'rgba(40,40,40,0.6)';
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
      }
      ctx.fillRect(x, y, w, h);

      // Border
      ctx.strokeStyle = player.eliminated ? 'rgba(255,60,90,0.3)' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);

      if (!player.eliminated) {
        // Lane dividers
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        for (let lane = 0; lane <= 4; lane++) {
          ctx.beginPath();
          ctx.moveTo(x + lane * mLaneW, y);
          ctx.lineTo(x + lane * mLaneW, y + h);
          ctx.stroke();
        }

        // Hit zone line
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, mHitZoneY);
        ctx.lineTo(x + w, mHitZoneY);
        ctx.stroke();

        // Lane indicators
        for (let lane = 0; lane < 4; lane++) {
          const lx = x + lane * mLaneW + mLaneW / 2;
          const color = this.laneColors[lane];
          ctx.beginPath();
          ctx.arc(lx, mHitZoneY, mLaneW * 0.3, 0, Math.PI * 2);
          ctx.strokeStyle = color + '44';
          ctx.lineWidth = 1;
          ctx.stroke();
          if (player.keys && player.keys[keys[lane]]) {
            ctx.fillStyle = color + '33';
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.stroke();
          }
        }

        // Draw notes (scaled)
        ctx.globalAlpha = 0.45;
        const noteH = 8;
        const noteMargin = 1;
        for (const note of this.notes) {
          if (note.missed) continue;
          const timeDiff = note.time - currentTime;
          const noteY = mHitZoneY - timeDiff * this.scrollSpeed * (h / L.H);
          if (noteY < y - noteH || noteY > y + h + noteH) continue;
          const nx = x + note.lane * mLaneW + noteMargin;
          const nw = mLaneW - noteMargin * 2;
          const color = this.laneColors[note.lane];

          if (note.type === 'hold' && note.duration > 0) {
            const tailEndY = mHitZoneY - (note.time + note.duration - currentTime) * this.scrollSpeed * (h / L.H);
            ctx.fillStyle = color + '40';
            const topY = Math.min(noteY, tailEndY);
            const btmY = Math.max(noteY, tailEndY);
            ctx.fillRect(nx, topY, nw, btmY - topY);
          }
          ctx.fillStyle = color;
          this._roundRect(ctx, nx, noteY - noteH / 2, nw, noteH, 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Eliminated overlay
      if (player.eliminated) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x, y, w, h);
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,60,90,0.8)';
        ctx.fillText('ELIMINATED', x + w / 2, y + h / 2);
      }

      ctx.restore();

      // Player name above board (outside clip)
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = player.eliminated ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)';
      ctx.textBaseline = 'bottom';
      ctx.fillText(player.username.length > 12 ? player.username.slice(0, 11) + '…' : player.username, x + w / 2, y - 2);

      // Score below board
      ctx.font = '9px monospace';
      ctx.fillStyle = player.eliminated ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText((player.score || 0).toLocaleString(), x + w / 2, y + h + 2);
    }
  }

  _drawNotes(ctx, L, deckLayout, notes, currentTime) {
    const { x } = deckLayout;
    const { laneW, hitZoneY } = L;
    const noteH = 14;
    const noteMargin = 3;

    // Combo-based glow intensity for notes
    let comboGlow = 0;
    if (this.combo >= 100) comboGlow = 20;
    else if (this.combo >= 50) comboGlow = 14;
    else if (this.combo >= 25) comboGlow = 8;
    else if (this.combo >= 10) comboGlow = 4;
    const comboGlowPulse = comboGlow > 0 ? comboGlow + Math.sin(performance.now() / 200) * (comboGlow * 0.4) : 0;

    for (const note of notes) {
      if (note.missed) continue;

      const timeDiff = note.time - currentTime;
      const y = hitZoneY - timeDiff * this.scrollSpeed;

      // For hold notes, draw the tail
      if (note.type === 'hold' && note.duration > 0) {
        const tailEndTime = note.time + note.duration;
        const tailEndY = hitZoneY - (tailEndTime - currentTime) * this.scrollSpeed;
        const nx = x + note.lane * laneW + noteMargin;
        const nw = laneW - noteMargin * 2;
        const color = this.laneColors[note.lane];

        // Skip if entirely off screen
        if (tailEndY > L.H + noteH && y > L.H + noteH) continue;
        if (y < -noteH && tailEndY < -noteH) continue;

        // Draw tail (the bar connecting head to end)
        const topY = Math.min(y, tailEndY);
        const botY = Math.max(y, tailEndY);
        const tailX = nx + nw / 2 - 6;
        const tailW = 12;

        // If hit and being held, shorten from bottom and glow
        const isBeingHeld = note.hit && this.activeHolds[note.lane] === note;
        const drawTopY = isBeingHeld ? Math.min(hitZoneY, topY) : topY;

        if (isBeingHeld) {
          // Bright glowing tail while held
          const holdPulse = 0.7 + Math.sin(performance.now() / 120) * 0.3;
          ctx.shadowColor = color;
          ctx.shadowBlur = 18 * holdPulse;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.9 * holdPulse;
          ctx.fillRect(tailX - 2, drawTopY, tailW + 4, botY - drawTopY);
          // Bright white core
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 0.5 * holdPulse;
          ctx.fillRect(tailX + 2, drawTopY, tailW - 4, botY - drawTopY);
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        } else {
          // Inactive tail
          ctx.fillStyle = color + (note.hit ? '55' : '33');
          ctx.fillRect(tailX, drawTopY, tailW, botY - drawTopY);
        }

        // Draw end cap
        if (!note.hit || !note.holdCompleted) {
          if (isBeingHeld) {
            ctx.shadowColor = color;
            ctx.shadowBlur = 12;
          }
          ctx.fillStyle = color + (isBeingHeld ? 'cc' : '88');
          this._roundRect(ctx, nx, tailEndY - noteH / 2, nw, noteH, 4);
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Draw head (only if not yet hit)
        if (!note.hit) {
          if (y < -noteH || y > L.H + noteH) continue;
          ctx.shadowColor = color;
          ctx.shadowBlur = 8 + comboGlowPulse;
          ctx.fillStyle = color;
          this._roundRect(ctx, nx, y - noteH / 2, nw, noteH, 4);
          ctx.fill();
          ctx.shadowBlur = 0;
          // Hold indicator
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('▬', nx + nw / 2, y + 4);
        }
      } else {
        // Regular tap note
        if (note.hit) continue;
        if (y < -noteH || y > L.H + noteH) continue;

        const nx = x + note.lane * laneW + noteMargin;
        const nw = laneW - noteMargin * 2;
        const color = this.laneColors[note.lane];

        ctx.shadowColor = color;
        ctx.shadowBlur = 8 + comboGlowPulse;
        ctx.fillStyle = color;
        this._roundRect(ctx, nx, y - noteH / 2, nw, noteH, 4);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        this._roundRect(ctx, nx + 2, y - noteH / 2 + 2, nw - 4, noteH / 2 - 2, 2);
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
  }

  _drawCenter(ctx, L, currentTime) {
    const { W, H, hitZoneY, highway } = L;
    const cx = W / 2;

    // Waveform visualization
    this._drawWaveform(ctx, cx - 40, 50, 80, 30);

    // Song progress bar
    const progress = currentTime / this.gameDuration;
    const progressW = 200;
    const progressY = H - 20;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    this._roundRect(ctx, cx - progressW / 2, progressY, progressW, 4, 2);
    ctx.fill();
    ctx.fillStyle = '#00e5ff66';
    this._roundRect(ctx, cx - progressW / 2, progressY, progressW * Math.min(1, progress), 4, 2);
    ctx.fill();

    const elapsed = Math.floor(currentTime);
    const total = Math.floor(this.gameDuration);
    ctx.font = '10px monospace';
    ctx.fillStyle = '#ffffff44';
    ctx.textAlign = 'center';
    ctx.fillText(
      Math.floor(elapsed / 60) + ':' + (elapsed % 60).toString().padStart(2, '0') +
      ' / ' +
      Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0'),
      cx, progressY - 4
    );
  }

  _drawWaveform(ctx, x, y, w, h) {
    const data = this.audio.getFrequencyData();
    if (!data) return;

    const color = '#00e5ff';
    const barCount = 16;
    const barW = w / barCount - 1;

    ctx.fillStyle = color + '44';
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor(i * data.length / barCount);
      const val = data[idx] / 255;
      const barH = val * h;
      ctx.fillRect(x + i * (barW + 1), y + h - barH, barW, barH);
    }
  }

  _drawParticles(ctx) {
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawJudgments(ctx) {
    for (const j of this.judgmentTexts) {
      const alpha = Math.max(0, j.life / j.maxLife);
      ctx.globalAlpha = alpha;
      ctx.font = 'bold ' + j.size + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = j.color;
      ctx.shadowColor = j.color;
      ctx.shadowBlur = 6;
      ctx.fillText(j.text, j.x, j.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  _drawComboBackground(ctx, L) {
    const t = performance.now();

    // Base background
    ctx.fillStyle = '#08080e';
    ctx.fillRect(0, 0, L.W, L.H);

    if (this.combo < 10) return;

    // Determine combo tier: purple → teal → blue → magenta → red → orange → gold
    let tier = 0;
    if (this.combo >= 200) tier = 7;
    else if (this.combo >= 150) tier = 6;
    else if (this.combo >= 100) tier = 5;
    else if (this.combo >= 50) tier = 4;
    else if (this.combo >= 25) tier = 3;
    else if (this.combo >= 10) tier = 2;

    const tierConfigs = [
      null, null,
      { color1: [20, 10, 40], color2: [10, 5, 25], speed: 3000, intensity: 0.15 },     // purple
      { color1: [0, 40, 30], color2: [0, 20, 35], speed: 2500, intensity: 0.25 },       // teal
      { color1: [0, 20, 50], color2: [10, 0, 40], speed: 2000, intensity: 0.35 },       // blue
      { color1: [40, 0, 20], color2: [50, 0, 10], speed: 1800, intensity: 0.4 },        // red
      { color1: [50, 30, 0], color2: [40, 20, 0], speed: 1500, intensity: 0.45 },       // orange
      { color1: [50, 45, 0], color2: [40, 35, 0], speed: 1200, intensity: 0.55 },       // gold
    ];

    const cfg = tierConfigs[tier];
    const pulse = 0.5 + Math.sin(t / cfg.speed * Math.PI * 2) * 0.5;
    const intensity = cfg.intensity * (0.7 + pulse * 0.3);

    // Radial gradient from center
    const cx = L.W / 2;
    const cy = L.H / 2;
    const maxR = Math.max(L.W, L.H) * 0.7;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    const [r1, g1, b1] = cfg.color1;
    const [r2, g2, b2] = cfg.color2;
    grad.addColorStop(0, `rgba(${r1},${g1},${b1},${intensity})`);
    grad.addColorStop(0.5, `rgba(${r2},${g2},${b2},${intensity * 0.6})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, L.W, L.H);

    // Tier 4+: scanning horizontal line
    if (tier >= 4) {
      const lineY = (t / 3000 % 1) * L.H;
      const lineGrad = ctx.createLinearGradient(0, lineY - 30, 0, lineY + 30);
      const lineColor = tier >= 7 ? '255,215,0' : tier >= 5 ? '255,60,90' : '0,229,255';
      lineGrad.addColorStop(0, `rgba(${lineColor},0)`);
      lineGrad.addColorStop(0.5, `rgba(${lineColor},${intensity * 0.3})`);
      lineGrad.addColorStop(1, `rgba(${lineColor},0)`);
      ctx.fillStyle = lineGrad;
      ctx.fillRect(0, lineY - 30, L.W, 60);
    }

    // Tier 5+: edge vignette glow
    if (tier >= 5) {
      const edgeColor = tier >= 7 ? '255,215,0' : tier >= 6 ? '255,140,0' : '255,60,90';
      const edgeAlpha = 0.08 + pulse * 0.06;
      const lg = ctx.createLinearGradient(0, 0, L.W * 0.15, 0);
      lg.addColorStop(0, `rgba(${edgeColor},${edgeAlpha})`);
      lg.addColorStop(1, `rgba(${edgeColor},0)`);
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, L.W * 0.15, L.H);
      const rg = ctx.createLinearGradient(L.W, 0, L.W * 0.85, 0);
      rg.addColorStop(0, `rgba(${edgeColor},${edgeAlpha})`);
      rg.addColorStop(1, `rgba(${edgeColor},0)`);
      ctx.fillStyle = rg;
      ctx.fillRect(L.W * 0.85, 0, L.W * 0.15, L.H);
    }
  }

  _drawComboBurst(ctx, L) {
    const cx = L.highway.x + L.highway.w / 2;
    const cy = L.H * 0.45;
    const t = performance.now();

    // Determine combo tier for font style
    let tier = 0;
    if (this.combo >= 200) tier = 7;
    else if (this.combo >= 150) tier = 6;
    else if (this.combo >= 100) tier = 5;
    else if (this.combo >= 50) tier = 4;
    else if (this.combo >= 25) tier = 3;
    else if (this.combo >= 10) tier = 2;

    // Tier-based font, color, effects
    const tierStyles = [
      null, null,
      { font: 'bold 48px sans-serif', color: '#ffea00', glow: 10, label: '' },
      { font: 'bold 52px sans-serif', color: '#00ff88', glow: 14, label: 'ON FIRE' },
      { font: 'bold 58px sans-serif', color: '#00e5ff', glow: 18, label: 'UNSTOPPABLE' },
      { font: '900 64px sans-serif', color: '#ff3d5a', glow: 25, label: 'SAVAGE' },
      { font: '900 68px sans-serif', color: '#ff8c00', glow: 30, label: 'LEGENDARY' },
      { font: '900 italic 76px sans-serif', color: '#ffd700', glow: 40, label: 'GODLIKE' },
    ];

    const style = tierStyles[tier];
    if (!style) return;

    const alpha = Math.min(0.85, 0.4 + tier * 0.12);
    const breathe = Math.sin(t / (300 - tier * 40)) * 0.15;

    ctx.globalAlpha = alpha + breathe * 0.2;
    ctx.font = style.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Outline for higher tiers
    if (tier >= 3) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = tier >= 4 ? 3 : 2;
      ctx.shadowColor = style.color;
      ctx.shadowBlur = style.glow;
      ctx.strokeText(this.combo + 'x', cx, cy);
    }

    ctx.fillStyle = style.color;
    ctx.shadowColor = style.color;
    ctx.shadowBlur = style.glow + Math.sin(t / 150) * 5;
    ctx.fillText(this.combo + 'x', cx, cy);

    // Tier label text above combo
    if (style.label) {
      ctx.font = `bold ${12 + tier * 2}px monospace`;
      ctx.fillStyle = style.color;
      ctx.globalAlpha = 0.5 + breathe;
      ctx.shadowBlur = 8;
      ctx.fillText(style.label, cx, cy - 40 - tier * 4);
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  // ─── Visual Effects ──────────────────────────────

  _checkComboMilestone() {
    const milestones = [25, 50, 75, 100, 150, 200];
    for (const m of milestones) {
      if (this.combo === m && this.lastComboMilestone < m) {
        this.lastComboMilestone = m;
        this.screenShake.intensity = Math.min(m / 5, 12);
        this.comboPulse = 1;

        // Spawn expanding rings
        const L = this._getLayout();
        const cx = L.highway.x + L.highway.w / 2;
        const cy = L.H * 0.45;
        const color = m >= 100 ? '#ff00ff' : m >= 50 ? '#00e5ff' : '#ffea00';
        for (let i = 0; i < 3; i++) {
          this.comboRings.push({
            x: cx, y: cy,
            radius: 20 + i * 15,
            speed: 200 + i * 50,
            color,
            life: 0.8,
            maxLife: 0.8,
          });
        }
      }
    }
    // Reset milestone tracker on combo break
    if (this.combo === 0) this.lastComboMilestone = 0;
  }

  _drawComboRings(ctx, L) {
    for (const r of this.comboRings) {
      const alpha = Math.max(0, r.life / r.maxLife);
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawHealthBars(ctx, L) {
    // Single combo bar that changes color based on combo tier
    const x = L.highway.x - 40;
    const barH = 200;
    const barW = 8;
    const y = L.hitZoneY - barH - 20;

    // Combo fill: based on combo count, max visual at 200
    const comboFill = Math.min(1, this.combo / 200);

    // Extended color tiers: purple → teal → blue → magenta → red → orange → gold
    let barColor, glowColor;
    if (this.combo >= 200) {
      barColor = '#ffd700'; glowColor = '#ffd700';
    } else if (this.combo >= 150) {
      barColor = '#ff8c00'; glowColor = '#ff8c00';
    } else if (this.combo >= 100) {
      barColor = '#ff3d5a'; glowColor = '#ff3d5a';
    } else if (this.combo >= 50) {
      barColor = '#ff00ff'; glowColor = '#ff00ff';
    } else if (this.combo >= 25) {
      barColor = '#0066ff'; glowColor = '#0066ff';
    } else if (this.combo >= 10) {
      barColor = '#00e5ff'; glowColor = '#00e5ff';
    } else {
      barColor = '#8844cc'; glowColor = '#8844cc';
    }

    // Background
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    this._roundRect(ctx, x, y, barW, barH, 4);
    ctx.fill();

    // Fill from bottom
    const fillH = barH * comboFill;
    if (fillH > 0) {
      // Glow effect for high combos
      if (this.combo >= 50) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 12 + Math.sin(performance.now() / 300) * 6;
      }
      ctx.fillStyle = barColor;
      this._roundRect(ctx, x, y + barH - fillH, barW, fillH, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Label
    ctx.font = '9px monospace';
    ctx.fillStyle = barColor + 'aa';
    ctx.textAlign = 'center';
    ctx.fillText('COMBO', x + barW / 2, y + barH + 14);
  }

  // ─── Beat Drop System ────────────────────────────

  _updateDrop(currentTime) {
    // Find next upcoming or active drop
    for (const drop of this.drops) {
      if (drop.scored) continue;

      if (currentTime >= drop.buildStart && currentTime < drop.dropTime) {
        // In build-up zone
        if (this.dropState === 'none') {
          this.dropState = 'building';
          this.activeDrop = drop;
          this.dropAllKeysHeld = false;
          // Auto-complete any in-progress hold notes so they don't break combo later
          for (let lane = 0; lane < 4; lane++) {
            if (this.activeHolds[lane]) {
              this.activeHolds[lane].holdCompleted = true;
              this.activeHolds[lane] = null;
            }
          }
        }
        // Check if all 4 keys are currently held
        const allHeldNow = this.keysDown['d'] && this.keysDown['f'] &&
                           this.keysDown['j'] && this.keysDown['k'];
        if (allHeldNow) this.dropAllKeysHeld = true;
      } else if (currentTime >= drop.dropTime && !drop.scored) {
        // Past the drop moment — auto-complete if keys were held
        if (this.activeDrop === drop) {
          if (this.dropAllKeysHeld) {
            this._dropSuccess(drop, currentTime);
          } else {
            this._dropFail(drop);
          }
        }
      }
    }
  }

  _dropSuccess(drop, currentTime) {
    drop.scored = true;
    this.dropState = 'none';
    this.activeDrop = null;
    this.activeHolds = [null, null, null, null];

    const timingDiff = Math.abs(currentTime - drop.dropTime);
    const bonus = timingDiff < 0.05 ? 2000 : timingDiff < 0.15 ? 1000 : 500;
    this.score += bonus;
    this.combo += 10;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.crowdMeter = Math.min(1, this.crowdMeter + 0.1);

    // Big visual + audio
    this.audio.playSFX('drop');
    this.screenShake.intensity = 15;
    this.comboPulse = 1;

    // Spawn massive golden particle burst
    const L = this._getLayout();
    const cx = L.highway.x + L.highway.w / 2;
    const cy = L.hitZoneY;
    for (let i = 0; i < 60; i++) {
      const angle = (Math.PI * 2 * i) / 60;
      const speed = 150 + Math.random() * 350;
      const goldColors = ['#ffd700', '#ffea00', '#ffb300', '#fff176'];
      const color = goldColors[i % goldColors.length];
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 200,
        size: 3 + Math.random() * 4,
        color,
        life: 0.8 + Math.random() * 0.4,
        maxLife: 1.2,
      });
    }

    // Golden combo rings
    for (let i = 0; i < 5; i++) {
      this.comboRings.push({
        x: cx, y: cy,
        radius: 10 + i * 20,
        speed: 300 + i * 80,
        color: '#ffd700',
        life: 1.0,
        maxLife: 1.0,
      });
    }

    this._spawnJudgment(1, 'perfect');
    this.judgmentTexts[this.judgmentTexts.length - 1].text = 'DROP!';
    this.judgmentTexts[this.judgmentTexts.length - 1].size = 36;

    if (this.onScoreUpdate) this.onScoreUpdate(this.score, this.combo, this.crowdMeter);
  }

  _dropFail(drop) {
    drop.scored = true;
    this.dropState = 'none';
    this.activeDrop = null;
    this.activeHolds = [null, null, null, null];
    this.combo = 0;
    this.crowdMeter = Math.max(0, this.crowdMeter - 0.08);
    this.audio.playSFX('drop-fail');

    // Degrade all bands on drop fail
    this.audio.degradeBand('high');
    this.audio.degradeBand('mid');
    this.audio.degradeBand('low');

    if (this.onScoreUpdate) this.onScoreUpdate(this.score, this.combo, this.crowdMeter);
  }

  _drawDropZone(ctx, L, currentTime) {
    for (const drop of this.drops) {
      if (drop.scored) continue;
      if (currentTime < drop.buildStart - 2 || currentTime > drop.dropTime + 0.5) continue;

      const { x, w } = L.highway;
      const { hitZoneY, laneW } = L;

      // Build-up zone: pulsing overlay
      if (currentTime >= drop.buildStart && currentTime < drop.dropTime) {
        const progress = (currentTime - drop.buildStart) / (drop.dropTime - drop.buildStart);
        const pulse = 0.15 + Math.sin(performance.now() / (200 - progress * 150)) * 0.1;

        // Highlight all 4 lanes individually
        for (let lane = 0; lane < 4; lane++) {
          const lx = x + lane * laneW;
          const laneColor = this.laneColors[lane];
          ctx.fillStyle = laneColor + Math.floor(pulse * progress * 40).toString(16).padStart(2, '0');
          ctx.fillRect(lx, 0, laneW, hitZoneY);
        }

        // "HOLD ALL KEYS" prompt
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + progress * 0.5})`;
        const prompt = this.dropAllKeysHeld ? '▓▓▓ BUILDING... ▓▓▓' : '>>> HOLD ALL KEYS <<<';
        ctx.fillText(prompt, x + w / 2, hitZoneY - 60);

        // Progress bar
        const barW = w * 0.6;
        const barX = x + (w - barW) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(barX, hitZoneY - 44, barW, 6);
        ctx.fillStyle = this.dropAllKeysHeld ? '#ffd700' : '#ff444488';
        ctx.fillRect(barX, hitZoneY - 44, barW * progress, 6);
      }

      // Golden line at the START of the build-up (where the 4 held notes begin)
      const buildY = hitZoneY - (drop.buildStart - currentTime) * this.scrollSpeed;
      if (buildY > -10 && buildY < L.H) {
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(x, buildY);
        ctx.lineTo(x + w, buildY);
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = '#ffd700';
        ctx.textAlign = 'center';
        ctx.fillText('▼ HOLD ALL ▼', x + w / 2, buildY - 6);
      }
    }
  }

  _spawnParticles(lane, rating) {
    const L = this._getLayout();
    const x = L.highway.x + lane * L.laneW + L.laneW / 2;
    const y = L.hitZoneY;
    const color = this.laneColors[lane];
    const count = rating === 'perfect' ? 20 : rating === 'great' ? 12 : 6;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const speed = 100 + Math.random() * 200;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 100,
        size: 2 + Math.random() * 3,
        color,
        life: 0.4 + Math.random() * 0.3,
        maxLife: 0.7,
      });
    }

    this.hitFlashes.push({
      lane,
      color,
      life: 0.15,
      maxLife: 0.15,
    });
  }

  _spawnJudgment(lane, rating) {
    const L = this._getLayout();
    const x = L.highway.x + L.highwayW / 2;
    const y = L.hitZoneY - 50;

    const colors = { perfect: '#00e5ff', great: '#00ff88', good: '#ffea00' };
    const texts = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD' };

    this.judgmentTexts.push({
      x, y,
      text: texts[rating],
      color: colors[rating],
      size: rating === 'perfect' ? 20 : 16,
      life: 0.6,
      maxLife: 0.6,
    });
  }

  // ─── Helpers ─────────────────────────────────────

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _getResults() {
    const total = this.hits.perfect + this.hits.great + this.hits.good + this.hits.miss;
    const hitCount = this.hits.perfect + this.hits.great + this.hits.good;
    const accuracy = total > 0 ? (hitCount / total * 100) : 0;

    let grade;
    if (accuracy >= 95 && this.hits.miss <= 3) grade = 'S';
    else if (accuracy >= 90) grade = 'A';
    else if (accuracy >= 80) grade = 'B';
    else if (accuracy >= 65) grade = 'C';
    else if (accuracy >= 50) grade = 'D';
    else grade = 'F';

    return {
      score: this.score,
      combo: this.maxCombo,
      hits: { ...this.hits },
      accuracy: Math.round(accuracy * 10) / 10,
      grade,
    };
  }

  // ─── Game Loop ───────────────────────────────────

  _gameLoop(timestamp) {
    if (this.state === 'idle' || this.state === 'finished') return;
    if (this.state === 'paused') return;

    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
    this.lastTimestamp = timestamp;

    this._update(dt);
    this._render();

    this.animFrameId = requestAnimationFrame((t) => this._gameLoop(t));
  }
}

window.DJGame = DJGame;
