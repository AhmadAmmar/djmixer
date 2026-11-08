// Sound analysis with no libraries, so every step can be read and changed. Tested in test_dsp.mjs against known answers.

export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// The twelve swaras counted from Sa, with the just-intonation ratio commonly taught for each.
export const SWARAS = [
  ["Sa", "1:1"], ["re", "16:15"], ["Re", "9:8"], ["ga", "6:5"], ["Ga", "5:4"], ["Ma", "4:3"],
  ["Ma'", "45:32"], ["Pa", "3:2"], ["dha", "8:5"], ["Dha", "5:3"], ["ni", "9:5"], ["Ni", "15:8"],
];
export const SPEED_OF_SOUND = 343; // metres per second in air at about 20 degrees C

// Equal temperament: each semitone multiplies frequency by 2^(1/12), and A4 is 440 Hz.
export function freqToNote(f) {
  const midi = 69 + 12 * Math.log2(f / 440);
  const n = Math.round(midi);
  return { name: NOTES[((n % 12) + 12) % 12], octave: Math.floor(n / 12) - 1, cents: Math.round((midi - n) * 100), midi };
}

export function noteToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

// Where a frequency sits relative to the singer's chosen Sa.
export function toSwara(f, sa) {
  const semis = 12 * Math.log2(f / sa);
  const n = Math.round(semis);
  const [name, ratio] = SWARAS[((n % 12) + 12) % 12];
  return { name, ratio, octave: Math.floor(n / 12), cents: Math.round((semis - n) * 100), semis };
}

// YIN pitch detection (de Cheveigne and Kawahara, 2002): find the lag at which the wave best matches itself.
export function yin(buf, sampleRate, fmin = 70, fmax = 1200, threshold = 0.15) {
  const maxLag = Math.min(Math.floor(sampleRate / fmin), Math.floor(buf.length / 2));
  const minLag = Math.floor(sampleRate / fmax);
  const n = buf.length - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const x = buf[i] - buf[i + lag];
      s += x * x;
    }
    d[lag] = s;
  }
  let run = 0;
  let best = -1;
  const cmnd = new Float32Array(maxLag + 1).fill(1);
  for (let lag = 1; lag <= maxLag; lag++) {
    run += d[lag];
    cmnd[lag] = run > 0 ? (d[lag] * lag) / run : 1;
  }
  for (let lag = minLag; lag < maxLag; lag++) {
    if (cmnd[lag] < threshold) {
      while (lag + 1 < maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) return { freq: 0, clarity: 0 };
  const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return { freq: sampleRate / (best + shift), clarity: 1 - b };
}

export function fftMag(re) {
  const n = re.length;
  const im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

const hann = (n) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

// Average many channels to one, and keep every step-th sample after a simple averaging filter.
export function downmix(channels, step) {
  const len = Math.floor(channels[0].length / step);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const c of channels) for (let k = 0; k < step; k++) s += c[i * step + k];
    out[i] = s / (channels.length * step);
  }
  return out;
}

// Onset strength: how much new energy appears in each short frame, measured as positive change across frequencies.
export function onsetEnvelope(x, sr, size = 1024, hop = 256) {
  const w = hann(size);
  const frames = Math.max(0, Math.floor((x.length - size) / hop));
  const env = new Float32Array(frames);
  let prev = new Float32Array(size / 2);
  for (let f = 0; f < frames; f++) {
    const b = new Float32Array(size);
    for (let i = 0; i < size; i++) b[i] = x[f * hop + i] * w[i];
    const m = fftMag(b).map((v) => Math.log1p(v * 10));
    let s = 0;
    for (let i = 0; i < m.length; i++) s += Math.max(0, m[i] - prev[i]);
    env[f] = s;
    prev = m;
  }
  return { env, rate: sr / hop };
}

// Tempo: music repeats, so the onset curve lines up with itself one beat later. Autocorrelation finds that gap.
export function estimateTempo(x, sr, lo = 70, hi = 180) {
  const { env, rate } = onsetEnvelope(x, sr);
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const e = env.map((v) => v - mean);
  let best = 0, bestLag = 0;
  const minLag = Math.floor((60 * rate) / hi), maxLag = Math.ceil((60 * rate) / lo);
  const ac = (lag) => { let s = 0; for (let i = 0; i + lag < e.length; i++) s += e[i] * e[i + lag]; return s; };
  for (let lag = minLag; lag <= maxLag && lag < e.length; lag++) {
    // A gentle preference for moderate tempi, as listeners tend to feel the beat near 120 BPM.
    const bpmHere = (60 * rate) / lag;
    const s = ac(lag) * Math.exp(-0.5 * (Math.log2(bpmHere / 120) / 1.0) ** 2);
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 0, firstBeat: 0 };
  // The true beat gap usually falls between two frames (at 43 frames a second, one frame near 130 BPM is 7 BPM).
  // So score fractional gaps too, reading the curve between frames by straight-line interpolation, and compare the
  // curve with itself 4 beats later, where a small error in the gap has grown fourfold and is easier to see.
  const acf = (L) => {
    let s = 0;
    for (let i = 0; i + L + 1 < e.length; i++) { const j = i + L, j0 = Math.floor(j), f = j - j0; s += e[i] * (e[j0] * (1 - f) + e[j0 + 1] * f); }
    return s;
  };
  let lagF = bestLag, top4 = -Infinity;
  for (let L = bestLag - 1; L <= bestLag + 1; L += 0.01) {
    const v = acf(4 * L);
    if (v > top4) { top4 = v; lagF = L; }
  }
  const period = bestLag;
  let bestPhase = 0, top = -Infinity;
  for (let p = 0; p < period; p++) {
    let s = 0;
    for (let i = p; i < env.length; i += period) s += env[Math.round(i)];
    if (s > top) { top = s; bestPhase = p; }
  }
  return { bpm: (60 * rate) / lagF, firstBeat: bestPhase / rate };
}

// Key: compare how much of each of the 12 notes is present with the Krumhansl-Kessler profiles of major and minor.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export function chroma(x, sr, size = 8192, hop = 4096) {
  const c = new Float32Array(12);
  const w = hann(size);
  for (let s = 0; s + size <= x.length; s += hop) {
    const b = new Float32Array(size);
    for (let i = 0; i < size; i++) b[i] = x[s + i] * w[i];
    const m = fftMag(b);
    for (let k = 1; k < m.length; k++) {
      const f = (k * sr) / size;
      if (f < 55 || f > 2000) continue;
      const n = Math.round(69 + 12 * Math.log2(f / 440));
      c[((n % 12) + 12) % 12] += m[k] * m[k];
    }
  }
  return c;
}

function correlation(a, b) {
  const ma = a.reduce((p, v) => p + v, 0) / 12, mb = b.reduce((p, v) => p + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
}

export function estimateKey(x, sr) {
  const c = chroma(x, sr);
  let best = { score: -2 };
  for (let root = 0; root < 12; root++) {
    const rotated = Array.from({ length: 12 }, (_, i) => c[(i + root) % 12]);
    for (const [mode, profile, wheel] of [["major", MAJOR, CAMELOT_MAJOR], ["minor", MINOR, CAMELOT_MINOR]]) {
      const score = correlation(rotated, profile);
      if (score > best.score) best = { score, root, mode, name: `${NOTES[root]} ${mode}`, camelot: wheel[root] };
    }
  }
  return best;
}

// Keys next to each other on the Camelot wheel share most of their notes, so they tend to sound good together.
export function keyRelation(a, b) {
  const parse = (k) => [parseInt(k), k.slice(-1)];
  const [na, la] = parse(a), [nb, lb] = parse(b);
  const gap = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (gap === 0 && la === lb) return "same key";
  if (gap === 0) return "relative major and minor: same notes";
  if (gap === 1 && la === lb) return "neighbours: they differ by one note";
  return `${gap} steps apart on the wheel: expect clashes if both melodies play together`;
}

// Playing a recording faster raises its pitch too, like a record: 12 semitones is double speed.
export const rateToSemitones = (rate) => 12 * Math.log2(rate);

// A short made-up track, so the app can be tried without any music files. The answers are known, which also makes it a test.
export function makeDemo(bpm, rootMidi, minor, seconds, sr = 44100) {
  const out = new Float32Array(Math.floor(seconds * sr));
  const beat = (60 / bpm) * sr;
  const scale = minor ? [0, 3, 7, 10, 12, 7, 3, 2] : [0, 4, 7, 11, 12, 7, 4, 2];
  for (let b = 0; b * beat < out.length; b++) {
    const start = Math.floor(b * beat);
    for (let i = 0; i < 0.18 * sr && start + i < out.length; i++) {
      const t = i / sr;
      out[start + i] += 0.8 * Math.exp(-t * 28) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 40)) * t);
    }
    const f = noteToFreq(rootMidi + scale[b % scale.length]);
    const bass = noteToFreq(rootMidi - 12 + (b % 8 < 4 ? 0 : 7));
    for (let i = 0; i < beat * 0.9 && start + i < out.length; i++) {
      const t = i / sr;
      const fade = Math.exp(-t * 3);
      out[start + i] += 0.22 * fade * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.15 * Math.sin(6 * Math.PI * f * t));
      out[start + i] += 0.14 * fade * Math.sin(2 * Math.PI * bass * t);
    }
  }
  return out;
}

// One line of a CSV file, with quoted fields.
export function csvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Accepts M3U, or CSV with Track Name and Artist columns such as Exportify writes, or one title per line.
export function parsePlaylist(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith("#EXTM3U")) {
    return lines.filter((l) => l.startsWith("#EXTINF")).map((l) => ({ title: l.split(",").slice(1).join(",").trim() }));
  }
  const head = csvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const t = head.findIndex((h) => h.includes("track name") || h === "title" || h === "name");
  if (t >= 0) {
    const a = head.findIndex((h) => h.includes("artist"));
    return lines.slice(1).map((l) => { const c = csvLine(l); return { title: a >= 0 ? `${c[a]} - ${c[t]}` : c[t] }; });
  }
  return lines.map((title) => ({ title }));
}

export const toM3U = (items) => "#EXTM3U\n" + items.map((i) => `#EXTINF:-1,${i.title}\n${i.file ?? i.title}`).join("\n") + "\n";

// ---------------------------------------------------------------- whole-track analysis
// Loudness in decibels relative to full scale (dBFS): 0 dB is the loudest a file can hold.
export const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));

// Brightness: the spectral centroid, the "centre of mass" of the spectrum in Hz. Higher means a brighter, thinner sound.
export function spectralCentroid(x, sr, size = 4096) {
  const w = hann(size);
  let num = 0, den = 0;
  for (let s = 0; s + size <= x.length; s += size * 4) {
    const b = new Float32Array(size);
    for (let i = 0; i < size; i++) b[i] = x[s + i] * w[i];
    const m = fftMag(b);
    for (let k = 1; k < m.length; k++) { num += ((k * sr) / size) * m[k]; den += m[k]; }
  }
  return den ? num / den : 0;
}

// Energy in each second: how loud the track is over time. Used to find intros, drops, breaks and outros.
export function energyCurve(x, sr, step = 1) {
  const n = Math.floor(x.length / (sr * step));
  return Float32Array.from({ length: n }, (_, i) => {
    let s = 0;
    const a = Math.floor(i * sr * step), b = Math.floor((i + 1) * sr * step);
    for (let k = a; k < b; k++) s += x[k] * x[k];
    return Math.sqrt(s / (b - a));
  });
}

// Sections: places where the loudness changes a lot, snapped to the nearest 8-bar boundary (a typical phrase).
export function sections(energy, bpm, firstBeat) {
  if (!bpm) return [];
  const bar = (4 * 60) / bpm, phrase = 8 * bar;
  const out = [];
  for (let t = firstBeat; t < energy.length; t += phrase) {
    const a = Math.floor(t), b = Math.min(energy.length, Math.floor(t + phrase));
    let s = 0;
    for (let i = a; i < b; i++) s += energy[i];
    out.push({ start: +t.toFixed(2), level: b > a ? s / (b - a) : 0 });
  }
  const peak = Math.max(...out.map((o) => o.level), 1e-9);
  return out.map((o) => ({ ...o, level: +(o.level / peak).toFixed(2), label: o.level / peak > 0.8 ? "full" : o.level / peak > 0.5 ? "medium" : "quiet" }));
}

// Everything the app measures about one track, from a mono signal at sample rate sr.
export function analyseTrack(x, sr) {
  const tempo = estimateTempo(x, sr);
  const key = estimateKey(x, sr);
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { sum += x[i] * x[i]; peak = Math.max(peak, Math.abs(x[i])); }
  const rms = Math.sqrt(sum / x.length);
  const energy = energyCurve(x, sr);
  const secs = sections(energy, tempo.bpm, tempo.firstBeat);
  const c = chroma(x, sr), cmax = Math.max(...c);
  const firstFull = secs.find((s) => s.level > 0.5), lastFull = [...secs].reverse().find((s) => s.level > 0.5);
  const bar = tempo.bpm ? 240 / tempo.bpm : 0;
  return {
    bpm: +tempo.bpm.toFixed(2), firstBeat: +tempo.firstBeat.toFixed(3), key: key.name, camelot: key.camelot, keyScore: +key.score.toFixed(2),
    rmsDb: +toDb(rms).toFixed(1), peakDb: +toDb(peak).toFixed(1), crestDb: +(toDb(peak) - toDb(rms)).toFixed(1),
    brightnessHz: Math.round(spectralCentroid(x, sr)),
    introBars: firstFull && bar ? Math.round((firstFull.start - tempo.firstBeat) / bar) : 0,
    outroBars: lastFull && bar ? Math.max(0, Math.round((x.length / sr - (lastFull.start + 8 * bar)) / bar)) : 0,
    chroma: Array.from(c, (v) => v / (cmax || 1)), sections: secs, energy: Array.from(energy, (v) => +v.toFixed(4)),
    hooks: findHooks(x, sr, tempo.bpm, tempo.firstBeat),
  };
}

// ---------------------------------------------------------------- hooks
// A hook is the catchy phrase a song keeps returning to: in film and pop songs usually the chorus (the mukhda in
// Hindi and Urdu songs). Two clues find it. It REPEATS: the same chords and melody come back, so its notes (chroma)
// bar by bar match another stretch of the song. And it is LOUD: choruses are fuller than verses.
// Method: average the chroma of every bar, compare every 8-bar stretch with every other one that does not overlap
// (mean cosine similarity of the bars), and score each stretch by how well it is repeated times how loud it is.
export function chromaFrames(x, sr, size = 4096, hop = 2048) {
  const w = hann(size), out = [];
  for (let s = 0; s + size <= x.length; s += hop) {
    const b = new Float32Array(size);
    for (let i = 0; i < size; i++) b[i] = x[s + i] * w[i];
    const m = fftMag(b), c = new Float32Array(12);
    for (let k = 1; k < m.length; k++) {
      const f = (k * sr) / size;
      if (f < 80 || f > 2000) continue;
      const n = Math.round(69 + 12 * Math.log2(f / 440));
      c[((n % 12) + 12) % 12] += m[k] * m[k];
    }
    out.push(c);
  }
  return { frames: out, rate: sr / hop };
}

export function findHooks(x, sr, bpm, firstBeat, bars = 8, keep = 3) {
  if (!bpm) return [];
  const { frames, rate } = chromaFrames(x, sr);
  const barSec = 240 / bpm, nBars = Math.floor((x.length / sr - firstBeat) / barSec);
  const barChroma = [], barEnergy = [];
  for (let b = 0; b < nBars; b++) {
    const f0 = Math.floor((firstBeat + b * barSec) * rate), f1 = Math.floor((firstBeat + (b + 1) * barSec) * rate);
    const c = new Float32Array(12);
    let e = 0;
    for (let f = f0; f < f1 && f < frames.length; f++) for (let i = 0; i < 12; i++) { c[i] += frames[f][i]; e += frames[f][i]; }
    const norm = Math.hypot(...c) || 1;
    barChroma.push(c.map((v) => v / norm)); barEnergy.push(e);
  }
  const eMax = Math.max(...barEnergy, 1e-9);
  const cos = (p, q) => { let s = 0; for (let i = 0; i < 12; i++) s += barChroma[p][i] * barChroma[q][i]; return s; };
  const segSim = (s, t) => { let v = 0; for (let k = 0; k < bars; k++) v += cos(s + k, t + k); return v / bars; };
  const cands = [];
  for (let s = 0; s + bars <= nBars; s++) {
    let best = 0, repeats = [];
    for (let t = 0; t + bars <= nBars; t++) {
      if (Math.abs(t - s) < bars) continue;
      const v = segSim(s, t);
      if (v > best) best = v;
      if (v > 0.9) repeats.push(t);
    }
    let e = 0;
    for (let k = 0; k < bars; k++) e += barEnergy[s + k];
    const loud = e / bars / eMax;
    cands.push({ bar: s, similarity: best, loud, score: best * best * (0.4 + loud) * (1 + 0.15 * Math.min(repeats.length, 4)), repeats });
  }
  cands.sort((p, q) => q.score - p.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.every((h) => Math.abs(h.bar - c.bar) >= bars)) chosen.push(c);
    if (chosen.length === keep) break;
  }
  return chosen.map((c, i) => ({
    rank: i + 1, source: "found",
    start: +(firstBeat + c.bar * barSec).toFixed(2), bars, seconds: +(bars * barSec).toFixed(2),
    similarity: +c.similarity.toFixed(2), loudness: +c.loud.toFixed(2), repeatsAt: c.repeats.slice(0, 6).map((t) => +(firstBeat + t * barSec).toFixed(1)),
  })).sort((p, q) => p.start - q.start);
}
