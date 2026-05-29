/* ════════════════════════════════════════════════════════════════════════
   Piano — affective ambient engine for the letter
   ────────────────────────────────────────────────────────────────────────
   Ported from kaios-sdk/src/audio/piano/piano-engine.ts (the musical brain:
   432Hz tuning, voicings, voice-leading, motif development) and played
   through a warm FM Rhodes voice (not a sine stack).

   Sonic north stars:
     · Hiroshi Yoshimura — "Music for Nine Post Cards"  (patient, sparse, glassy)
     · C418 — Minecraft                                  (warm, simple, spacious)
     · Arcade Fire — "Her" OST                           (felt, aching, tender)
     · a breath of yeule                                 (air, detune, long tails)

   Restraint is the point. Silence is an instrument. The arc follows the
   letter's feeling: setAffect() sets the harmonic world per sentence,
   setValence()/setArousal() modulate expression live per word, cue() blooms
   a deliberate chord under the pivotal lines.
   ════════════════════════════════════════════════════════════════════════ */
window.Piano = (function () {
  'use strict';

  // ── 432Hz note table (A4 = 432) ───────────────────────────────────────
  const NOTE = {};
  (function buildNotes() {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    // A4 = 432, equal temperament
    for (let oct = 1; oct <= 6; oct++) {
      for (let n = 0; n < 12; n++) {
        const midi = (oct + 1) * 12 + n;       // standard MIDI
        const semisFromA4 = midi - 69;
        NOTE[names[n] + oct] = 432 * Math.pow(2, semisFromA4 / 12);
      }
    }
  })();

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  const SCALES = {
    major:          [0,2,4,5,7,9,11],
    majorPent:      [0,2,4,7,9],
    minorPent:      [0,3,5,7,10],
    dorian:         [0,2,3,5,7,9,10],
    lydian:         [0,2,4,6,7,9,11],
    minor:          [0,2,3,5,7,8,10],
    harmonicMinor:  [0,2,3,5,7,8,11],
    japanese:       [0,2,3,7,8],   // in-sen-ish, spacious + a touch of ache
  };

  const CHORDS = {
    add9:    [0,4,7,14],
    major7:  [0,4,7,11],
    major9:  [0,4,7,11,14],
    sus2:    [0,2,7],
    sus4:    [0,5,7],
    minor7:  [0,3,7,10],
    minor9:  [0,3,7,10,14],
    six:     [0,4,7,9],
  };

  // ── Affect → musical world (Yoshimura-biased: slow, sparse, soft) ──────
  // density 0..1 (chance of a phrase per tick), reg = base octave for melody
  const AFFECT = {
    neutral: { keys:['C','G'],     scales:['majorPent','dorian'],  chords:['add9','sus2'],          density:0.34, reg:4, vel:[0.16,0.26], valence:0.10, arousal:0.25 },
    think:   { keys:['E','G','D'], scales:['dorian','majorPent'],  chords:['sus2','minor7','add9'], density:0.26, reg:4, vel:[0.14,0.24], valence:0.00, arousal:0.20 },
    sad:     { keys:['A','D'],     scales:['japanese','dorian','minor'], chords:['minor7','sus2'],   density:0.18, reg:4, vel:[0.12,0.22], valence:-0.55, arousal:0.18 },
    tender:  { keys:['F','C'],     scales:['major','majorPent'],   chords:['major7','add9','six'],  density:0.22, reg:4, vel:[0.13,0.23], valence:-0.10, arousal:0.26 },
    hope:    { keys:['C','G'],     scales:['major','lydian','majorPent'], chords:['major7','add9'],  density:0.40, reg:5, vel:[0.18,0.30], valence:0.55, arousal:0.42 },
    joy:     { keys:['G','D','C'], scales:['majorPent','lydian'],  chords:['major7','add9','six'],  density:0.46, reg:5, vel:[0.20,0.32], valence:0.72, arousal:0.52 },
    awe:     { keys:['C','F'],     scales:['lydian','major'],      chords:['major9','add9'],         density:0.36, reg:5, vel:[0.20,0.32], valence:0.62, arousal:0.50 },
  };

  // ── audio graph ────────────────────────────────────────────────────────
  let ctx = null, master = null, dry = null, wet = null, verb = null,
      airGain = null, airNode = null, tickBus = null, started = false, alive = false;

  // live affective state (smoothed toward targets)
  let cur = { mood: AFFECT.neutral, key: 'C', scale: 'majorPent',
              valence: 0.1, arousal: 0.25, density: 0.34, reg: 4 };
  let tgt = { valence: 0.1, arousal: 0.25, density: 0.34, reg: 4 };
  let lastRight = 'E4', loopTimer = null, prog = 0, lastTick = 0, sinceBass = 9;
  let noteListener = null, arc = 0, tgtArc = 0;

  const rnd  = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function makeReverbIR(seconds, decay) {
    const rate = ctx.sampleRate, len = (rate * seconds) | 0;
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // soft, smooth tail (not metallic)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  function buildGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    tickBus = ctx.createGain(); tickBus.gain.value = 0.8; tickBus.connect(ctx.destination);

    // gentle master lowpass — felt, never harsh
    const mlp = ctx.createBiquadFilter();
    mlp.type = 'lowpass'; mlp.frequency.value = 6200; mlp.Q.value = 0.3;
    mlp.connect(master);

    dry = ctx.createGain(); dry.gain.value = 0.5;  dry.connect(mlp);
    wet = ctx.createGain(); wet.gain.value = 0.72; wet.connect(mlp);
    verb = ctx.createConvolver(); verb.buffer = makeReverbIR(4.2, 2.4); verb.connect(wet);

    // tape-air bed (Yoshimura warmth) — barely-there filtered noise
    const noiseLen = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;
    airNode = ctx.createBufferSource(); airNode.buffer = nb; airNode.loop = true;
    const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 520; af.Q.value = 0.2;
    airGain = ctx.createGain(); airGain.gain.value = 0.0;
    airNode.connect(af); af.connect(airGain); airGain.connect(mlp);
    airNode.start();

    // master fade in
    master.gain.setValueAtTime(0.0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 2.2);
    airGain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 3.0);
  }

  // ── the voice: FM electric piano (Rhodes-ish), warm + felt ─────────────
  function strike(freq, dur, vel, bright) {
    if (!ctx || freq <= 0) return;
    const t0 = ctx.currentTime;
    bright = bright == null ? 0.4 : bright;

    // two slightly detuned carriers for chorus/air (yeule breath)
    [-1, 1].forEach((side, k) => {
      const detune = side * rnd(3, 7);          // cents
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = freq;
      carrier.detune.value = detune;

      // FM modulator -> carrier.frequency (bell-tine attack that decays to mellow body)
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * (k === 0 ? 1 : 2);  // 1:1 body + 2:1 shimmer
      const modGain = ctx.createGain();
      const idxAtk = freq * (2.2 + bright * 3.4);
      const idxBody = freq * 0.5;
      modGain.gain.setValueAtTime(idxAtk, t0);
      modGain.gain.exponentialRampToValueAtTime(Math.max(1, idxBody), t0 + 0.16);
      mod.connect(modGain); modGain.connect(carrier.frequency);

      // amp envelope — soft attack, singing decay, long release
      const amp = ctx.createGain();
      const peak = vel * (k === 0 ? 1 : 0.5);
      amp.gain.setValueAtTime(0, t0);
      amp.gain.linearRampToValueAtTime(peak, t0 + 0.014);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0008, peak * 0.55), t0 + 0.28);
      amp.gain.exponentialRampToValueAtTime(0.0006, t0 + dur);

      // per-voice tone shaping
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900 + vel * 3200 + bright * 2600;
      lp.Q.value = 0.5;

      carrier.connect(amp); amp.connect(lp);
      lp.connect(dry); lp.connect(verb);

      carrier.start(t0); mod.start(t0);
      const stop = t0 + dur + 0.5;
      carrier.stop(stop); mod.stop(stop);
    });
  }

  // ── music theory helpers ───────────────────────────────────────────────
  function scaleNotes(key, scaleName, octave) {
    const ivs = SCALES[scaleName] || SCALES.majorPent;
    const root = NOTE_NAMES.indexOf(key);
    return ivs.map(iv => {
      const ni = (root + iv) % 12;
      const oc = octave + Math.floor((root + iv) / 12);
      return NOTE_NAMES[ni] + oc;
    });
  }
  function chordNotes(key, chordName, octave) {
    const ivs = CHORDS[chordName] || CHORDS.add9;
    const root = NOTE_NAMES.indexOf(key);
    return ivs.map(iv => {
      const ni = (root + iv) % 12;
      const oc = octave + Math.floor((root + iv) / 12);
      return NOTE_NAMES[ni] + oc;
    });
  }
  // nearest scale tone to last note (voice leading: gentle steps)
  function nextMelody(scaleArr) {
    const li = scaleArr.indexOf(lastRight);
    let idx;
    if (li === -1) idx = (Math.random() * scaleArr.length) | 0;
    else {
      const r = Math.random();
      const step = r < 0.16 ? 0 : r < 0.62 ? 1 : r < 0.85 ? 2 : 3;
      const dir = Math.random() < 0.5 ? -1 : 1;
      idx = clamp(li + step * dir, 0, scaleArr.length - 1);
    }
    lastRight = scaleArr[idx];
    return lastRight;
  }

  // ── the generative loop — silence → a slow build → a quiet two-hand pianist ──
  // arc (0→1, driven by the letter's progress) gates everything: nothing for the first
  // ~2 paragraphs, then single notes, then chords, growing brighter/fuller toward the rose.
  const ONSET = 0.05;     // ~after the first two paragraphs
  function loopStep() {
    if (!alive) return;
    arc += (tgtArc - arc) * 0.2;
    cur.valence += (tgt.valence - cur.valence) * 0.16;
    cur.arousal += (tgt.arousal - cur.arousal) * 0.16;
    cur.density += (tgt.density - cur.density) * 0.16;

    // hold complete silence until she's a couple paragraphs in
    if (arc < ONSET) { loopTimer = setTimeout(loopStep, 700); return; }

    const m = cur.mood;
    const grow = clamp((arc - ONSET) / (1 - ONSET), 0, 1);    // 0 at onset → 1 by the end
    const effVal = clamp(cur.valence + (grow - 0.5) * 0.7, -1, 1);
    const dens = clamp(grow * 0.55 + cur.density * 0.2, 0.04, 0.6);
    const vBase = rnd(m.vel[0], m.vel[1]) * (0.7 + grow * 0.32 + cur.arousal * 0.2);
    const bright = clamp(0.2 + grow * 0.46 + cur.arousal * 0.22 + Math.max(0, effVal) * 0.2, 0.1, 1);
    const reg = clamp((m.reg || 4) + (grow < 0.3 ? -1 : 0), 3, 5);

    let scaleName;
    if (grow < 0.36) scaleName = pick(['minor', 'dorian', 'japanese']);
    else if (grow > 0.66) scaleName = pick(['major', 'lydian', 'majorPent']);
    else scaleName = cur.scale;
    const chordName = pick(m.chords);

    let root = cur.key;
    if (Math.random() < 0.45) {
      const moves = [0, 0, 7, 5, 9, 2];
      const ri = NOTE_NAMES.indexOf(cur.key);
      root = NOTE_NAMES[(ri + moves[(Math.random() * moves.length) | 0] + 12) % 12];
    }
    const scale = scaleNotes(root, scaleName, reg);

    // LEFT HAND — chords only build in after ~1/4 of the way, and stay sparing
    sinceBass++;
    if (grow > 0.26 && (sinceBass >= (grow > 0.55 ? 3 : 4) || Math.random() < 0.16)) {
      sinceBass = 0;
      strike(NOTE[root + '2'] || NOTE[root + '3'], rnd(4.5, 7), vBase * 0.5, bright * 0.5);
      const ch = chordNotes(root, chordName, 3);
      ch.slice(0, 2 + (Math.random() < 0.5 ? 1 : 0)).forEach((n, i) =>
        setTimeout(() => alive && strike(NOTE[n], rnd(3.4, 5.5), vBase * 0.4 * (1 - i * 0.06), bright * 0.5),
                   70 + i * rnd(90, 180)));
      // the only moment a pulse may bloom (gated + throttled in the page)
      if (noteListener) { try { noteListener({ strength: vBase }); } catch (_) {} }
    }

    // RIGHT HAND — single notes early, fuller figures as it grows
    if (Math.random() < dens) {
      if (grow < 0.3) {
        strike(NOTE[nextMelody(scale)], rnd(2.8, 4.2), vBase * 0.9, bright);
        if (Math.random() < 0.3)
          setTimeout(() => alive && strike(NOTE[nextMelody(scale)], rnd(2.6, 3.8), vBase * 0.8, bright), rnd(340, 560));
      } else {
        const chTones = chordNotes(root, chordName, reg);
        const fig = Math.random();
        if (fig < 0.46) {
          const n = 2 + (Math.random() < grow * 0.6 ? 1 : 0);
          for (let i = 0; i < n; i++) {
            const note = nextMelody(scale);
            setTimeout(() => alive && strike(NOTE[note], rnd(2, 3.4), vBase * (0.95 - i * 0.05), bright), i * rnd(280, 480));
          }
        } else if (fig < 0.8) {
          const order = (Math.random() < 0.5 ? chTones : [...chTones].reverse()).slice(0, 2 + (grow > 0.6 ? 1 : 0));
          order.forEach((note, i) =>
            setTimeout(() => alive && strike(NOTE[note], rnd(2.2, 3.6), vBase * (0.9 - i * 0.05), bright),
                       i * rnd(180, 340)));
          lastRight = order[order.length - 1];
        } else {
          const base = chTones[(Math.random() * chTones.length) | 0];
          const hi = base.replace(/\d/, d => String(Math.min(5, +d + 1)));
          strike(NOTE[hi] || NOTE[base], rnd(2.8, 4.2), vBase * 0.8, bright);
          lastRight = base;
        }
      }
    }

    // spacious early, a little fuller as it grows
    const space = rnd(1200, 2600) * (1.4 - grow * 0.5) * (1.2 - cur.arousal * 0.3);
    loopTimer = setTimeout(loopStep, clamp(space, 620, 3800));
  }

  // ── public API ─────────────────────────────────────────────────────────
  function begin() {
    if (started) { if (ctx && ctx.state === 'suspended') ctx.resume(); return; }
    started = true;
    try { buildGraph(); } catch (e) { return; }
    alive = true;
    setTimeout(loopStep, 900);
  }

  function setAffect(name, intensity) {
    const m = AFFECT[name] || AFFECT.neutral;
    cur.mood = m;
    cur.key = pick(m.keys);
    cur.scale = pick(m.scales);
    cur.reg = m.reg;
    const k = intensity == null ? 1 : intensity;
    tgt.valence = m.valence;
    tgt.arousal = m.arousal * (0.7 + k * 0.4);
    tgt.density = m.density * (0.7 + k * 0.4);
  }

  // live per-word nudges (kept gentle — flavor, not jitter)
  function setValence(v) { tgt.valence = clamp(cur.mood.valence * 0.6 + v * 0.4, -1, 1); }
  function setArousal(a) { tgt.arousal = clamp(cur.mood.arousal * 0.7 + a * 0.5, 0, 1); }
  function setNoteListener(fn) { noteListener = fn; }
  function setArc(p) { tgtArc = clamp(p, 0, 1); }

  // a deliberate chord bloom under a pivotal line
  function cue(kind) {
    if (!alive) return;
    if (noteListener) { try { noteListener({ strength: 0.32 }); } catch (_) {} }
    const map = {
      pivot: { key: cur.key, chord: 'major7', reg: cur.reg, spread: 200 },
      lift:  { key: 'C',     chord: 'add9',   reg: 5,       spread: 170 },
      core:  { key: cur.key, chord: 'minor9', reg: 4,       spread: 240 },
      rose:  { key: 'C',     chord: 'major9', reg: 5,       spread: 300 },
    };
    const c = map[kind]; if (!c) return;
    const ch = chordNotes(c.key, c.chord, c.reg);
    ch.forEach((note, i) =>
      setTimeout(() => alive && strike(NOTE[note], rnd(4.5, 6.5), 0.20 - i * 0.012, 0.5),
                 i * c.spread));
  }

  // per-keystroke tap — faithful copy of KAIOS's typing sound (useUISound.playTypeAIChar):
  // 432Hz AI-pentatonic sine, pitched by character, occasional fifth + rare warm octave-down.
  const AI_PENTA = [323.63, 384.87, 432.00, 513.74, 576.65]; // E4 G4 A4 C5 D5 @432
  function tickTone(freq, dur, vol, type) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(tickBus);
    o.start(t); o.stop(t + dur);
  }
  function tick(char) {
    if (!ctx || !alive) return;
    if (char === ' ' || char === '\n') return;
    const now = ctx.currentTime;
    if (now - lastTick < 0.028) return;     // light throttle so fast typing never buzzes
    lastTick = now;
    const cc = (char || '').toUpperCase().charCodeAt(0);
    const note = AI_PENTA[(isNaN(cc) ? 0 : cc) % AI_PENTA.length];
    tickTone(note, 0.06, 0.09, 'sine');
    if (Math.random() > 0.8) setTimeout(() => alive && tickTone(note * 1.5, 0.08, 0.045, 'triangle'), 30);
    if (Math.random() > 0.9) setTimeout(() => alive && tickTone(note * 0.5, 0.10, 0.035, 'sine'), 60);
  }

  function settle() {
    // one last warm chord, then let the room go quiet
    if (!alive) return;
    const ch = chordNotes('C', 'major9', 5);
    ch.forEach((note, i) =>
      setTimeout(() => strike(NOTE[note], 7, 0.17 - i * 0.01, 0.45), i * 320));
    alive = false;
    if (loopTimer) clearTimeout(loopTimer);
    if (ctx) {
      master.gain.setTargetAtTime(0.0, ctx.currentTime + 7, 3.5);
      airGain.gain.setTargetAtTime(0.0, ctx.currentTime + 5, 3);
    }
  }

  function stop() {
    alive = false;
    if (loopTimer) clearTimeout(loopTimer);
    if (ctx && master) master.gain.setTargetAtTime(0.0, ctx.currentTime, 0.4);
  }

  function restart() {
    if (!ctx) { begin(); return; }
    if (loopTimer) clearTimeout(loopTimer);
    alive = true;
    lastRight = 'E4'; arc = 0; tgtArc = 0;
    setAffect('neutral', 0.6);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0.22, ctx.currentTime, 1.2);
    airGain.gain.setTargetAtTime(0.05, ctx.currentTime, 1.5);
    setTimeout(loopStep, 700);
  }

  return { begin, setAffect, setValence, setArousal, cue, tick, setNoteListener, setArc, settle, stop, restart };
})();
