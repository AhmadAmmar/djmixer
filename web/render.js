// Rendering a planned set to audio, faster than real time, with the browser's OfflineAudioContext.
// Each track runs through its own chain: speed -> low EQ -> low-pass -> high-pass -> volume -> (echo) -> master.
// The automation points of each transition (mix.js PRESETS) become scheduled parameter changes.
import { encodeWav } from "./mix.js";

// Loudness matching: every track is trimmed to the same average level (RMS), so the next song does not seem
// better, or worse, just because it was mastered louder. -14 dB RMS is a comfortable level for pop and dance masters.
export const TARGET_RMS_DB = -14;
export const trimDb = (rmsDb) => Math.max(-12, Math.min(12, TARGET_RMS_DB - rmsDb));

export async function renderSet(items, transitions, onProgress = () => {}) {
  // items: [{ buffer, bpm, firstBeat }], transitions: plans from planTransition, one fewer than items.
  const sr = 44100;
  const timeline = [];
  let start = 0;
  items.forEach((it, i) => {
    const offset = i === 0 ? 0 : transitions[i - 1].bInAt;
    // bRate matches B to A's original tempo; if A itself was sped up, B must follow A's played tempo.
    const rate = i === 0 ? 1 : transitions[i - 1].bRate * timeline[i - 1].rate;
    const entry = { ...it, start, offset, rate };
    timeline.push(entry);
    if (i < transitions.length) {
      const tr = transitions[i];
      const playedBar = 240 / (it.bpm * entry.rate);
      entry.mixAt = start + (tr.aOutAt - offset) / entry.rate;
      entry.end = entry.mixAt + tr.bars * playedBar;
      start = entry.mixAt;
    } else {
      entry.end = start + (it.buffer.duration - offset) / entry.rate;
    }
  });
  const total = timeline[timeline.length - 1].end + 1;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
  const limiter = ctx.createDynamicsCompressor();           // keeps the sum of two tracks from clipping
  limiter.threshold.value = -3; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  timeline.forEach((t, i) => {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer; src.playbackRate.value = t.rate;
    const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 250;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 20000; lp.Q.value = 6;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 10; hp.Q.value = 0.7;
    const gain = ctx.createGain(), trim = ctx.createGain();
    trim.gain.value = 10 ** (trimDb(t.rmsDb ?? TARGET_RMS_DB) / 20);
    src.connect(trim).connect(low).connect(lp).connect(hp).connect(gain).connect(limiter);
    const echo = ctx.createDelay(2), fb = ctx.createGain(), send = ctx.createGain();
    echo.delayTime.value = 0.75 * 60 / (t.bpm * t.rate); fb.gain.value = 0; send.gain.value = 0;
    gain.connect(send).connect(echo).connect(fb).connect(echo); echo.connect(limiter);
    // incoming side of the previous transition, outgoing side of the next one
    const inT = i > 0 ? transitions[i - 1] : null, outT = i < transitions.length ? transitions[i] : null;
    gain.gain.setValueAtTime(inT ? 0 : 1, 0);
    const apply = (tr, side, t0, barSec) => {
      tr.automation.forEach((p) => {
        const at = t0 + p.at * barSec;
        const g = side === "a" ? p.aGain : p.bGain;
        if (g !== undefined) gain.gain.linearRampToValueAtTime(g, at);
        const lo = side === "a" ? p.aLow : p.bLow;
        if (lo !== undefined) low.gain.setValueAtTime(lo, at);
        if (side === "a" && p.aCut !== undefined) lp.frequency.exponentialRampToValueAtTime(p.aCut, at);
        if (side === "b" && p.bHigh !== undefined) hp.frequency.exponentialRampToValueAtTime(p.bHigh, at);
        if (side === "a" && p.aEcho !== undefined) { send.gain.setValueAtTime(1, at); fb.gain.setValueAtTime(p.aEcho, at); }
      });
    };
    if (inT) {
      const prev = timeline[i - 1];
      apply(inT, "b", prev.mixAt, 240 / (prev.bpm * prev.rate));
      const first = inT.automation[0];
      if (first.bLow !== undefined) low.gain.setValueAtTime(first.bLow, 0);
      if (first.bHigh !== undefined) hp.frequency.setValueAtTime(first.bHigh, 0);
    }
    if (outT) apply(outT, "a", t.mixAt, 240 / (t.bpm * t.rate));
    src.start(i === 0 ? 0 : t.start, t.offset);
    src.stop(t.end + (outT && outT.preset === "echo-out" ? 0 : 0.05));
  });
  onProgress(0.1);
  const out = await ctx.startRendering();
  onProgress(1);
  return { buffer: out, timeline: timeline.map((t) => ({ file: t.file, start: +t.start.toFixed(3), offset: t.offset, rate: +t.rate.toFixed(4), trimDb: +trimDb(t.rmsDb ?? TARGET_RMS_DB).toFixed(1), mixAt: t.mixAt && +t.mixAt.toFixed(3), end: +t.end.toFixed(3) })) };
}

export const wavBlob = (buffer) =>
  new Blob([encodeWav([buffer.getChannelData(0), buffer.getChannelData(1)], buffer.sampleRate)], { type: "audio/wav" });

// MP3 with LAME (lamejs, LGPL), an open-source MP3 encoder compiled to JavaScript. 192 kbit/s by default.
export async function mp3Blob(buffer, kbps = 192, onProgress = () => {}) {
  const lame = window.lamejs;
  const enc = new lame.Mp3Encoder(2, buffer.sampleRate, kbps);
  const toInt = (f) => Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, v * 32767)));
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  const parts = [], block = 1152 * 64;
  for (let i = 0; i < L.length; i += block) {
    const m = enc.encodeBuffer(toInt(L.subarray(i, i + block)), toInt(R.subarray(i, i + block)));
    if (m.length) parts.push(new Uint8Array(m));
    if ((i / block) % 20 === 0) { onProgress(i / L.length); await new Promise((r) => setTimeout(r)); }
  }
  parts.push(new Uint8Array(enc.flush()));
  return new Blob(parts, { type: "audio/mpeg" });
}

export async function sha256(arrayBuffer) {
  const h = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
