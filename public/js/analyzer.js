// ═══════════════════════════════════════════════════════════
// AudioAnalyzer — Beat detection, BPM analysis, and beatmap generation
// ═══════════════════════════════════════════════════════════

class AudioAnalyzer {

  // Analyze an AudioBuffer and return beat/section data
  async analyze(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const samples = this._getMono(audioBuffer);

    // Step 1: Compute onset strength envelope
    const onsets = this._computeOnsets(samples, sampleRate);

    // Step 2: Detect BPM via autocorrelation
    const bpm = this._detectBPM(onsets, sampleRate);

    // Step 3: Track individual beats
    const beats = this._trackBeats(onsets, bpm, sampleRate, audioBuffer.duration);

    // Step 4: Detect sections by energy
    const sections = this._detectSections(samples, sampleRate, beats);

    return {
      bpm: Math.round(bpm * 10) / 10,
      beats,
      sections,
      duration: audioBuffer.duration,
    };
  }

  _getMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0);
    }
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mono[i] = (left[i] + right[i]) / 2;
    }
    return mono;
  }

  _computeOnsets(samples, sr) {
    const frameSize = 1024;
    const hopSize = 512;
    const numFrames = Math.floor((samples.length - frameSize) / hopSize);
    const energy = new Float32Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      let sum = 0;
      for (let j = 0; j < frameSize; j++) {
        const s = samples[start + j];
        sum += s * s;
      }
      energy[i] = Math.sqrt(sum / frameSize);
    }

    // First-order difference, half-wave rectified
    const onset = new Float32Array(numFrames);
    for (let i = 1; i < numFrames; i++) {
      onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    }

    // Adaptive threshold: normalize locally
    const windowSize = 16;
    const threshold = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - windowSize); j <= Math.min(numFrames - 1, i + windowSize); j++) {
        sum += onset[j];
        count++;
      }
      threshold[i] = (sum / count) * 1.5;
    }

    // Apply threshold
    const filtered = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      filtered[i] = onset[i] > threshold[i] ? onset[i] : 0;
    }

    return { values: filtered, energy, hopSize, frameSize };
  }

  _detectBPM(onsets, sr) {
    const { values, hopSize } = onsets;
    const hopSr = sr / hopSize;

    const minBPM = 70;
    const maxBPM = 180;
    const minLag = Math.floor(hopSr * 60 / maxBPM);
    const maxLag = Math.ceil(hopSr * 60 / minBPM);

    let bestLag = minLag;
    let bestCorr = -Infinity;

    for (let lag = minLag; lag <= Math.min(maxLag, values.length / 2); lag++) {
      let corr = 0;
      const len = Math.min(values.length - lag, 4000); // limit for speed
      for (let i = 0; i < len; i++) {
        corr += values[i] * values[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    let bpm = (hopSr * 60) / bestLag;

    // Normalize BPM to common range
    while (bpm > 160) bpm /= 2;
    while (bpm < 70) bpm *= 2;

    return bpm;
  }

  _trackBeats(onsets, bpm, sr, duration) {
    const { values, hopSize } = onsets;
    const hopSr = sr / hopSize;
    const beatInterval = 60 / bpm;

    // Try different phase offsets to find best alignment
    const numPhases = 200;
    let bestPhase = 0;
    let bestScore = -Infinity;

    for (let p = 0; p < numPhases; p++) {
      const phase = (p / numPhases) * beatInterval;
      let score = 0;
      let time = phase;
      while (time < duration && time < 60) {
        const frameIdx = Math.round(time * hopSr);
        if (frameIdx >= 0 && frameIdx < values.length) {
          score += values[frameIdx];
        }
        time += beatInterval;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
      }
    }

    // Generate beat grid
    const beats = [];
    let time = bestPhase;
    while (time < duration) {
      beats.push(Math.round(time * 1000) / 1000);
      time += beatInterval;
    }

    return beats;
  }

  _detectSections(samples, sr, beats) {
    const beatsPerSection = 16; // 4 bars of 4/4
    const sections = [];

    for (let i = 0; i < beats.length; i += beatsPerSection) {
      const startTime = beats[i];
      const endBeatIdx = Math.min(i + beatsPerSection - 1, beats.length - 1);
      const endTime = beats[endBeatIdx];
      const startSample = Math.floor(startTime * sr);
      const endSample = Math.min(Math.floor(endTime * sr), samples.length - 1);

      let energy = 0;
      const count = endSample - startSample;
      if (count > 0) {
        for (let j = startSample; j < endSample; j += 4) {
          energy += samples[j] * samples[j];
        }
        energy /= (count / 4);
      }

      sections.push({
        startTime,
        endTime,
        energy,
        startBeat: i,
        endBeat: endBeatIdx,
      });
    }

    // Normalize energy
    const maxEnergy = Math.max(...sections.map(s => s.energy), 0.0001);
    for (const s of sections) {
      s.normalizedEnergy = s.energy / maxEnergy;
      s.intensity = s.normalizedEnergy > 0.65 ? 'high' :
                    s.normalizedEnergy > 0.3 ? 'medium' : 'low';
    }

    return sections;
  }

  // ═══════════════════════ ALGORITHMIC ANALYSIS (no AudioBuffer) ═══

  // Generate a synthetic analysis when we only know duration (e.g. YouTube stream)
  analyzeAlgorithmic(duration, bpm) {
    bpm = bpm || 120;

    // Generate beat grid
    const beatInterval = 60 / bpm;
    const beats = [];
    let t = beatInterval * 0.5; // small offset so notes don't start at t=0
    while (t < duration) {
      beats.push(Math.round(t * 1000) / 1000);
      t += beatInterval;
    }

    // Generate sections with varying intensity using a hash of the beat index
    const beatsPerSection = 16;
    const sections = [];
    const sectionCount = Math.ceil(beats.length / beatsPerSection);

    // Create an interesting energy curve: intro → build → drop → bridge → drop → outro
    for (let i = 0; i < sectionCount; i++) {
      const startIdx = i * beatsPerSection;
      const endIdx = Math.min(startIdx + beatsPerSection - 1, beats.length - 1);
      const progress = i / Math.max(sectionCount - 1, 1); // 0..1

      // Energy curve: low start, build to peak at ~35%, dip at ~55%, peak again at ~75%, fadeout
      let energy;
      if (progress < 0.15) energy = 0.2 + progress * 2;        // intro
      else if (progress < 0.35) energy = 0.5 + (progress - 0.15) * 2.5; // build
      else if (progress < 0.55) energy = 1.0;                   // drop (high)
      else if (progress < 0.65) energy = 0.3 + Math.random() * 0.2; // breakdown
      else if (progress < 0.85) energy = 0.9 + Math.random() * 0.1; // second drop
      else energy = 0.6 * (1 - (progress - 0.85) / 0.15);       // outro

      energy = Math.max(0.1, Math.min(1, energy));

      sections.push({
        startTime: beats[startIdx],
        endTime: beats[endIdx],
        energy: energy,
        normalizedEnergy: energy,
        startBeat: startIdx,
        endBeat: endIdx,
        intensity: energy > 0.65 ? 'high' : energy > 0.3 ? 'medium' : 'low',
      });
    }

    return { bpm, beats, sections, duration };
  }

  // ═══════════════════════ BEATMAP GENERATION ═══════════════════════

  generateBeatmap(analysis, difficulty) {
    const notes = this._generateDeckNotes(analysis, difficulty);
    const drops = this._detectDrops(analysis);

    // Generate 4-lane hold notes for each beat drop build-up zone
    const beatInterval = 60 / analysis.bpm;
    for (const drop of drops) {
      // Remove any existing notes that overlap with the build-up zone
      const buildStart = drop.buildStart;
      const dropTime = drop.dropTime;
      for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i].time >= buildStart && notes[i].time < dropTime) {
          notes.splice(i, 1);
        }
      }
      // Add a 4-lane hold note spanning the build-up
      const holdDuration = (dropTime - buildStart) - beatInterval * 0.5;
      for (let lane = 0; lane < 4; lane++) {
        notes.push({
          time: buildStart,
          lane: lane,
          type: 'hold',
          duration: Math.max(holdDuration, beatInterval),
          hit: false,
          missed: false,
          rating: null,
          holdCompleted: false,
        });
      }
    }

    // Sort notes by time after modifications
    notes.sort((a, b) => a.time - b.time || a.lane - b.lane);

    return { notes, drops, bpm: analysis.bpm };
  }

  // Detect build-up → drop transitions between sections
  _detectDrops(analysis) {
    const { sections, beats, bpm } = analysis;
    const drops = [];
    const beatInterval = 60 / bpm;

    for (let i = 1; i < sections.length; i++) {
      const prev = sections[i - 1];
      const curr = sections[i];
      // A drop = transition from low/medium to high intensity with significant energy jump
      if (curr.intensity === 'high' && prev.intensity !== 'high' &&
          curr.normalizedEnergy - prev.normalizedEnergy > 0.2) {
        const dropTime = curr.startTime;
        // Build-up zone starts 4 beats before the drop
        const buildStart = Math.max(0, dropTime - beatInterval * 4);
        drops.push({
          buildStart,
          dropTime,
          sectionIndex: i,
        });
      }
    }
    return drops;
  }

  _generateDeckNotes(analysis, difficulty) {
    const { beats, sections, bpm } = analysis;
    const beatInterval = 60 / bpm;
    const notes = [];

    // ─── Speed-based difficulty scaling ────────────
    // Faster BPM → more notes, tighter patterns (like real rhythm games)
    const speedFactor = Math.min(2.0, Math.max(0.5, bpm / 120)); // 1.0 at 120 BPM
    const isfast = bpm >= 140;
    const isSlow = bpm < 90;

    // ─── Massive pattern library (10x variety) ─────
    // Each pattern is an array of { beat, lanes, hold? } entries over a 4-beat measure
    // Patterns are grouped by intensity and difficulty

    const P = {
      low: {
        easy: [
          [{ beat: 0, lanes: [2] }],
          [{ beat: 0, lanes: [0] }],
          [{ beat: 0, lanes: [1] }],
          [{ beat: 0, lanes: [3] }],
          [{ beat: 2, lanes: [2] }],
          [{ beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [2], hold: 3 }],
          [{ beat: 0, lanes: [0], hold: 3 }],
          [{ beat: 0, lanes: [1] }, { beat: 2, lanes: [2] }],
          [{ beat: 0, lanes: [3] }, { beat: 2, lanes: [1] }],
        ],
        medium: [
          [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [0] }, { beat: 2, lanes: [2] }],
          [{ beat: 0, lanes: [1] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 2, lanes: [1] }],
          [{ beat: 0, lanes: [2], hold: 2 }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [0], hold: 2 }, { beat: 2, lanes: [2] }],
          [{ beat: 0, lanes: [1], hold: 2 }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [1] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 2, lanes: [2] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 2, lanes: [3], hold: 1 }],
          [{ beat: 1, lanes: [0] }, { beat: 3, lanes: [2] }],
        ],
        hard: [
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [1] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [3] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [3] }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [2] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [0, 2] }, { beat: 2, lanes: [1, 3] }],
          [{ beat: 0, lanes: [1] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 2, lanes: [0], hold: 1 }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [2], hold: 1 }],
          [{ beat: 0, lanes: [1, 3] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [2] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [0] }],
        ],
        master: [
          [{ beat: 0, lanes: [2, 0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [0, 2] }, { beat: 2.5, lanes: [3] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1, 3] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [3] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [0] }, { beat: 1.5, lanes: [2] }, { beat: 2, lanes: [3, 1] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [0, 2] }, { beat: 1, lanes: [1, 3], hold: 1 }, { beat: 2, lanes: [0] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [3] }, { beat: 3.5, lanes: [1] }],
          [{ beat: 0, lanes: [2] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [3] }, { beat: 1.5, lanes: [1] }, { beat: 2, lanes: [2] }, { beat: 2.5, lanes: [0] }, { beat: 3, lanes: [3] }, { beat: 3.5, lanes: [1] }],
          [{ beat: 0, lanes: [0, 1] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [3], hold: 1 }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [1] }, { beat: 0.5, lanes: [3] }, { beat: 1, lanes: [2, 0] }, { beat: 2, lanes: [1] }, { beat: 2.5, lanes: [3] }, { beat: 3, lanes: [0] }, { beat: 3.5, lanes: [2] }],
          [{ beat: 0, lanes: [0, 3] }, { beat: 0.5, lanes: [1, 2] }, { beat: 1, lanes: [0] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [1, 2] }, { beat: 3, lanes: [0, 3] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [0] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [1], hold: 1 }, { beat: 3, lanes: [2] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [3, 1] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [3] }, { beat: 2.5, lanes: [1] }, { beat: 3, lanes: [0, 2] }],
        ],
      },
      medium: {
        easy: [
          [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [0] }, { beat: 2, lanes: [2] }],
          [{ beat: 0, lanes: [1] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 2, lanes: [1] }],
          [{ beat: 0, lanes: [2], hold: 2 }],
          [{ beat: 0, lanes: [0], hold: 2 }],
          [{ beat: 0, lanes: [0] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [1], hold: 3 }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0] }],
        ],
        medium: [
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [1] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [2] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [1] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [0, 2] }, { beat: 2, lanes: [1, 3] }],
          [{ beat: 0, lanes: [1, 3] }, { beat: 2, lanes: [0, 2] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [0], hold: 1 }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [0, 2] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [1] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [3] }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [3] }, { beat: 3, lanes: [2] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 2, lanes: [0], hold: 1 }],
          [{ beat: 0, lanes: [1] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [3] }, { beat: 3, lanes: [2] }],
        ],
        hard: [
          [{ beat: 0, lanes: [0, 2] }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [1, 3] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [2] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0, 2] }],
          [{ beat: 0, lanes: [1, 2] }, { beat: 1, lanes: [0, 3] }, { beat: 2, lanes: [1, 2] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 2, lanes: [1, 3], hold: 1 }],
          [{ beat: 0, lanes: [2] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [1, 2] }, { beat: 3, lanes: [0, 3] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [2] }, { beat: 2, lanes: [3] }, { beat: 3, lanes: [0, 2] }],
          [{ beat: 0, lanes: [3, 1] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [2, 3] }, { beat: 3, lanes: [1], hold: 1 }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [3] }],
        ],
        master: [
          [{ beat: 0, lanes: [0, 2] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [1, 3] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [0, 2], hold: 1 }, { beat: 3, lanes: [1, 3] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [3] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [3] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [1] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [0, 1] }, { beat: 0.5, lanes: [2, 3] }, { beat: 1, lanes: [0, 1] }, { beat: 1.5, lanes: [2, 3] }, { beat: 2, lanes: [0, 1] }, { beat: 2.5, lanes: [2, 3] }, { beat: 3, lanes: [0, 1] }, { beat: 3.5, lanes: [2, 3] }],
          [{ beat: 0, lanes: [0, 3] }, { beat: 0.5, lanes: [1, 2] }, { beat: 1, lanes: [0] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [1, 2] }, { beat: 2.5, lanes: [0] }, { beat: 3, lanes: [0, 3], hold: 0.5 }],
          [{ beat: 0, lanes: [2] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [3], hold: 1 }, { beat: 2, lanes: [1] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [0, 3] }, { beat: 3.5, lanes: [1] }],
          [{ beat: 0, lanes: [1, 3] }, { beat: 0.5, lanes: [0, 2] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0, 2] }, { beat: 2.5, lanes: [1, 3] }, { beat: 3, lanes: [0] }, { beat: 3.5, lanes: [2] }],
          [{ beat: 0, lanes: [0], hold: 0.5 }, { beat: 0.5, lanes: [1], hold: 0.5 }, { beat: 1, lanes: [2], hold: 0.5 }, { beat: 1.5, lanes: [3], hold: 0.5 }, { beat: 2, lanes: [0, 2] }, { beat: 2.5, lanes: [1, 3] }, { beat: 3, lanes: [0, 1, 2, 3] }],
          [{ beat: 0, lanes: [2, 3] }, { beat: 0.5, lanes: [0, 1] }, { beat: 1, lanes: [2] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [1, 3] }, { beat: 2.5, lanes: [0, 2] }, { beat: 3, lanes: [3] }, { beat: 3.5, lanes: [1] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [2] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [3] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [1] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [0, 1, 2] }, { beat: 1, lanes: [3] }, { beat: 1.5, lanes: [2] }, { beat: 2, lanes: [1, 3] }, { beat: 2.5, lanes: [0] }, { beat: 3, lanes: [2, 3] }, { beat: 3.5, lanes: [0, 1] }],
        ],
      },
      high: {
        easy: [
          [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [0] }, { beat: 2, lanes: [2] }],
          [{ beat: 0, lanes: [2], hold: 2 }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [0] }, { beat: 2, lanes: [1] }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [1] }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [3] }, { beat: 2, lanes: [0] }],
          [{ beat: 0, lanes: [0], hold: 2 }, { beat: 2, lanes: [3] }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 3, lanes: [3] }],
        ],
        medium: [
          [{ beat: 0, lanes: [0, 2] }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [3] }],
          [{ beat: 0, lanes: [1, 3] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [1, 3] }, { beat: 3, lanes: [2] }],
          [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [2] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [1, 2] }],
          [{ beat: 0, lanes: [0] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [1, 3] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [3, 1] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [2, 3] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [0, 2] }, { beat: 2, lanes: [1, 3] }, { beat: 3, lanes: [0] }],
          [{ beat: 0, lanes: [2] }, { beat: 1, lanes: [0, 3] }, { beat: 2, lanes: [1] }, { beat: 3, lanes: [2, 3] }],
          [{ beat: 0, lanes: [0, 1] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [3] }, { beat: 3, lanes: [0, 1] }],
          [{ beat: 0, lanes: [1] }, { beat: 1, lanes: [3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [3, 1] }],
          [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [3], hold: 1 }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [2] }],
        ],
        hard: [
          [{ beat: 0, lanes: [0, 2] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3], hold: 1 }],
          [{ beat: 0, lanes: [3] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [3] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [1] }],
          [{ beat: 0, lanes: [0, 1] }, { beat: 1, lanes: [2, 3] }, { beat: 2, lanes: [0, 1] }, { beat: 2.5, lanes: [3] }, { beat: 3, lanes: [2] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [2, 3] }, { beat: 2, lanes: [0, 1] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [3, 0] }],
          [{ beat: 0, lanes: [1, 3] }, { beat: 0.5, lanes: [0] }, { beat: 1, lanes: [2] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0, 1] }, { beat: 3, lanes: [2, 3] }],
          [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [2, 3] }, { beat: 0.5, lanes: [0, 1] }, { beat: 1, lanes: [2] }, { beat: 2, lanes: [0, 3] }, { beat: 3, lanes: [1, 2] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [1] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
          [{ beat: 0, lanes: [1, 2, 3] }, { beat: 1, lanes: [0] }, { beat: 2, lanes: [1, 2] }, { beat: 2.5, lanes: [3] }, { beat: 3, lanes: [0, 1] }],
        ],
        master: [
          [{ beat: 0, lanes: [0, 2] }, { beat: 0.5, lanes: [1, 3] }, { beat: 1, lanes: [0, 2], hold: 1 }, { beat: 2, lanes: [1, 3] }, { beat: 2.5, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [2] }, { beat: 1.5, lanes: [3] }, { beat: 2, lanes: [0] }, { beat: 2.5, lanes: [1] }, { beat: 3, lanes: [2] }, { beat: 3.5, lanes: [3] }],
          [{ beat: 0, lanes: [0, 1, 2, 3] }, { beat: 1, lanes: [0, 2] }, { beat: 1.5, lanes: [1, 3] }, { beat: 2, lanes: [0, 1, 2, 3] }, { beat: 3, lanes: [0] }, { beat: 3.5, lanes: [2] }],
          [{ beat: 0, lanes: [3, 2] }, { beat: 0.5, lanes: [1, 0] }, { beat: 1, lanes: [3] }, { beat: 1.5, lanes: [2] }, { beat: 2, lanes: [1] }, { beat: 2.5, lanes: [0] }, { beat: 3, lanes: [3, 2] }, { beat: 3.5, lanes: [1, 0] }],
          [{ beat: 0, lanes: [0, 3], hold: 0.5 }, { beat: 0.5, lanes: [1, 2], hold: 0.5 }, { beat: 1, lanes: [0, 3] }, { beat: 1.5, lanes: [1, 2] }, { beat: 2, lanes: [0, 1, 2, 3] }, { beat: 3, lanes: [0, 2] }, { beat: 3.5, lanes: [1, 3] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [3] }, { beat: 1, lanes: [1, 2] }, { beat: 1.5, lanes: [0, 3] }, { beat: 2, lanes: [1] }, { beat: 2.5, lanes: [2] }, { beat: 3, lanes: [0, 3] }, { beat: 3.5, lanes: [1, 2] }],
          [{ beat: 0, lanes: [2, 3] }, { beat: 0.5, lanes: [0, 1] }, { beat: 1, lanes: [2, 3] }, { beat: 1.5, lanes: [0, 1] }, { beat: 2, lanes: [0, 2], hold: 1 }, { beat: 3, lanes: [1, 3] }, { beat: 3.5, lanes: [0] }],
          [{ beat: 0, lanes: [0, 1] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [3] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [1, 2] }, { beat: 2.5, lanes: [3, 0] }, { beat: 3, lanes: [1] }, { beat: 3.5, lanes: [2, 3] }],
          [{ beat: 0, lanes: [0] }, { beat: 0.5, lanes: [2] }, { beat: 1, lanes: [0, 3] }, { beat: 1.5, lanes: [1, 2] }, { beat: 2, lanes: [3] }, { beat: 2.5, lanes: [1] }, { beat: 3, lanes: [0, 2] }, { beat: 3.5, lanes: [1, 3] }],
          [{ beat: 0, lanes: [0, 1, 2] }, { beat: 0.5, lanes: [3] }, { beat: 1, lanes: [0] }, { beat: 1.5, lanes: [1, 2] }, { beat: 2, lanes: [3, 0] }, { beat: 2.5, lanes: [1] }, { beat: 3, lanes: [2, 3] }, { beat: 3.5, lanes: [0, 1] }],
        ],
      },
    };

    // ─── Lane transformation functions for even more variety ───
    const transforms = [
      function identity(lanes) { return lanes; },
      function mirror(lanes) { return lanes.map(function(l) { return 3 - l; }); },
      function shiftRight(lanes) { return lanes.map(function(l) { return (l + 1) % 4; }); },
      function shiftLeft(lanes) { return lanes.map(function(l) { return (l + 3) % 4; }); },
      function shiftTwo(lanes) { return lanes.map(function(l) { return (l + 2) % 4; }); },
      function swap(lanes) { return lanes.map(function(l) { return l < 2 ? l + 2 : l - 2; }); },
      function invert(lanes) { return lanes.map(function(l) { return [1, 0, 3, 2][l]; }); },
    ];

    // Seeded pseudo-random for consistent per-song patterns
    let seed = Math.floor(bpm * 1000) + beats.length;
    function seededRandom() {
      seed = (seed * 1664525 + 1013904223) & 0x7FFFFFFF;
      return seed / 0x7FFFFFFF;
    }

    let sectionIdx = 0;
    let measureCount = 0;
    let lastPatternIdx = -1;
    let lastTransformIdx = -1;

    for (let i = 0; i < beats.length; i++) {
      const beatTime = beats[i];

      // Find current section
      while (sectionIdx < sections.length - 1 &&
             beatTime >= sections[sectionIdx + 1].startTime) {
        sectionIdx++;
      }
      const section = sections[sectionIdx] || sections[0];
      if (!section) continue;

      const beatInSection = i - section.startBeat;
      const beatInMeasure = beatInSection % 4;
      if (beatInMeasure === 0) measureCount++;

      // Get available patterns for current intensity and difficulty
      const patternPool = P[section.intensity] && P[section.intensity][difficulty]
        ? P[section.intensity][difficulty]
        : P.medium.medium;

      // Pick a pattern at the start of each measure, avoiding immediate repeats
      if (beatInMeasure === 0) {
        let attempts = 0;
        let idx;
        do {
          idx = Math.floor(seededRandom() * patternPool.length);
          attempts++;
        } while (idx === lastPatternIdx && attempts < 5 && patternPool.length > 1);
        lastPatternIdx = idx;

        // Pick a transform, avoiding immediate repeats
        attempts = 0;
        let tIdx;
        do {
          tIdx = Math.floor(seededRandom() * transforms.length);
          attempts++;
        } while (tIdx === lastTransformIdx && attempts < 5);
        lastTransformIdx = tIdx;
      }

      const pattern = patternPool[lastPatternIdx] || patternPool[0];
      const transform = transforms[lastTransformIdx] || transforms[0];

      // Find entries matching this beat position (integer part)
      for (const entry of pattern) {
        const entryBeatBase = Math.floor(entry.beat);
        const entrySubBeat = entry.beat - entryBeatBase;

        if (entryBeatBase !== beatInMeasure) continue;

        const subOffset = entrySubBeat * beatInterval;
        const noteTime = beatTime + subOffset;

        // For fast songs (high BPM), skip some sub-beat notes on lower difficulties
        if (isfast && entrySubBeat > 0) {
          if (difficulty === 'easy') continue;
          if (difficulty === 'medium' && seededRandom() < 0.4) continue;
        }

        const computedLanes = transform(entry.lanes);

        for (const lane of computedLanes) {
          const noteType = (entry.hold && entry.hold > 0) ? 'hold' : 'tap';
          const duration = noteType === 'hold' ? (beatInterval * entry.hold) : 0;
          notes.push({
            time: noteTime,
            lane: lane % 4,
            type: noteType,
            duration: duration,
            hit: false,
            missed: false,
            rating: null,
            holdCompleted: false,
          });
        }
      }
    }

    // For fast songs, add extra 8th/16th note fills in high intensity sections
    if (isfast && (difficulty === 'hard' || difficulty === 'master')) {
      for (let s = 0; s < sections.length; s++) {
        if (sections[s].intensity !== 'high') continue;
        const startBeat = sections[s].startBeat;
        const endBeat = sections[s].endBeat;
        for (let b = startBeat; b <= endBeat; b++) {
          if (b >= beats.length) break;
          // Add 8th note fills between beats
          const fillTime = beats[b] + beatInterval * 0.5;
          if (seededRandom() < (difficulty === 'master' ? 0.5 : 0.3)) {
            const fillLane = Math.floor(seededRandom() * 4);
            // Check no note already exists nearby
            const tooClose = notes.some(function(n) { return Math.abs(n.time - fillTime) < beatInterval * 0.2 && n.lane === fillLane; });
            if (!tooClose) {
              notes.push({
                time: fillTime,
                lane: fillLane,
                type: 'tap',
                duration: 0,
                hit: false,
                missed: false,
                rating: null,
                holdCompleted: false,
              });
            }
          }
        }
      }
    }

    // Post-process: ensure minimum gap between consecutive hold notes on the same lane
    notes.sort(function(a, b) { return a.time - b.time || a.lane - b.lane; });
    const minHoldGap = beatInterval * 0.6;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.type !== 'hold' || n.duration <= 0) continue;
      const holdEnd = n.time + n.duration;
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].lane !== n.lane) continue;
        const gap = notes[j].time - holdEnd;
        if (gap < minHoldGap) {
          const newDuration = notes[j].time - n.time - minHoldGap;
          if (newDuration < beatInterval * 0.3) {
            n.type = 'tap';
            n.duration = 0;
          } else {
            n.duration = newDuration;
          }
        }
        break;
      }
    }

    // Remove duplicate notes (same time + lane)
    const seen = new Set();
    const deduped = [];
    for (const n of notes) {
      const key = n.time.toFixed(3) + ':' + n.lane;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(n);
      }
    }

    return deduped;
  }
}

window.AudioAnalyzer = AudioAnalyzer;
