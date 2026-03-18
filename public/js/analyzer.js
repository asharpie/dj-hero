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

    return { notes, drops };
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

    // Define patterns for each intensity level
    // Hold notes appear on all difficulties with increasing frequency
    const patterns = {
      low: {
        easy:   [{ beat: 0, lanes: [2] }],
        medium: [{ beat: 0, lanes: [2], hold: 2 }, { beat: 2, lanes: [0] }],
        hard:   [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [1] }],
        master: [{ beat: 0, lanes: [2, 0] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [3], hold: 1 }, { beat: 2, lanes: [0, 2] }, { beat: 2.5, lanes: [3] }, { beat: 3, lanes: [1] }],
      },
      medium: {
        easy:   [{ beat: 0, lanes: [2] }, { beat: 2, lanes: [0], hold: 2 }],
        medium: [{ beat: 0, lanes: [2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [3] }],
        hard:   [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [3] }],
        master: [{ beat: 0, lanes: [0, 2] }, { beat: 0.5, lanes: [1] }, { beat: 1, lanes: [1, 3] }, { beat: 1.5, lanes: [0] }, { beat: 2, lanes: [0, 2], hold: 1 }, { beat: 3, lanes: [1, 3] }, { beat: 3.5, lanes: [0] }],
      },
      high: {
        easy:   [{ beat: 0, lanes: [2], hold: 2 }, { beat: 2, lanes: [0] }, { beat: 3, lanes: [3] }],
        medium: [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }],
        hard:   [{ beat: 0, lanes: [0, 2], hold: 1 }, { beat: 1, lanes: [1, 3] }, { beat: 2, lanes: [0, 2] }, { beat: 3, lanes: [1, 3], hold: 1 }],
        master: [{ beat: 0, lanes: [0, 2] }, { beat: 0.5, lanes: [1, 3] }, { beat: 1, lanes: [0, 2], hold: 1 }, { beat: 2, lanes: [1, 3] }, { beat: 2.5, lanes: [0, 2] }, { beat: 3, lanes: [1, 3] }, { beat: 3.5, lanes: [0] }],
      },
    };

    // Variation patterns to avoid monotony
    const variations = [
      lanes => lanes,
      lanes => lanes.map(l => (l + 1) % 4),
      lanes => lanes.length > 1 ? [lanes[0]] : lanes,
      lanes => [3],
    ];

    let sectionIdx = 0;
    let measureCount = 0;

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

      // Get pattern for current intensity and difficulty
      const pattern = patterns[section.intensity]?.[difficulty] || patterns.medium.medium;

      // Apply variation every 4 measures
      const varIdx = Math.floor(measureCount / 4) % variations.length;

      // Find all entries matching this beat (including sub-beats like 0.5)
      // For sub-beats on master, generate notes at half-beat positions
      const matchingEntries = pattern.filter(p => {
        if (Number.isInteger(p.beat)) return p.beat === beatInMeasure;
        // Sub-beat: only on master, skip (handled below)
        return false;
      });

      // Also check if the NEXT half-beat has sub-beat entries
      // We generate sub-beat notes offset by half a beat interval
      const subBeatEntries = pattern.filter(p => !Number.isInteger(p.beat) && Math.floor(p.beat) === beatInMeasure);
      for (const subEntry of subBeatEntries) {
        const subOffset = (subEntry.beat - Math.floor(subEntry.beat)) * beatInterval;
        const subTime = beatTime + subOffset;
        let subLanes = subEntry.lanes;
        if (measureCount % 8 >= 4) {
          subLanes = variations[varIdx](subLanes);
        }
        for (const lane of subLanes) {
          const noteType = (subEntry.hold && subEntry.hold > 0) ? 'hold' : 'tap';
          const duration = noteType === 'hold' ? (beatInterval * subEntry.hold) : 0;
          notes.push({
            time: subTime,
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

      if (matchingEntries.length === 0) continue;
      const entry = matchingEntries[0];

      let lanes = entry.lanes;
      if (measureCount % 8 >= 4) {
        lanes = variations[varIdx](lanes);
      }

      for (const lane of lanes) {
        const noteType = (entry.hold && entry.hold > 0) ? 'hold' : 'tap';
        const duration = noteType === 'hold' ? (beatInterval * entry.hold) : 0;
        notes.push({
          time: beatTime,
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

    // Post-process: ensure minimum gap between consecutive hold notes on the same lane
    const minHoldGap = beatInterval * 0.6; // at least 60% of a beat gap
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.type !== 'hold' || n.duration <= 0) continue;
      const holdEnd = n.time + n.duration;
      // Find next note in the same lane
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].lane !== n.lane) continue;
        const gap = notes[j].time - holdEnd;
        if (gap < minHoldGap) {
          // Shorten this hold so there's enough gap
          const newDuration = notes[j].time - n.time - minHoldGap;
          if (newDuration < beatInterval * 0.3) {
            // Too short to be a hold, convert to tap
            n.type = 'tap';
            n.duration = 0;
          } else {
            n.duration = newDuration;
          }
        }
        break; // only check the immediate next note in this lane
      }
    }

    return notes;
  }
}

window.AudioAnalyzer = AudioAnalyzer;
