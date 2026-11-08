// Library, set builder and sound lab. Shares the decks and audio of app.js through init().
import { NOTES, downmix, noteToFreq } from "./dsp.js";
import { PRESETS, keyFit, orderSet, planTransition, setFile, shiftedKey, semitones, tempoMatch } from "./mix.js";
import { mp3Blob, renderSet as renderMix, sha256, wavBlob } from "./render.js";
import { allTracks, forgetTrack, saveTrack, usage } from "./store.js";

export const APP_VERSION = "0.5.1";
const $ = (id) => document.getElementById(id);
let env;                                   // { ctx, decks, download, master }
export const library = [];                 // { id, file, buffer, sha256, duration, ...analysis }
const worker = new Worker(new URL("./analyse.worker.js", import.meta.url), { type: "module" });
const waiting = new Map();
worker.onmessage = (e) => { waiting.get(e.data.id)(e.data.result); waiting.delete(e.data.id); };
const analyse = (x, sr) => new Promise((res) => { const id = Math.random(); waiting.set(id, res); worker.postMessage({ id, x, sr }, [x.buffer]); });

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------------------------------------------------------------- library
// Every track the app knows lives here, whether it came from the Library button, a drop on a deck, or a previous visit.
// The decks, the Library and the Set builder all point at these same records, so they cannot disagree.
const MEASURES = ["bpm", "firstBeat", "key", "camelot", "keyScore", "rmsDb", "peakDb", "crestDb", "brightnessHz", "introBars", "outroBars", "chroma", "sections", "energy"];

export async function addFiles(files) {
  const audio = env.ctx();
  const added = [];
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const sha = await sha256(bytes);
    const known = library.find((t) => t.sha256 === sha);          // the same recording, already in the library
    if (known) { added.push(known); continue; }
    const item = { id: crypto.randomUUID(), file: file.name, sha256: sha, status: "reading" };
    library.push(item); renderLibrary();
    try {
      item.buffer = await audio.decodeAudioData(bytes.slice(0));
      item.duration = item.buffer.duration;
      item.status = "measuring tempo, key, loudness and sections";
      renderLibrary();
      const chans = Array.from({ length: item.buffer.numberOfChannels }, (_, i) => item.buffer.getChannelData(i));
      const f = Math.round(item.buffer.sampleRate / 11025);
      Object.assign(item, await analyse(downmix(chans, f), item.buffer.sampleRate / f), { status: "ready" });
      const record = { id: item.id, file: item.file, sha256: sha, bytes, duration: item.duration, added: new Date().toISOString() };
      MEASURES.forEach((k) => (record[k] = item[k]));
      await saveTrack(record).catch((err) => (item.status = `ready (could not be remembered: ${err.message})`));
    } catch (err) {
      item.status = `could not read this file (${err.message})`;
    }
    added.push(item);
    renderLibrary(); renderSet();
    env.onChange?.();                                 // let the decks' advisor see the new track
  }
  storeInfo();
  return added;
}

// On start: bring back every remembered track. The measurements are stored, so only decoding is repeated.
export async function restoreLibrary() {
  let records = [];
  try { records = await allTracks(); } catch { return; }
  const audio = env.ctx();
  for (const r of records.sort((p, q) => (p.added < q.added ? -1 : 1))) {
    if (library.some((t) => t.sha256 === r.sha256)) continue;
    const item = { ...r, bytes: undefined, status: "reading (remembered)" };
    library.push(item); renderLibrary();
    try {
      item.buffer = await audio.decodeAudioData(r.bytes.slice(0));
      item.status = "ready";
    } catch (err) { item.status = `could not be decoded again (${err.message})`; }
    renderLibrary();
  }
  renderSet();
  env.onChange?.();
  storeInfo();
}

// How many tracks are remembered, and how much room they take, kept up to date after every add or forget.
async function storeInfo() {
  let n = 0;
  try { n = (await allTracks()).length; } catch {}
  const u = await usage();
  if ($("storeInfo")) $("storeInfo").textContent = `${n} track${n === 1 ? "" : "s"} remembered on this device` + (u ? ` (${u.usedMB.toFixed(0)} MB of ${u.quotaMB.toFixed(0)} MB allowed).` : ".");
}

async function forget(t) {
  await forgetTrack(t.id).catch(() => {});
  library.splice(library.indexOf(t), 1);
  renderLibrary(); renderSet();
  env.onChange?.();
  storeInfo();
}

// What to play next: score every other ready track as a continuation of `current`, best first, with reasons.
export function suggestNext(current, exclude = []) {
  return library.filter((t) => t.status === "ready" && t !== current && !exclude.includes(t)).map((t) => {
    const m = tempoMatch(current.bpm, t.bpm);
    const k = keyFit(shiftedKey(t.camelot, semitones(m.rate)), current.camelot);
    const lift = t.rmsDb >= current.rmsDb;
    const score = (1 - Math.min(m.change / 0.1, 1)) + k.score + (lift ? 0.3 : 0);
    const why = [
      m.change <= 0.04 ? `tempo ${t.bpm.toFixed(0)} BPM is within ${(100 * m.change).toFixed(1)}%${m.multiple !== 1 ? (m.multiple === 2 ? " at double time" : " at half time") : ""}, so the beats can lock`
        : m.change <= 0.08 ? `tempo needs a ${(100 * m.change).toFixed(1)}% change: audible on vocals, fine on drums` : `tempo is ${(100 * m.change).toFixed(0)}% away, so it needs a cut or echo-out`,
      `key ${t.camelot}: ${k.why}`,
      lift ? "it is as loud or louder, so energy keeps rising" : "it is quieter, a chance to let the energy breathe",
    ];
    return { track: t, score, why };
  }).sort((p, q) => q.score - p.score);
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function spark(values, w = 220, h = 36, colour = cssVar("--a")) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h; c.className = "spark";
  const g = c.getContext("2d"), m = Math.max(...values, 1e-9);
  g.strokeStyle = colour; g.beginPath();
  values.forEach((v, i) => g.lineTo((i / (values.length - 1)) * w, h - (v / m) * (h - 2) - 1));
  g.stroke();
  return c;
}

function chromaBars(ch) {
  const c = document.createElement("canvas");
  c.width = 220; c.height = 40; c.className = "spark";
  const g = c.getContext("2d");
  g.font = "8px system-ui";
  ch.forEach((v, i) => {
    g.fillStyle = `hsl(${i * 30},60%,${45 + 15 * v}%)`;
    g.fillRect(i * 18 + 2, 30 - v * 28, 14, v * 28);
    g.fillStyle = cssVar("--muted"); g.fillText(NOTES[i], i * 18 + 3, 39);
  });
  return c;
}

export function renderLibrary() {
  const ul = $("library");
  if (!ul) return;
  ul.innerHTML = "";
  library.forEach((t) => {
    const li = document.createElement("li");
    li.className = "card";
    if (t.status === "ready") {                       // drag a ready track onto a deck
      li.draggable = true;
      li.title = "Drag onto deck A or B";
      li.ondragstart = (e) => e.dataTransfer.setData("text/mal-track", t.id);
    }
    const onDecks = env.decks.map((d, n) => (d.itemId === t.id ? `on deck ${n ? "B" : "A"}` : null)).filter(Boolean);
    li.innerHTML = `<b>${esc(t.file)}</b> ${onDecks.map((s) => `<span class="badge">${s}</span>`).join(" ")}<div class="muted">${esc(t.status)}</div>`;
    if (t.status === "ready") {
      li.innerHTML += `<div class="facts">
        <span data-help="bpm">${t.bpm.toFixed(1)} BPM</span><span data-help="key">${esc(t.key)} (${t.camelot})</span>
        <span data-help="length">${fmtTime(t.duration)}</span><span data-help="loudness">${t.rmsDb} dB RMS, peak ${t.peakDb} dB</span>
        <span data-help="brightness">brightness ${t.brightnessHz} Hz</span><span data-help="intro">intro ${t.introBars} bars, outro ${t.outroBars} bars</span></div>`;
      const row = document.createElement("div"); row.className = "row";
      const lab = (txt, help) => { const s = document.createElement("span"); s.className = "muted small"; s.textContent = txt; s.dataset.help = help; return s; };
      row.append(lab("energy over time", "energy"), spark(t.energy), lab("notes used", "chroma"), chromaBars(t.chroma));
      li.append(row);
      const btns = document.createElement("div"); btns.className = "row";
      env.decks.forEach((d, n) => {
        const b = document.createElement("button"); b.textContent = `Load to ${n ? "B" : "A"}`;
        b.onclick = () => d.setItem(t); btns.append(b);
      });
      const del = document.createElement("button"); del.textContent = "Forget";
      del.title = "Remove from the library and from this device's memory";
      del.onclick = () => forget(t); btns.append(del);
      const pick = document.createElement("label");
      pick.innerHTML = `<input type="checkbox" ${t.inSet ? "checked" : ""}> in the set`;
      pick.querySelector("input").onchange = (e) => { t.inSet = e.target.checked; renderSet(); };
      btns.append(pick);
      li.append(btns);
    }
    ul.append(li);
  });
  renderMatrix();
}

// How well every pair of tracks would mix: tempo change needed and key fit after that change.
function renderMatrix() {
  const ready = library.filter((t) => t.status === "ready");
  const box = $("matrix");
  if (!box) return;
  if (ready.length < 2) { box.innerHTML = '<p class="muted">Add two or more tracks to compare every pair.</p>'; return; }
  let h = '<table class="matrix"><tr><th>from \\ to</th>' + ready.map((t) => `<th title="${esc(t.file)}">${esc(t.file.slice(0, 14))}</th>`).join("") + "</tr>";
  ready.forEach((a) => {
    h += `<tr><th title="${esc(a.file)}">${esc(a.file.slice(0, 14))}</th>`;
    ready.forEach((b) => {
      if (a === b) { h += "<td>-</td>"; return; }
      const t = tempoMatch(a.bpm, b.bpm), k = keyFit(shiftedKey(b.camelot, semitones(t.rate)), a.camelot);
      const ok = t.change <= 0.06 && k.score >= 0.8 ? "good" : t.change <= 0.08 && k.score >= 0.5 ? "fair" : "hard";
      h += `<td class="${ok}" title="${esc(k.why)}">${t.multiple !== 1 ? (t.multiple === 2 ? "×2 " : "½ ") : ""}${(100 * (t.rate - 1)).toFixed(1)}%<br>${k.score.toFixed(1)}</td>`;
    });
    h += "</tr>";
  });
  box.innerHTML = h + '</table><p class="muted small">Each cell: the speed change the second track needs (×2 or ½ when it meets at double or half time) and the key fit after that change, from 0 (clash) to 1 (same key). Green is easy to blend, amber possible, red better cut or echoed out. Hover a cell for the reason.</p>';
}

// ---------------------------------------------------------------- set builder
let order = [];
let plans = [];
export function renderSet() {
  const chosen = library.filter((t) => t.inSet && t.status === "ready");
  order = order.filter((t) => chosen.includes(t)).concat(chosen.filter((t) => !order.includes(t)));
  const preset = $("presetChoice")?.value ?? "auto";
  plans = order.slice(1).map((b, i) => planTransition(order[i], b, preset));
  const ol = $("setOrder");
  if (!ol) return;
  ol.innerHTML = "";
  order.forEach((t, i) => {
    const li = document.createElement("li");
    li.value = i + 1;                                  // number tracks 1, 2, 3; the transition notes between them are not counted
    li.innerHTML = `<b>${esc(t.file)}</b> <span class="muted">${t.bpm.toFixed(1)} BPM, ${t.camelot}, ${t.rmsDb} dB</span>`;
    const up = document.createElement("button"); up.textContent = "Up"; up.disabled = i === 0;
    up.onclick = () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; renderSet(); };
    li.append(" ", up);
    ol.append(li);
    if (i < plans.length) {
      const p = plans[i], d = document.createElement("li");
      d.className = "transition";
      d.innerHTML = `<div><b>${esc(p.presetName)}</b> <span class="muted">(${esc(p.why)})</span></div>
        <div>Leave at ${fmtTime(p.aOutAt)} (an 8-bar phrase boundary); bring the next track in from its first beat, ${p.bInAt.toFixed(2)} s;
        blend over ${p.bars} bars (${p.seconds.toFixed(1)} s).</div>
        <div>Speed of the next track: ${p.bRate.toFixed(3)}×${p.multiple !== 1 ? ` (meeting at ${p.multiple === 2 ? "double" : "half"} time)` : ""},
        ${p.stretchPct >= 0 ? "+" : ""}${p.stretchPct}%, which moves its pitch ${p.pitchShift} semitones; its key becomes ${p.bKeyAfter}: ${esc(p.keyFit.why)}.</div>
        <details><summary>The rule behind this preset</summary><p>${esc(p.rule)}</p></details>`;
      ol.append(d);
    }
  });
  $("setInfo").textContent = order.length < 2 ? "Tick at least two tracks in the Library." : `${order.length} tracks, ${plans.length} transitions.`;
}

async function render(kind) {
  if (order.length < 2) return;
  const status = $("setInfo");
  status.textContent = "Rendering the mix (faster than real time)...";
  const { buffer, timeline } = await renderMix(order.map((t) => ({ buffer: t.buffer, bpm: t.bpm, firstBeat: t.firstBeat, file: t.file, rmsDb: t.rmsDb })), plans);
  const name = `mix_${new Date().toISOString().slice(0, 10)}`;
  if (kind === "wav") env.download(wavBlob(buffer), name + ".wav");
  else env.download(await mp3Blob(buffer, 192, (f) => (status.textContent = `Encoding MP3: ${Math.round(100 * f)}%`)), name + ".mp3");
  const file = setFile(order, plans, APP_VERSION);
  file.timeline = timeline;
  env.download(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), name + "_set.json");
  status.textContent = `Saved ${name}.${kind} (${fmtTime(buffer.duration)}) and ${name}_set.json, which can rebuild it.`;
}

// Open a saved set: match its tracks to loaded files by fingerprint, then restore order and plans.
async function openSet(file) {
  const s = JSON.parse(await file.text());
  const missing = [];
  order = s.tracks.map((t) => {
    const hit = library.find((l) => l.sha256 === t.sha256) || library.find((l) => l.file === t.file);
    if (!hit) missing.push(t.file);
    else hit.inSet = true;
    return hit;
  }).filter(Boolean);
  renderLibrary(); renderSet();
  $("setInfo").textContent = missing.length ? `Add these files to the Library first, then open the set again: ${missing.join("; ")}` : `Set restored: ${order.length} tracks. Render to make the same mix again.`;
}

// ---------------------------------------------------------------- sound lab
let labNodes = [];
function stopLab() { labNodes.forEach((n) => { try { n.stop(); } catch {} }); labNodes = []; }
function tone(freqs, seconds = 1.5, type = "sine", at = 0) {
  const a = env.ctx();
  freqs.forEach((f) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, a.currentTime + at);
    g.gain.linearRampToValueAtTime(0.15 / freqs.length, a.currentTime + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + at + seconds);
    o.connect(g).connect(env.master);
    o.start(a.currentTime + at); o.stop(a.currentTime + at + seconds + 0.05);
    labNodes.push(o);
  });
}
function click(at, accent) {
  const a = env.ctx(), o = a.createOscillator(), g = a.createGain();
  o.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(accent ? 0.4 : 0.2, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + at + 0.05);
  o.connect(g).connect(env.master); o.start(a.currentTime + at); o.stop(a.currentTime + at + 0.06);
  labNodes.push(o);
}
const A4 = 440;
export const LAB = [
  ["A note: A4, 440 Hz", "One steady frequency. 440 vibrations a second is the note A above middle C, the pitch orchestras tune to.", () => tone([A4])],
  ["An octave: 440 then 880 Hz", "Double the frequency and you hear the same note, higher. That is why notes repeat in octaves.", () => { tone([A4], 1); tone([2 * A4], 1, "sine", 1.1); }],
  ["A fifth: 3:2", "Two notes whose frequencies are in the ratio 3:2 (440 and 660 Hz) blend smoothly: their vibrations line up every third and second cycle. Pa against Sa.", () => tone([A4, A4 * 1.5], 2)],
  ["A semitone: the smallest step", "440 and 466 Hz, one twelfth of an octave apart (ratio 2^(1/12) = 1.0595). Played together they beat and rub.", () => tone([A4, A4 * 2 ** (1 / 12)], 2)],
  ["Major chord", "Root, major third (5:4) and fifth (3:2): A, C#, E. Bright, settled.", () => tone([A4, A4 * 2 ** (4 / 12), A4 * 1.5], 2)],
  ["Minor chord", "Root, minor third (6:5) and fifth: A, C, E. One note lower by a semitone, and the mood turns darker.", () => tone([A4, A4 * 2 ** (3 / 12), A4 * 1.5], 2)],
  ["Timbre: four waves, one pitch", "The same 220 Hz as a sine, triangle, square and sawtooth wave. Same note, different colour, because each adds different overtones (multiples of 220 Hz).",
    () => ["sine", "triangle", "square", "sawtooth"].forEach((t, i) => tone([220], 0.9, t, i))],
  ["Beat, bar, phrase at your tempo", "Clicks at the tempo below; the high click is beat one of each bar of four. Eight bars make a phrase, the unit DJs mix on.",
    () => { const bpm = +$("labBpm").value, b = 60 / bpm; for (let i = 0; i < 32; i++) click(i * b, i % 4 === 0); }],
  ["Half time and double time", "The same bars at 140 BPM, first counting every beat, then only every other: you feel 70. Why 70 and 140 BPM tracks can be mixed.",
    () => { const b = 60 / 140; for (let i = 0; i < 16; i++) click(i * b, i % 4 === 0); for (let i = 0; i < 8; i++) click(16 * b + 0.3 + i * 2 * b, i % 2 === 0); }],
  ["Speed changes pitch", "A tone at 440 Hz, then sped up by 6% (466 Hz): about one semitone higher. This is why stretching a track more than a few per cent changes its key.",
    () => { tone([A4], 1); tone([A4 * 1.06], 1, "sine", 1.1); }],
];

export function init(e) {
  env = e;
  $("libFiles").onchange = (ev) => addFiles([...ev.target.files]);
  $("libraryDrop").ondragover = (ev) => ev.preventDefault();
  $("libraryDrop").ondrop = (ev) => { ev.preventDefault(); addFiles([...ev.dataTransfer.files]); };
  const sel = $("presetChoice");
  sel.add(new Option("Auto: choose from the measurements", "auto"));
  Object.entries(PRESETS).forEach(([id, p]) => sel.add(new Option(p.name, id)));
  sel.onchange = renderSet;
  $("autoOrder").onclick = () => { order = orderSet(order); renderSet(); };
  $("setFromDecks").onclick = () => {                 // the two deck tracks become the set, A first
    const items = env.decks.map((d) => library.find((t) => t.id === d.itemId)).filter(Boolean);
    library.forEach((t) => (t.inSet = items.includes(t)));
    order = items; renderLibrary(); renderSet();
  };
  $("renderWav").onclick = () => render("wav");
  $("renderMp3").onclick = () => render("mp3");
  $("openSet").onclick = () => $("setFile").click();
  $("setFile").onchange = (ev) => openSet(ev.target.files[0]);
  const lab = $("labButtons");
  LAB.forEach(([title, text, play]) => {
    const div = document.createElement("div"); div.className = "card";
    div.innerHTML = `<b>${esc(title)}</b><p class="muted small">${esc(text)}</p>`;
    const b = document.createElement("button"); b.textContent = "Play";
    b.onclick = () => { stopLab(); play(); };
    div.append(b); lab.append(div);
  });
  $("labBpm").oninput = () => ($("labBpmOut").textContent = $("labBpm").value);
  $("labStop").onclick = stopLab;
  renderLibrary(); renderSet();
}
