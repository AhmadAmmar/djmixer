// A short video of a mix for Instagram (Stories 9:16, feed 4:5 or square 1:1), 60, 90 or 180 seconds long.
// 1. Choose the tracks and how much of each fits the length: a hook medley, each hook 16, 8 or 4 bars.
// 2. Render that audio with the same engine as the Set builder.
// 3. Play it once while drawing every frame on a canvas (waveform, what is playing, what comes next, spectrum,
//    progress), and record canvas and sound together with the browser's MediaRecorder: MP4 (H.264 and AAC) where
//    the browser supports it, otherwise WebM. Recording happens in real time, so a 60-second clip takes a minute.
import { chosenHook, planHookMedley } from "./mix.js";
import { renderSet } from "./render.js";

export const FORMATS = { story: [1080, 1920, "Story or Reel, 9:16"], feed: [1080, 1350, "Feed portrait, 4:5"], square: [1080, 1080, "Feed square, 1:1"] };
const COLOURS = ["#4cc9e0", "#f2a65a", "#a78bfa", "#6ee7b7", "#f472b6", "#facc15", "#60a5fa", "#fb7185"];

// "Artist - Title (SITE).mp3" -> { artist, title }
export function nameParts(file) {
  const base = file.replace(/\.[^.]+$/, "").replace(/\s*\((SPOTISAVER|[A-Z0-9 ]{6,})\)\s*$/, "").trim();
  const i = base.indexOf(" - ");
  return i > 0 ? { artist: base.slice(0, i), title: base.slice(i + 3) } : { artist: "", title: base };
}

// How many tracks and how many bars of each fit in `seconds`: as many tracks as possible, hooks of 8 bars or more
// if they fit, otherwise 4; the result never runs over the chosen length.
export function fitClip(tracks, seconds) {
  for (const bars of [16, 8, 4]) {
    for (let k = tracks.length; k >= 2; k--) {
      const use = tracks.slice(0, k);
      const total = use.reduce((s, t) => s + (bars * 240) / t.bpm, 0);
      if (total <= seconds && (bars >= 8 || k === tracks.length || total >= 0.6 * seconds)) return { use, bars, total };
    }
  }
  const one = tracks.slice(0, 2);
  return { use: one, bars: 4, total: one.reduce((s, t) => s + 960 / t.bpm, 0) };
}

export async function exportClip({ tracks, seconds, format, title, ctx, onStatus, monitor }) {
  const [W, H] = FORMATS[format];
  const { use, bars } = fitClip(tracks, seconds);
  // each track plays `bars` bars from the start of its chosen hook
  const clip = use.map((t) => {
    const h = chosenHook(t) || { start: t.firstBeat };
    const len = (bars * 240) / t.bpm;
    return { ...t, hooks: [{ rank: 1, start: h.start, seconds: Math.min(len, t.duration - h.start) }], hookStart: h.start };
  });
  const plans = planHookMedley(clip);
  onStatus(`Rendering ${clip.length} hooks of ${bars} bars...`);
  const items = clip.map((t, i) => ({ buffer: t.buffer, bpm: t.bpm, firstBeat: t.firstBeat, file: t.file, rmsDb: t.rmsDb,
    startAt: i === 0 ? t.hooks[0].start : 0, stopAt: i === clip.length - 1 ? t.hooks[0].start + t.hooks[0].seconds : 0 }));
  const { buffer, timeline } = await renderSet(items, plans);
  const dur = timeline[timeline.length - 1].end;
  // the parts as they are heard: from when each starts until the next takes over
  const parts = timeline.map((tl, i) => ({ ...tl, t: clip[i], plan: plans[i] || null, colour: COLOURS[i % COLOURS.length],
    from: tl.start + (i === 0 ? 0 : 0), to: i < timeline.length - 1 ? timeline[i + 1].start : dur }));
  const peaks = (() => {
    const n = 3000, ch = buffer.getChannelData(0), step = Math.floor(ch.length / n) || 1, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let k = 0; k < step; k += 16) m = Math.max(m, Math.abs(ch[i * step + k] || 0)); out[i] = m; }
    const top = Math.max(...out, 1e-9); return out.map((v) => v / top);
  })();

  // canvas, audio and recorder
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  const audio = ctx();
  const src = audio.createBufferSource(); src.buffer = buffer;
  const analyser = audio.createAnalyser(); analyser.fftSize = 2048;
  const dest = audio.createMediaStreamDestination();
  src.connect(analyser); analyser.connect(dest);
  if (monitor) analyser.connect(audio.destination);
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  rec.start(1000);
  const t0 = audio.currentTime + 0.2;
  src.start(t0);

  const S = W / 1080, fontFamily = "system-ui, Segoe UI, Arial, sans-serif";
  const font = (px, w = 400) => (g.font = `${w} ${Math.round(px * S)}px ${fontFamily}`);
  const mmss = (s) => { const r = Math.max(0, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`; };
  const wrap = (text, x, y, maxW, lh) => {
    const words = text.split(" "); let line = "", yy = y;
    for (const w of words) { const t = line ? line + " " + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = t; }
    g.fillText(line, x, yy); return yy + lh;
  };
  const freq = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    const now = Math.max(0, audio.currentTime - t0);
    const i = Math.max(0, parts.findIndex((p) => now >= p.from && now < p.to));
    const p = parts[i] || parts[parts.length - 1];
    const { artist, title: song } = nameParts(p.t.file);
    // background
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0d1117"); bg.addColorStop(1, "#1b1530");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const pad = 70 * S;
    let y = H * (format === "story" ? 0.1 : 0.07);
    g.fillStyle = "#9aa6b2"; font(30, 600); g.fillText((title || "Mix").toUpperCase(), pad, y);
    font(26); g.fillText(`Hook to hook | ${parts.length} tracks | ${mmss(dur)}`, pad, y + 40 * S);
    // now playing
    y += 130 * S;
    g.fillStyle = p.colour; font(30, 700); g.fillText(`NOW ${i + 1}/${parts.length}`, pad, y);
    g.fillStyle = "#ffffff"; font(64, 800); y = wrap(song, pad, y + 75 * S, W - 2 * pad, 72 * S);
    g.fillStyle = "#c8d0d8"; font(38); y = wrap(artist, pad, y - 10 * S, W - 2 * pad, 46 * S);
    const rate = p.rate;
    const facts = [`${(p.t.bpm * rate).toFixed(0)} BPM`, `${p.t.key} (${p.t.camelot})`, rate !== 1 ? `speed ${rate > 1 ? "+" : ""}${(100 * (rate - 1)).toFixed(1)}%` : "original speed", `hook ${mmss(p.t.hooks[0].start)} in the song`];
    font(30, 600); let x = pad; y += 20 * S;
    for (const f of facts) {
      const w = g.measureText(f).width + 36 * S;
      if (x + w > W - pad) { x = pad; y += 62 * S; }
      g.fillStyle = "rgba(255,255,255,0.08)"; g.beginPath(); g.roundRect(x, y - 38 * S, w, 52 * S, 26 * S); g.fill();
      g.fillStyle = "#e6eaee"; g.fillText(f, x + 18 * S, y);
      x += w + 14 * S;
    }
    // live spectrum
    analyser.getByteFrequencyData(freq);
    const specTop = y + 60 * S, specH = H * (format === "story" ? 0.16 : 0.11), nb = 48;
    for (let b = 0; b < nb; b++) {
      const lo = Math.floor(2 ** ((b / nb) * 9.5) ), hi = Math.max(lo + 1, Math.floor(2 ** (((b + 1) / nb) * 9.5)));
      let v = 0; for (let k = lo; k < hi && k < freq.length; k++) v = Math.max(v, freq[k]);
      const h = (v / 255) * specH, bw = (W - 2 * pad) / nb;
      g.fillStyle = p.colour; g.globalAlpha = 0.85;
      g.fillRect(pad + b * bw + 2, specTop + specH - h, bw - 4, h);
    }
    g.globalAlpha = 1;
    // zoomed waveform: 6 seconds either side of now
    const wTop = specTop + specH + 50 * S, wH = H * (format === "story" ? 0.13 : 0.1), span = 6;
    for (let px = 0; px < W; px += 3) {
      const tt = now + ((px - W / 2) / (W / 2)) * span;
      if (tt < 0 || tt > dur) continue;
      const v = peaks[Math.floor((tt / dur) * (peaks.length - 1))];
      const part = parts.find((q) => tt >= q.from && tt < q.to) || p;
      g.fillStyle = part.colour; g.globalAlpha = tt <= now ? 1 : 0.45;
      g.fillRect(px, wTop + wH / 2 - (v * wH) / 2, 2, v * wH);
    }
    g.globalAlpha = 1; g.fillStyle = "#ffffff"; g.fillRect(W / 2 - 2 * S, wTop - 10 * S, 4 * S, wH + 20 * S);
    // what comes next
    let ny = wTop + wH + 70 * S;
    const nx = parts[i + 1];
    g.fillStyle = "#9aa6b2"; font(30, 600);
    if (nx) {
      const n = nameParts(nx.t.file);
      g.fillText(`NEXT in ${(nx.from - now).toFixed(0)} s`, pad, ny);
      g.fillStyle = nx.colour; font(40, 700); ny = wrap(n.title, pad, ny + 52 * S, W - 2 * pad, 48 * S);
      g.fillStyle = "#c8d0d8"; font(28);
      const pl = p.plan;
      wrap(pl ? `Cut on beat one into its hook. ${pl.stretchPct ? `Speed ${pl.stretchPct > 0 ? "+" : ""}${pl.stretchPct}%. ` : ""}Key ${pl.bKeyAfter}: ${pl.keyFit.why}.` : "", pad, ny, W - 2 * pad, 36 * S);
    } else { g.fillText("LAST HOOK", pad, ny); }
    // overview with progress
    const oTop = H - (format === "story" ? 260 : 170) * S, oH = 70 * S;
    parts.forEach((q, k) => {
      const x0 = pad + (q.from / dur) * (W - 2 * pad), x1 = pad + (q.to / dur) * (W - 2 * pad);
      g.fillStyle = q.colour; g.globalAlpha = k === i ? 0.9 : 0.35;
      g.fillRect(x0, oTop, x1 - x0 - 3, oH);
      g.globalAlpha = 1; g.fillStyle = "#0d1117"; font(26, 700); g.fillText(String(k + 1), x0 + 12 * S, oTop + 46 * S);
    });
    const px = pad + (now / dur) * (W - 2 * pad);
    g.fillStyle = "#ffffff"; g.fillRect(px - 2 * S, oTop - 12 * S, 4 * S, oH + 24 * S);
    g.fillStyle = "#9aa6b2"; font(26); g.fillText(`${mmss(now)} / ${mmss(dur)}`, pad, oTop + oH + 46 * S);
    g.textAlign = "right"; g.fillText("Mix and Learn", W - pad, oTop + oH + 46 * S); g.textAlign = "left";
    onStatus(`Recording the video: ${Math.min(100, (100 * now) / dur).toFixed(0)}% (keep this tab in front)`);
  }

  await new Promise((resolve) => {
    const tick = () => { draw(); if (audio.currentTime - t0 < dur + 0.4) requestAnimationFrame(tick); else resolve(); };
    tick();
  });
  rec.stop(); src.disconnect();
  await done;
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), ext, seconds: dur, tracks: clip.map((t) => t.file), bars, mime };
}
