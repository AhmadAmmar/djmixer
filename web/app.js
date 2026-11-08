import { NOTES, SPEED_OF_SOUND, SWARAS, downmix, estimateKey, estimateTempo, freqToNote, keyRelation, makeDemo, noteToFreq, parsePlaylist, rateToSemitones, toM3U, toSwara, yin } from "./dsp.js";
import { LESSONS as BASE_LESSONS } from "./lessons.js";
import { MORE_LESSONS } from "./lessons_more.js";
const LESSONS = [...BASE_LESSONS.slice(0, -1), ...MORE_LESSONS, BASE_LESSONS[BASE_LESSONS.length - 1]];
import { APP_VERSION, addFiles, init as initStudio, library, renderLibrary, restoreLibrary, suggestNext } from "./studio.js";
import { PRESETS, planTransition } from "./mix.js";
import { firstRun, initHelp, tour } from "./help.js";
import { saveFile } from "./platform.js";

const $ = (id) => document.getElementById(id);
// Canvas colours come from the theme's CSS variables, so drawings stay visible on a light or a dark background.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const grid = (alpha) => `rgba(${cssVar("--grid-rgb")},${alpha})`;
let audio;
let master;
let recorder;
const ctx = () => {
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.connect(audio.destination);
    decks.forEach((d) => d.wire());
    setFade(+$("xfade").value);
  }
  if (audio.state === "suspended") audio.resume();
  return audio;
};

// Each knob: what it changes, its range, its default and how its value is shown. Explanations are in help.js.
const KNOBS = [
  { id: "gain", label: "Volume", help: "volume", min: 0, max: 1.2, step: 0.01, def: 1, fmt: (v) => `x${v.toFixed(2)} (${v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf"} dB)` },
  { id: "rate", label: "Speed", help: "speed", min: 0.8, max: 1.25, step: 0.001, def: 1, fmt: (v) => `x${v.toFixed(3)} (${v >= 1 ? "+" : ""}${(100 * (v - 1)).toFixed(1)}%, ${(12 * Math.log2(v)).toFixed(2)} semitones)` },
  { id: "low", label: "Bass (below 250 Hz)", help: "eqLow", min: -30, max: 6, step: 0.5, def: 0, fmt: (v) => `${v > 0 ? "+" : ""}${v} dB` },
  { id: "mid", label: "Mids (around 1 kHz)", help: "eqMid", min: -30, max: 6, step: 0.5, def: 0, fmt: (v) => `${v > 0 ? "+" : ""}${v} dB` },
  { id: "high", label: "Treble (above 4 kHz)", help: "eqHigh", min: -30, max: 6, step: 0.5, def: 0, fmt: (v) => `${v > 0 ? "+" : ""}${v} dB` },
];

class Deck {
  constructor(el, name) {
    Object.assign(this, { el, name, buffer: null, file: "", source: null, playing: false, offset: 0, startedAt: 0, rate: 1, bpm: 0, firstBeat: 0, key: null, cues: [], zoom: 1, peaks: null });
    el.innerHTML = `<h3>${name}: no track</h3><canvas height="160"></canvas><div class="stats">&nbsp;</div>
      <div class="row"><button data-a="play">Play</button><button data-a="load">Load</button><button data-a="cue">Cue</button><input type="file" accept="audio/*" hidden></div>
      <div class="knobs">${KNOBS.map((k) => `
        <div class="knob"><span class="kname" data-help="${k.help}">${k.label}</span> <span class="kval" data-v="${k.id}"></span>
          <button class="reset" data-r="${k.id}" title="Back to the default, ${k.fmt(k.def)} (or double-click the slider)">&#8634;</button>
          <input data-k="${k.id}" type="range" min="${k.min}" max="${k.max}" step="${k.step}" value="${k.def}" aria-label="${k.label}"></div>`).join("")}
        <div class="knob"><span class="kname" data-help="stems">Play</span>
          <select data-stem><option value="full">whole track</option><option value="vocals">vocals only (approx.)</option><option value="music">music only (approx.)</option></select></div>
      </div>
      <div class="row"><button data-a="reset" data-help="resetDeck">Reset this deck's knobs</button></div>`;
    this.title = el.querySelector("h3");
    this.canvas = el.querySelector("canvas");
    this.stats = el.querySelector(".stats");
    const input = el.querySelector("input[type=file]");
    el.querySelector("[data-a=play]").onclick = () => this.toggle();
    el.querySelector("[data-a=load]").onclick = () => input.click();
    el.querySelector("[data-a=cue]").onclick = () => this.addCue();
    input.onchange = () => input.files[0] && this.loadFile(input.files[0]);
    el.querySelectorAll("[data-k]").forEach((s) => {
      s.oninput = () => this.set(s.dataset.k, +s.value);
      s.ondblclick = () => this.resetKnob(s.dataset.k);
    });
    el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => this.resetKnob(b.dataset.r)));
    el.querySelector("[data-a=reset]").onclick = () => this.resetAll();
    el.querySelector("[data-stem]").onchange = (e) => this.setStem(e.target.value);
    this.showValues();
    this.canvas.onclick = (e) => {
      if (!this.buffer) return;
      const r = this.canvas.getBoundingClientRect();
      const [from, to] = this.window();
      this.seek(from + ((e.clientX - r.left) / r.width) * (to - from));
    };
    this.canvas.onwheel = (e) => { e.preventDefault(); this.zoom = Math.min(64, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.25 : 0.8))); };
    el.ondragover = (e) => e.preventDefault();
    el.ondragenter = () => el.classList.add("dropping");
    el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("dropping"); };
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("dropping");
      const id = e.dataTransfer.getData("text/mal-track");
      const item = id && library.find((t) => t.id === id);
      if (item?.buffer) this.setItem(item);
      else if (e.dataTransfer.files[0]) this.loadFile(e.dataTransfer.files[0]);
    };
  }

  wire() {
    this.bands = [["lowshelf", 250, "low"], ["peaking", 1000, "mid"], ["highshelf", 4000, "high"]].map(([type, f, k]) => {
      const b = audio.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.key = k;
      return b;
    });
    // Vocals or music only, by the classic centre-channel method: lead vocals are usually mixed to the centre
    // (equal in left and right), so mid = (L + R)/2 holds them and side = (L - R)/2 cancels them.
    // Bass and kick drum are also centred, so "music" adds back the mid below 150 Hz, and "vocals" keeps only
    // the mid between 150 Hz and 7 kHz. This is an approximation; tools/separate.py makes model-based stems.
    this.input = audio.createGain();
    const split = audio.createChannelSplitter(2);
    this.input.connect(split);
    const g = (v) => { const n = audio.createGain(); n.gain.value = v; return n; };
    const mid = g(1), side = g(1), l2m = g(0.5), r2m = g(0.5), l2s = g(0.5), r2s = g(-0.5);
    split.connect(l2m, 0); split.connect(r2m, 1); split.connect(l2s, 0); split.connect(r2s, 1);
    l2m.connect(mid); r2m.connect(mid); l2s.connect(side); r2s.connect(side);
    const hp = audio.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 150;
    const lp = audio.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7000;
    const bassOnly = audio.createBiquadFilter(); bassOnly.type = "lowpass"; bassOnly.frequency.value = 150;
    this.stemGains = { full: g(1), vocals: g(0), music: g(0) };
    this.input.connect(this.stemGains.full);
    mid.connect(hp).connect(lp).connect(this.stemGains.vocals);
    side.connect(this.stemGains.music); mid.connect(bassOnly).connect(this.stemGains.music);
    Object.values(this.stemGains).forEach((n) => n.connect(this.bands[0]));
    this.setStem(this.stem || "full");
    this.bands[0].connect(this.bands[1]);
    this.bands[1].connect(this.bands[2]);
    this.gain = audio.createGain();
    this.fade = audio.createGain();
    this.analyser = audio.createAnalyser();
    this.analyser.fftSize = 4096;
    this.bands[2].connect(this.gain);
    this.gain.connect(this.analyser);
    this.gain.connect(this.fade);
    this.fade.connect(master);
    this.el.querySelectorAll("[data-k]").forEach((s) => this.set(s.dataset.k, +s.value));
  }

  set(key, value) {
    this.showValues();
    if (key === "rate") {
      this.setRate(value);
      return;
    }
    if (!audio) return;
    if (key === "gain") this.gain.gain.value = value;
    else this.bands.find((b) => b.key === key).gain.value = value;
  }

  showValues() {
    KNOBS.forEach((k) => (this.el.querySelector(`[data-v=${k.id}]`).textContent = k.fmt(+this.el.querySelector(`[data-k=${k.id}]`).value)));
  }

  resetKnob(id) {
    const k = KNOBS.find((x) => x.id === id);
    this.el.querySelector(`[data-k=${id}]`).value = k.def;
    this.set(id, k.def);
  }

  resetAll() {
    KNOBS.forEach((k) => this.resetKnob(k.id));
    this.setStem("full");
  }

  setStem(mode) {
    this.stem = mode;
    this.el.querySelector("[data-stem]").value = mode;
    if (this.stemGains) Object.entries(this.stemGains).forEach(([m, n]) => (n.gain.value = m === mode ? 1 : 0));
  }

  // Everything that describes what this deck is playing, so it can be swapped with or copied to the other deck.
  state() {
    return { itemId: this.itemId, buffer: this.buffer, file: this.file, bpm: this.bpm, firstBeat: this.firstBeat, key: this.key, cues: [...this.cues], peaks: this.peaks,
      position: this.buffer ? this.position() : 0, playing: this.playing, stem: this.stem,
      knobs: Object.fromEntries(KNOBS.map((k) => [k.id, +this.el.querySelector(`[data-k=${k.id}]`).value])) };
  }

  restore(st) {
    this.stop();
    this.itemId = st.itemId;
    Object.assign(this, { buffer: st.buffer, file: st.file, bpm: st.bpm, firstBeat: st.firstBeat, key: st.key, cues: st.cues, peaks: st.peaks, offset: st.position, zoom: 1 });
    this.title.textContent = st.buffer ? `${this.name}: ${st.file}` : `${this.name}: no track`;
    KNOBS.forEach((k) => { this.el.querySelector(`[data-k=${k.id}]`).value = st.knobs[k.id]; this.set(k.id, st.knobs[k.id]); });
    this.setStem(st.stem || "full");
    if (st.playing && st.buffer) this.start();
    compare();
  }

  setRate(value) {
    const pos = this.position();
    this.rate = value;
    this.offset = pos;
    if (this.playing) {
      this.startedAt = audio.currentTime;
      this.source.playbackRate.value = value;
    }
    this.el.querySelector("[data-k=rate]").value = value;
    compare();
  }

  position() {
    if (!this.playing) return this.offset;
    return Math.min(this.buffer.duration, this.offset + Math.max(0, audio.currentTime - this.startedAt) * this.rate);
  }

  // `when` lets two decks start on exactly the same tick of the audio clock (Play both, transitions).
  start(when = 0) {
    ctx();
    if (!this.buffer || this.playing) return;
    this.source = audio.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.rate;
    this.source.connect(this.input);
    const at = Math.max(when, audio.currentTime);
    this.source.start(at, this.offset);
    const src = this.source;
    src.onended = () => {                              // reached the end of the track (not a pause): reset the deck
      if (this.source === src && this.playing && this.position() >= this.buffer.duration - 0.1) {
        this.playing = false; this.offset = 0;
        this.el.querySelector("[data-a=play]").textContent = "Play";
      }
    };
    this.startedAt = at;
    this.playing = true;
    this.el.querySelector("[data-a=play]").textContent = "Pause";
  }

  stop() {
    if (!this.playing) return;
    this.offset = this.position();
    this.source.stop();
    this.playing = false;
    this.el.querySelector("[data-a=play]").textContent = "Play";
  }

  toggle() { this.playing ? this.stop() : this.start(); }

  seek(t) {
    const was = this.playing;
    this.stop();
    this.offset = Math.max(0, Math.min(t, this.buffer.duration - 0.01));
    if (was) this.start();
  }

  addCue() {
    if (this.buffer && this.cues.length < 4) this.cues.push(this.position());
  }

  // A file dropped or chosen here goes through the Library first, so it is measured once, remembered, and shared.
  async loadFile(file) {
    ctx();
    this.title.textContent = `${this.name}: reading and measuring ${file.name}`;
    const [item] = await addFiles([file]);
    if (item?.buffer) this.setItem(item);
    else this.title.textContent = `${this.name}: this file could not be read`;
  }

  setItem(item) {
    this.itemId = item.id;
    this.setBuffer(item.buffer, item.file, false, item);
    try { localStorage.setItem("mal-decks", JSON.stringify(decks.map((d) => d.itemId || null))); } catch {}
    renderLibrary();
    advise();
  }

  setBuffer(buffer, name, keep = false, item = null) {
    this.stop();
    Object.assign(this, { buffer, file: name, offset: 0, zoom: 1 });
    if (!keep) this.cues = [];
    this.title.textContent = `${this.name}: ${name}`;
    this.stats.textContent = "Measuring tempo and key...";
    const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const mono = chans[0];
    const size = 2000;
    const step = Math.floor(mono.length / size) || 1;
    this.peaks = Float32Array.from({ length: size }, (_, i) => {
      let m = 0;
      for (let k = 0; k < step; k += 8) m = Math.max(m, Math.abs(mono[i * step + k] || 0));
      return m;
    });
    const top = Math.max(...this.peaks, 1e-9);
    this.peaks = this.peaks.map((v) => (0.95 * v) / top);   // scale to the loudest moment, so loud masters do not fill the box
    if (item?.bpm) {                                   // measured already, in the Library
      Object.assign(this, { bpm: item.bpm, firstBeat: item.firstBeat, key: { name: item.key, camelot: item.camelot } });
      this.stats.textContent = "";
      compare();
      return;
    }
    setTimeout(() => {
      const f = Math.round(buffer.sampleRate / 11025);
      const x = downmix(chans, f);
      const sr = buffer.sampleRate / f;
      Object.assign(this, estimateTempo(x, sr));
      this.key = estimateKey(x, sr);
      this.stats.textContent = "";
      compare();
    }, 30);
  }

  window() {
    const d = this.buffer.duration;
    const span = d / this.zoom;
    const from = this.zoom === 1 ? 0 : Math.max(0, Math.min(d - span, this.position() - span / 2));
    return [from, from + span];
  }

  draw() {
    const c = this.canvas;
    c.width = c.clientWidth * devicePixelRatio;
    const g = c.getContext("2d");
    const colour = getComputedStyle(this.el).getPropertyValue("--c");
    g.clearRect(0, 0, c.width, c.height);
    if (!this.buffer) return;
    const [from, to] = this.window();
    const x = (t) => ((t - from) / (to - from)) * c.width;
    g.fillStyle = colour;
    const d = this.buffer.duration;
    for (let px = 0; px < c.width; px++) {
      const i = Math.floor(((from + (px / c.width) * (to - from)) / d) * this.peaks.length);
      const h = (this.peaks[i] || 0) * c.height;
      g.fillRect(px, (c.height - h) / 2, 1, h);
    }
    if (this.bpm && to - from < 90) {
      const beat = 60 / this.bpm;
      let n = Math.ceil((from - this.firstBeat) / beat);
      for (let t = this.firstBeat + n * beat; t < to; t += beat, n++) {
        g.fillStyle = ((n % 4) + 4) % 4 === 0 ? grid(0.65) : grid(0.2);
        g.fillRect(x(t), 0, 1, c.height);
      }
    }
    g.fillStyle = "#ffd166";
    this.cues.forEach((t) => g.fillRect(x(t), 0, 2, c.height));
    g.fillStyle = cssVar("--ink");
    g.fillRect(x(this.position()) - 1, 0, 2, c.height);
    const t = this.position();
    const stamp = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    if (this.bpm) {
      const beatNo = Math.max(0, Math.floor((t - this.firstBeat) / (60 / this.bpm)));
      this.stats.textContent = `${stamp} | bar ${Math.floor(beatNo / 4) + 1}, beat ${(beatNo % 4) + 1} | ${(this.bpm * this.rate).toFixed(1)} BPM | ${this.key.name} (${this.key.camelot})`;
    }
  }
}

const decks = [new Deck($("deckA"), "Deck A"), new Deck($("deckB"), "Deck B")];

function setFade(x) {
  if (!audio) return;
  decks[0].fade.gain.value = Math.cos((x * Math.PI) / 2);
  decks[1].fade.gain.value = Math.sin((x * Math.PI) / 2);
}
$("xfade").oninput = (e) => { ctx(); setFade(+e.target.value); };

function compare() {
  const [a, b] = decks;
  if (!a.bpm || !b.bpm) return;
  const needed = (a.bpm * a.rate) / b.bpm;
  $("match").innerHTML = `Tempo gap ${Math.abs(a.bpm * a.rate - b.bpm * b.rate).toFixed(1)} BPM.<br>To match, B plays at ${needed.toFixed(3)} times, which moves its pitch ${rateToSemitones(needed).toFixed(2)} semitones.<br>Keys: ${keyRelation(a.key.camelot, b.key.camelot)}.`;
}

function sync() {
  const [a, b] = decks;
  if (!a.bpm || !b.bpm) return;
  b.setRate((a.bpm * a.rate) / b.bpm);
  if (a.playing && b.playing) {
    const beatA = 60 / a.bpm;
    const phase = (((a.position() - a.firstBeat) % beatA) + beatA) % beatA / beatA;
    const beatB = 60 / b.bpm;
    const n = Math.floor((b.position() - b.firstBeat) / beatB);
    b.seek(b.firstBeat + (n + phase) * beatB);
  }
}
$("sync").onclick = sync;
// Swap exchanges everything the decks hold (track, position, knobs, cues), so the crossfader's sides swap too.
$("swapDecks").onclick = () => { const a = decks[0].state(), b = decks[1].state(); decks[0].restore(b); decks[1].restore(a); };
$("copyAB").onclick = () => decks[1].restore({ ...decks[0].state(), playing: false });
$("copyBA").onclick = () => decks[0].restore({ ...decks[1].state(), playing: false });
// Play both: start the two decks on the same tick of the audio clock, so they begin together to the sample.
function playBoth() {
  ctx();
  if (decks.some((d) => d.playing)) { stopTransition(); decks.forEach((d) => d.stop()); return; }
  const when = audio.currentTime + 0.1;
  decks.forEach((d) => d.start(when));
}
$("playBoth").onclick = playBoth;
$("tPlay").onclick = playBoth;
$("tStop").onclick = () => { stopTransition(); decks.forEach((d) => { d.stop(); }); };

// ---------------------------------------------------------------- the mix advisor
const itemOf = (d) => library.find((t) => t.id === d.itemId);
let lastPlan = null;
function advise() {
  const box = $("advice");
  const [A, B] = decks.map(itemOf);
  if (!A || !B || A.status !== "ready" || B.status !== "ready") {
    box.innerHTML = '<p class="muted small">Load a track on each deck and the advisor explains how to mix A into B.</p>';
    lastPlan = null; return;
  }
  const p = (lastPlan = planTransition({ ...A, duration: A.duration }, { ...B, duration: B.duration }, "auto"));
  const bar = 240 / A.bpm, mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const cut = p.automation[0].bLow !== undefined;
  const next = suggestNext(B, [A]).slice(0, 3);
  box.innerHTML = `<h4>How to mix A into B</h4>
    <p><b class="ca">A (going out)</b>: ${A.bpm.toFixed(1)} BPM, ${A.key} (${A.camelot}), ${A.rmsDb} dB. Leave it at <b>${mm(p.aOutAt)}</b>, the start of its last 8-bar phrase before the outro (${A.outroBars} bar${A.outroBars === 1 ? "" : "s"}), so the change lands where the ear expects one.</p>
    <p><b class="cb">B (coming in)</b>: ${B.bpm.toFixed(1)} BPM, ${B.key} (${B.camelot}), ${B.rmsDb} dB. ${p.stretchPct !== 0 ? `Play it at <b>x${p.bRate.toFixed(3)}</b> (${p.stretchPct > 0 ? "+" : ""}${p.stretchPct}%)${p.multiple !== 1 ? `, meeting at ${p.multiple === 2 ? "double" : "half"} time` : ""}, which moves its pitch ${p.pitchShift} semitones; its key becomes ${p.bKeyAfter}.` : "Keep its speed: no stretch is needed or wise."} Start it from its first beat (${p.bInAt.toFixed(2)} s)${cut ? " with its bass cut, so the two basslines do not fight" : ""}.</p>
    <p><b>Together</b>: ${esc2(p.presetName)} over ${p.bars} bar${p.bars === 1 ? "" : "s"} (${(p.bars * bar).toFixed(1)} s): ${esc2(p.why)}. Keys: ${esc2(p.keyFit.why)}.</p>
    <details><summary>The rule behind this style</summary><p>${esc2(p.rule)}</p></details>
    <div class="row"><button id="applyPlan" data-help="applyPlan">Apply to decks</button><button id="performPlan" data-help="performPlan">Play the transition</button></div>
    ${next.length ? `<h4>What could follow B</h4><ol class="next">${next.map((n) => `<li><b>${esc2(n.track.file)}</b> <button data-next="${n.track.id}">Load to A</button><br><span class="small muted">${n.why.map(esc2).join("; ")}.</span></li>`).join("")}</ol><p class="small muted">Load the next track on deck A, the one that just finished: DJs alternate decks.</p>` : ""}`;
  $("applyPlan").onclick = () => applyPlan(p);
  $("performPlan").onclick = () => performPlan(p);
  box.querySelectorAll("[data-next]").forEach((b) => (b.onclick = () => decks[0].setItem(library.find((t) => t.id === b.dataset.next))));
}
const esc2 = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function applyPlan(p) {
  const [A, B] = decks;
  B.setRate(p.bRate);
  B.stop(); B.offset = p.bInAt;
  A.cues = [p.aOutAt]; B.cues = [p.bInAt];
  const first = p.automation[0];
  const lowB = B.el.querySelector("[data-k=low]");
  lowB.value = first.bLow ?? 0; B.set("low", +lowB.value);
  $("xfade").value = 0; setFade(0);
}

// Perform the transition live: A plays from 4 bars before its exit point, B starts exactly at the exit point,
// and the plan's volume and bass moves are scheduled on the audio clock. Filters and echo are heard only in a render.
function performPlan(p) {
  ctx();
  if (transition) { stopTransition(); decks.forEach((d) => d.stop()); return; }
  applyPlan(p);
  const [A, B] = decks;
  const barReal = 240 / (A.bpm * A.rate);
  A.stop(); A.offset = Math.max(0, p.aOutAt - 4 * barReal * A.rate);
  const now = audio.currentTime + 0.1, when = now + 4 * barReal;
  A.start(now); B.start(when);
  [A.fade.gain, B.fade.gain].forEach((g) => g.cancelScheduledValues(0));
  A.fade.gain.setValueAtTime(1, now); B.fade.gain.setValueAtTime(0, now); B.fade.gain.setValueAtTime(0, when);
  const lowA = A.bands[0].gain, lowB = B.bands[0].gain;
  p.automation.forEach((pt) => {
    const t = when + pt.at * barReal;
    if (pt.aGain !== undefined) A.fade.gain.linearRampToValueAtTime(pt.aGain, t);
    if (pt.bGain !== undefined) B.fade.gain.linearRampToValueAtTime(pt.bGain, t);
    if (pt.aLow !== undefined) lowA.setValueAtTime(pt.aLow, t);
    if (pt.bLow !== undefined) lowB.setValueAtTime(pt.bLow, t);
  });
  const end = when + p.bars * barReal;
  transition = { now, when, end };
  // When it is over, stop A and make the sliders show where the scheduled moves left the sound.
  const last = p.automation[p.automation.length - 1];
  transitionTimer = setTimeout(() => {
    A.stop();
    $("xfade").value = 1; setFade(1);
    const lowB = B.el.querySelector("[data-k=low]"); lowB.value = last.bLow ?? 0; B.set("low", +lowB.value);
    A.resetKnob("low");
    transition = null;
  }, (end - audio.currentTime + 0.3) * 1000);
}
let transition = null, transitionTimer = null;

// Stop a running transition: cancel every scheduled move and put the volumes back where the crossfader says.
function stopTransition() {
  if (!transition) return;
  clearTimeout(transitionTimer);
  transition = null;
  decks.forEach((d) => {
    [d.fade.gain, d.bands[0].gain].forEach((g) => { g.cancelScheduledValues(0); });
    d.set("low", +d.el.querySelector("[data-k=low]").value);
  });
  setFade(+$("xfade").value);
}

$("advise").onclick = advise;

$("resetBoth").onclick = () => { decks.forEach((d) => d.resetAll()); $("xfade").value = 0.5; setFade(0.5); };
$("toggleLessons").onclick = () => {
  const hide = document.body.classList.toggle("nolessons");
  $("toggleLessons").textContent = hide ? "Show lessons" : "Hide lessons";
  try { localStorage.setItem("mal-nolessons", hide ? "1" : ""); } catch {}
};
try { if (localStorage.getItem("mal-nolessons")) $("toggleLessons").click(); } catch {}

function demoBuffer(bpm, root, minor) {
  ctx();
  const sr = audio.sampleRate;
  const data = makeDemo(bpm, root, minor, 60, sr);
  const buffer = audio.createBuffer(1, data.length, sr);
  buffer.copyToChannel(data, 0);
  return buffer;
}
function loadDemos() {
  decks[0].setBuffer(demoBuffer(120, 57, true), "Demo A, 120 BPM, A minor");
  decks[1].setBuffer(demoBuffer(126, 60, false), "Demo B, 126 BPM, C major");
}
$("demos").onclick = loadDemos;

// Sargam view
const saSelect = $("saNote");
for (let m = 48; m <= 72; m++) saSelect.add(new Option(`${NOTES[m % 12]}${Math.floor(m / 12) - 1} (${noteToFreq(m).toFixed(1)} Hz)`, m));
saSelect.value = 60;
const trace = [];
function drawSargam() {
  const c = $("sargam");
  c.width = c.clientWidth * devicePixelRatio;
  const g = c.getContext("2d");
  const sa = noteToFreq(+saSelect.value);
  const lo = -13, hi = 13;
  const y = (s) => c.height - ((s - lo) / (hi - lo)) * c.height;
  g.clearRect(0, 0, c.width, c.height);
  g.font = `${11 * devicePixelRatio}px system-ui`;
  for (let s = lo + 1; s < hi; s++) {
    const [name] = SWARAS[((s % 12) + 12) % 12];
    g.fillStyle = name === "Sa" ? grid(0.33) : grid(0.1);
    g.fillRect(44, y(s), c.width, 1);
    g.fillStyle = cssVar("--muted");
    g.fillText(name + (s < 0 ? "," : s >= 12 ? "'" : ""), 4, y(s) + 4);
  }
  const d = decks[+$("followDeck").value];
  if (d.analyser && d.playing) {
    const buf = new Float32Array(2048);
    d.analyser.getFloatTimeDomainData(buf);
    const { freq, clarity } = yin(buf, audio.sampleRate);
    const ok = freq > 0 && clarity > 0.8;
    trace.push(ok ? toSwara(freq, sa).semis : null);
    if (trace.length > 600) trace.shift();
    if (ok) {
      const s = toSwara(freq, sa), n = freqToNote(freq);
      $("swaraNow").textContent = `${s.name}`;
      $("swaraInfo").textContent = `${freq.toFixed(1)} Hz | ${n.name}${n.octave} | ${s.ratio} of Sa | ${s.cents >= 0 ? "+" : ""}${s.cents} cents`;
    }
  }
  g.strokeStyle = cssVar("--a");
  g.lineWidth = 1.5 * devicePixelRatio;
  g.beginPath();
  let pen = false;
  const dx = (c.width - 44) / 600;
  trace.forEach((s, i) => {
    if (s === null || s < lo || s > hi) { pen = false; return; }
    const px = 44 + i * dx;
    pen ? g.lineTo(px, y(s)) : g.moveTo(px, y(s));
    pen = true;
  });
  g.stroke();
}

function drawSpectrum() {
  const c = $("spectrum");
  c.width = c.clientWidth * devicePixelRatio;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  const x = (f) => (Math.log10(f / 30) / Math.log10(16000 / 30)) * c.width;
  g.font = `${11 * devicePixelRatio}px system-ui`;
  for (const f of [50, 100, 250, 500, 1000, 4000, 10000]) {
    g.fillStyle = grid(0.15);
    g.fillRect(x(f), 0, 1, c.height);
    g.fillStyle = cssVar("--muted");
    g.fillText(f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, x(f) + 3, 14);
  }
  decks.forEach((d, n) => {
    if (!d.analyser || !d.playing) return;
    const v = new Float32Array(d.analyser.frequencyBinCount);
    d.analyser.getFloatFrequencyData(v);
    g.strokeStyle = n ? cssVar("--b") : cssVar("--a");
    g.beginPath();
    v.forEach((db, i) => {
      const f = (i * audio.sampleRate) / d.analyser.fftSize;
      if (f < 30 || f > 16000) return;
      g.lineTo(x(f), c.height * (1 - (db + 100) / 90));
    });
    g.stroke();
  });
}

// Tone tool
let osc;
function updateTone() {
  const f = +$("toneF").value;
  const n = freqToNote(f);
  $("toneInfo").textContent = `${f} Hz | note ${n.name}${n.octave} (${n.cents >= 0 ? "+" : ""}${n.cents} cents) | wavelength ${(SPEED_OF_SOUND / f).toFixed(2)} m | ${toSwara(f, noteToFreq(+saSelect.value)).name} from your Sa`;
  if (osc) osc.frequency.value = f;
  const c = $("toneWave");
  c.width = c.clientWidth * devicePixelRatio;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = cssVar("--a");
  g.beginPath();
  for (let px = 0; px < c.width; px++) g.lineTo(px, c.height / 2 + (c.height / 2.4) * Math.sin(2 * Math.PI * f * (px / c.width) * 0.01));
  g.stroke();
}
$("toneF").oninput = updateTone;
$("tonePlay").onclick = () => {
  ctx();
  if (osc) {
    osc.stop();
    osc = null;
    $("tonePlay").textContent = "Play tone";
    return;
  }
  osc = audio.createOscillator();
  const quiet = audio.createGain();
  quiet.gain.value = 0.15;
  osc.frequency.value = +$("toneF").value;
  osc.connect(quiet);
  quiet.connect(master);
  osc.start();
  $("tonePlay").textContent = "Stop tone";
};

// Views
function show(view) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== view));
  if (view === "tone") updateTone();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => show(b.dataset.view)));

// Lessons
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
LESSONS.forEach((l, i) => {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.textContent = l.title;
  a.tabIndex = 0;
  a.onclick = () => openLesson(i);
  a.onkeydown = (e) => { if (e.key === "Enter") openLesson(i); };
  li.append(a);
  $("lessonList").append(li);
});
function openLesson(i) {
  const l = LESSONS[i];
  document.querySelectorAll("#lessonList a").forEach((a, n) => a.classList.toggle("on", n === i));
  $("lesson").innerHTML = `<h2>${l.title}</h2>${l.text}<p class="try"><b>Try it.</b> ${l.try}</p><h2>The maths</h2><pre>${esc(l.formula)}</pre><h2>The code</h2><pre>${esc(l.code)}</pre>${i + 1 < LESSONS.length ? '<button id="nextLesson">Next lesson</button>' : ""}`;
  if ($("nextLesson")) $("nextLesson").onclick = () => openLesson(i + 1);
  if (["tone", "sargam", "spectrum", "library", "set", "lab"].includes(l.action)) show(l.action);
  $("lessons").scrollTop = $("lesson").offsetTop - 60;
}
openLesson(0);

// Playlist
let playlist = [];
function renderPlaylist() {
  const ul = $("playlist");
  ul.innerHTML = "";
  playlist.forEach((t) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = t.title;
    const row = document.createElement("span");
    row.className = "row";
    decks.forEach((d, n) => {
      const b = document.createElement("button");
      b.textContent = `Load to ${n ? "B" : "A"}`;
      b.onclick = () => d.el.querySelector("[data-a=load]").click();
      row.append(b);
    });
    li.append(name, row);
    ul.append(li);
  });
}
$("playlistAdd").onclick = () => { playlist.push(...parsePlaylist($("playlistText").value)); $("playlistText").value = ""; renderPlaylist(); };
$("playlistFile").onchange = async (e) => { playlist.push(...parsePlaylist(await e.target.files[0].text())); renderPlaylist(); };
const download = (blob, name) => saveFile(blob, name);   // platform.js: download on desktop, Documents + share on Android
$("exportM3U").onclick = () => download(new Blob([toM3U(playlist)], { type: "audio/x-mpegurl" }), "playlist.m3u");

// Projects hold settings and names, so no copyrighted audio is copied into them.
$("save").onclick = () => {
  const project = { format: "mix-and-learn-project", version: 1, crossfader: +$("xfade").value, sa: +saSelect.value, playlist,
    decks: decks.map((d) => ({ file: d.file, rate: d.rate, bpm: d.bpm, firstBeat: d.firstBeat, position: d.position(), cues: d.cues,
      knobs: Object.fromEntries([...d.el.querySelectorAll("[data-k]")].map((s) => [s.dataset.k, +s.value])) })) };
  download(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), "mix_project.json");
};
$("loadProject").onclick = () => $("projectFile").click();
$("projectFile").onchange = async (e) => {
  const p = JSON.parse(await e.target.files[0].text());
  ctx();
  $("xfade").value = p.crossfader;
  setFade(p.crossfader);
  saSelect.value = p.sa;
  playlist = p.playlist || [];
  renderPlaylist();
  p.decks.forEach((s, i) => {
    const d = decks[i];
    Object.entries(s.knobs).forEach(([k, v]) => { d.el.querySelector(`[data-k=${k}]`).value = v; d.set(k, v); });
    d.cues = s.cues;
    d.offset = s.position || 0;
    d.title.textContent = s.file ? `${d.name}: press Load and choose ${s.file}` : `${d.name}: no track`;
  });
};

// Recording what you hear, in the browser's standard WebM audio format
$("record").onclick = () => {
  ctx();
  if (recorder) {
    recorder.stop();
    recorder = null;
    $("record").textContent = "Record mix";
    return;
  }
  const dest = audio.createMediaStreamDestination();
  master.connect(dest);
  const chunks = [];
  recorder = new MediaRecorder(dest.stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => { master.disconnect(dest); download(new Blob(chunks, { type: "audio/webm" }), "my_mix.webm"); };
  recorder.start();
  $("record").textContent = "Stop and save";
};

$("help").onclick = () => $("keys").showModal();
addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) && e.target.type !== "range") return;
  const follow = decks[+$("followDeck").value];
  if (e.code === "Space") { e.preventDefault(); decks[0].toggle(); }
  else if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target.tagName !== "A") decks[1].toggle();
  else if (e.key === "s") sync();
  else if (e.key === "c") follow.addCue();
  else if (e.key >= "1" && e.key <= "4" && follow.cues[+e.key - 1] !== undefined) follow.seek(follow.cues[+e.key - 1]);
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const x = $("xfade");
    x.value = +x.value + (e.key === "ArrowLeft" ? -0.02 : 0.02);
    ctx();
    setFade(+x.value);
  }
});

// The together view: both decks' beats around their playheads on one time axis, and how far apart they are.
function drawTogether() {
  const c = $("together");
  c.width = c.clientWidth * devicePixelRatio;
  const g = c.getContext("2d"), W = c.width, H = c.height, span = 4;   // seconds shown either side of now
  g.clearRect(0, 0, W, H);
  g.font = `${11 * devicePixelRatio}px system-ui`;
  const x = (dt) => W / 2 + (dt / span) * (W / 2);
  decks.forEach((d, n) => {
    const top = n ? H / 2 + 4 : 4, h = H / 2 - 8, col = cssVar(n ? "--b" : "--a");
    g.fillStyle = grid(0.06); g.fillRect(0, top, W, h);
    g.fillStyle = col; g.fillText(`${n ? "B" : "A"} ${d.bpm ? (d.bpm * d.rate).toFixed(1) + " BPM" : ""}${d.playing ? "" : " (paused)"}`, 4, top + 12 * devicePixelRatio);
    if (!d.buffer || !d.bpm) return;
    const pos = d.position(), beat = 60 / d.bpm;
    const k0 = Math.ceil((pos - span * d.rate - d.firstBeat) / beat), k1 = Math.floor((pos + span * d.rate - d.firstBeat) / beat);
    for (let k = k0; k <= k1; k++) {
      const dt = (d.firstBeat + k * beat - pos) / d.rate;               // seconds of real time until that beat
      const down = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = col; g.globalAlpha = down ? 1 : 0.5;
      g.fillRect(x(dt) - (down ? 2 : 1), top + (down ? 0 : h * 0.35), down ? 4 : 2, down ? h : h * 0.65);
    }
    g.globalAlpha = 1;
  });
  g.fillStyle = cssVar("--ink"); g.fillRect(W / 2 - 1, 0, 2, H);
  const [a, b] = decks;
  let txt = "Load both decks to compare their beats.";
  if (a.bpm && b.bpm) {
    const phase = (d) => { const beat = 60 / d.bpm; return ((((d.position() - d.firstBeat) % beat) + beat) % beat) / beat; };
    let diff = phase(a) - phase(b);
    diff -= Math.round(diff);
    const ms = (diff * 60000) / (a.bpm * a.rate);
    const drift = Math.abs(a.bpm * a.rate - b.bpm * b.rate);
    txt = a.playing && b.playing
      ? `Beats ${Math.abs(ms) < 15 ? "in step" : `${Math.abs(ms).toFixed(0)} ms apart (${ms > 0 ? "A ahead" : "B ahead"})`}; tempos differ by ${drift.toFixed(2)} BPM${drift > 0.1 ? `, so they drift a full beat in ${(60 / drift).toFixed(0)} s` : ""}. Gains: A ${a.fade.gain.value.toFixed(2)}, B ${b.fade.gain.value.toFixed(2)}.`
      : "Play both decks to see whether their beats line up.";
    if (transition) txt = `Transition: ${audio.currentTime < transition.when ? `B starts in ${(transition.when - audio.currentTime).toFixed(1)} s` : `${Math.min(100, (100 * (audio.currentTime - transition.when)) / (transition.end - transition.when)).toFixed(0)}% done`}. ` + txt;
  }
  $("togetherInfo").textContent = txt;
}

function frame() {
  decks.forEach((d) => d.draw());
  const any = decks.some((d) => d.playing);              // keep every transport label true to what is playing
  $("playBoth").textContent = $("tPlay").textContent = any ? "Pause both" : "Play both";
  const pp = document.getElementById("performPlan");
  if (pp) pp.textContent = transition ? "Stop the transition" : "Play the transition";
  drawTogether();
  if (!document.querySelector('[data-panel=sargam]').hidden) drawSargam();
  if (!document.querySelector('[data-panel=spectrum]').hidden) drawSpectrum();
  requestAnimationFrame(frame);
}
updateTone();
initStudio({ ctx, decks, download, get master() { ctx(); return master; }, onChange: () => advise() });
initHelp();
$("tourBtn").onclick = () => tour(0);
// Theme: Auto follows the system (light or dark); the choice is remembered on this device.
const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("themeBtn").textContent = `Theme: ${t}`;
  try { localStorage.setItem("mal-theme", t); } catch {}
  renderLibrary();
}
let theme = "auto";
try { theme = localStorage.getItem("mal-theme") || "auto"; } catch {}
applyTheme(theme);
$("themeBtn").onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; applyTheme(theme); };
$("version").textContent = `v${APP_VERSION}`;
show("library");
// Bring back remembered tracks, then the tracks that were on the decks last time.
restoreLibrary().then(() => {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem("mal-decks") || "[]"); } catch {}
  ids.forEach((id, n) => { const t = library.find((x) => x.id === id && x.buffer); if (t) decks[n].setItem(t); });
  advise();
});
firstRun();
frame();
