// Planning a set: the rules a DJ follows, written as functions so they can be read, tested and changed.
// Nothing here touches the browser, so the same code runs in the app, on a phone and in Node tests (test_mix.mjs).

// ---------------------------------------------------------------- tempo
// Playing a track faster by a factor r raises its pitch by 12 log2(r) semitones (as a record sped up).
export const semitones = (r) => 12 * Math.log2(r);

// Two tempos can also meet at half or double time: 70 BPM played against 140 BPM lines up every other beat.
// Return the stretch for track b that needs the smallest change, and which multiple it uses.
export function tempoMatch(bpmA, bpmB) {
  const options = [1, 2, 0.5].map((m) => ({ multiple: m, rate: (bpmA * m) / bpmB }));
  options.forEach((o) => (o.change = Math.abs(o.rate - 1)));
  return options.sort((p, q) => p.change - q.change)[0];
}

// ---------------------------------------------------------------- key
// The Camelot wheel: 12 hours, A for minor and B for major. One step clockwise is a fifth up (7 semitones).
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]; // index = root note C=0
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export function camelotToRoot(code) {
  const major = code.endsWith("B");
  return { root: (major ? CAMELOT_MAJOR : CAMELOT_MINOR).indexOf(code), major };
}

// Changing speed moves the key: shift the root by the rounded number of semitones, and read the new Camelot code.
export function shiftedKey(code, semis) {
  const { root, major } = camelotToRoot(code);
  const r = (((root + Math.round(semis)) % 12) + 12) % 12;
  return (major ? CAMELOT_MAJOR : CAMELOT_MINOR)[r];
}

// How well two keys go together, as a score from 0 (clash) to 1 (same key), with the reason in words.
export function keyFit(a, b) {
  const [na, la] = [parseInt(a), a.slice(-1)], [nb, lb] = [parseInt(b), b.slice(-1)];
  const gap = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (gap === 0 && la === lb) return { score: 1, why: "same key" };
  if (gap === 0) return { score: 0.9, why: "relative major and minor: the same seven notes" };
  if (gap === 1 && la === lb) return { score: 0.8, why: "neighbours on the wheel: six of seven notes shared" };
  if (gap === 1) return { score: 0.6, why: "a diagonal move (one step and a change between major and minor): most notes shared, a change of mood" };
  if (gap === 2 && la === lb) return { score: 0.5, why: "two steps: five notes shared, an energy lift" };
  return { score: Math.max(0, 0.4 - 0.1 * gap), why: `${gap} step${gap === 1 ? "" : "s"} apart: melodies will clash, so mix on drums or after the vocals end` };
}

// ---------------------------------------------------------------- presets
// Each preset is a recipe from a style of DJing, with its rule of thumb written out.
export const PRESETS = {
  "house-eq-swap": {
    name: "House and EDM: long blend with a bass swap", bars: 16, stretchLimit: 0.08,
    rule: "Tempos are steady and made by machines, so beats can be locked exactly. Blend over 16 bars; bring the new track in with its bass cut, and swap the bass halfway, on a phrase boundary, because two basslines together sound muddy.",
    automation: (bars) => [
      { at: 0, aGain: 1, bGain: 0, aLow: 0, bLow: -26 },
      { at: bars / 2 - 0.01, aGain: 1, bGain: 0.85, aLow: 0, bLow: -26 },
      { at: bars / 2, aGain: 0.85, bGain: 1, aLow: -26, bLow: 0 },
      { at: bars, aGain: 0, bGain: 1, aLow: -26, bLow: 0 },
    ],
  },
  "radio-pop": {
    name: "English pop and radio: short crossfade at a phrase end", bars: 4, stretchLimit: 0.04,
    rule: "Songs are built around vocals and verses. Keep the overlap short so two singers do not talk over each other, and change on the last bar of a phrase, where the listener expects something new.",
    automation: (bars) => [{ at: 0, aGain: 1, bGain: 0 }, { at: bars, aGain: 0, bGain: 1 }],
  },
  "bollywood-cut": {
    name: "Bollywood and desi: cut on the sam", bars: 1, stretchLimit: 0.05,
    rule: "Film songs are often played by live musicians, so tempo drifts, and vocals carry the song; large time-stretching makes voices sound wrong. So keep any stretch small and change cleanly on beat one of a phrase, the sam (where a tabla or dhol cycle lands), often after a drum fill or a shout.",
    automation: (bars) => [{ at: 0, aGain: 1, bGain: 0 }, { at: bars * 0.25, aGain: 0, bGain: 1 }],
  },
  "acid-filter": {
    name: "Acid and techno: filter sweep", bars: 16, stretchLimit: 0.08,
    rule: "Acid house grew from the squelch of a resonant low-pass filter. Sweep the outgoing track's filter down so it fades into a muffled throb while the new track rises from thin to full.",
    automation: (bars) => [
      { at: 0, aGain: 1, bGain: 0.7, aCut: 18000, bHigh: 1500 },
      { at: bars * 0.75, aGain: 0.9, bGain: 0.9, aCut: 400, bHigh: 40 },
      { at: bars, aGain: 0, bGain: 1, aCut: 200, bHigh: 20 },
    ],
  },
  "echo-out": {
    name: "Any style: echo out", bars: 2, stretchLimit: 0,
    rule: "When tempos or keys are too far apart to blend, do not blend: let the old track end in an echo, and start the new one cleanly on its own downbeat.",
    automation: (bars) => [{ at: 0, aGain: 1, bGain: 0, aEcho: 0.6 }, { at: bars, aGain: 0, bGain: 1, aEcho: 0.6 }],
  },
};

// Pick a preset from the measurements when the user chooses "auto".
export function suggestPreset(a, b) {
  const t = tempoMatch(a.bpm, b.bpm);
  const k = keyFit(shiftedKey(b.camelot, semitones(t.rate)), a.camelot);
  if (t.change > 0.08) return { id: "echo-out", why: `tempos ${a.bpm.toFixed(0)} and ${b.bpm.toFixed(0)} BPM are ${(100 * t.change).toFixed(0)}% apart even at half or double time` };
  if (t.change > 0.04) return { id: "bollywood-cut", why: `a ${(100 * t.change).toFixed(1)}% stretch would be audible on vocals, so cut cleanly on a downbeat` };
  if (k.score < 0.5) return { id: "radio-pop", why: `keys clash (${k.why}), so keep the overlap short` };
  return { id: "house-eq-swap", why: `tempos within ${(100 * t.change).toFixed(1)}% and the keys fit, so a long blend works` };
}

// ---------------------------------------------------------------- one transition
// Where to leave A: the start of its last full phrase before the outro. Where to enter B: its first downbeat after the intro starts.
export function planTransition(a, b, presetId = "auto") {
  const auto = presetId === "auto" ? suggestPreset(a, b) : null;
  const id = auto ? auto.id : presetId;
  const p = PRESETS[id];
  let t = tempoMatch(a.bpm, b.bpm);
  const stretched = t.change <= p.stretchLimit;
  const rate = stretched ? t.rate : 1;
  const barA = 240 / a.bpm;
  const mixBars = p.bars;
  const outroStart = Math.max(a.firstBeat, a.duration - (Math.max(a.outroBars, 0) + mixBars) * barA);
  const aOut = a.firstBeat + Math.floor((outroStart - a.firstBeat) / (8 * barA)) * 8 * barA; // snap to an 8-bar phrase
  const newKey = shiftedKey(b.camelot, semitones(rate));
  return {
    preset: id, presetName: p.name, rule: p.rule, why: auto ? auto.why : "chosen by hand",
    bRate: +rate.toFixed(4), multiple: t.multiple, stretchPct: +(100 * (rate - 1)).toFixed(2),
    pitchShift: +semitones(rate).toFixed(2), bKeyAfter: newKey, keyFit: keyFit(newKey, a.camelot),
    aOutAt: +aOut.toFixed(3), bInAt: +b.firstBeat.toFixed(3), bars: mixBars, seconds: +(mixBars * barA).toFixed(3),
    automation: p.automation(mixBars),
  };
}

// ---------------------------------------------------------------- the order of a set
// Greedy ordering: start from the calmest track, then always go to the unplayed track that is easiest to mix into,
// scoring tempo closeness, key fit and a gentle rise in energy (loudness) as the set goes on.
export function orderSet(tracks, start = null) {
  if (tracks.length < 3) return [...tracks].sort((p, q) => p.rmsDb - q.rmsDb);
  const left = [...tracks];
  let cur = start ?? left.sort((p, q) => p.rmsDb - q.rmsDb)[0];
  const out = [cur];
  left.splice(left.indexOf(cur), 1);
  while (left.length) {
    const score = (n) => {
      const t = tempoMatch(cur.bpm, n.bpm);
      const k = keyFit(shiftedKey(n.camelot, semitones(t.rate)), cur.camelot);
      return (1 - Math.min(t.change / 0.1, 1)) + k.score + (n.rmsDb >= cur.rmsDb ? 0.3 : 0);
    };
    left.sort((p, q) => score(q) - score(p));
    cur = left.shift();
    out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- export
// A WAV file is a 44-byte header and then the samples as 16-bit whole numbers, channel by channel interleaved.
export function encodeWav(channels, sampleRate) {
  const n = channels[0].length, c = channels.length;
  const buf = new ArrayBuffer(44 + n * c * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * c * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, c, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * c * 2, true); v.setUint16(32, c * 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * c * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let ch = 0; ch < c; ch++) {
    const s = Math.max(-1, Math.min(1, channels[ch][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return buf;
}

// The set file: everything needed to make the same mix again, and a fingerprint of each audio file to check it is the same one.
export function setFile(tracks, transitions, appVersion) {
  return {
    format: "mix-and-learn-set", version: 1, app: appVersion, created: new Date().toISOString(),
    tracks: tracks.map((t) => ({ file: t.file, sha256: t.sha256, duration: t.duration, bpm: t.bpm, firstBeat: t.firstBeat, camelot: t.camelot, key: t.key, rmsDb: t.rmsDb, outroBars: t.outroBars })),
    transitions,
  };
}
