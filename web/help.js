// Explanations for every control: hover (desktop) or press and hold (touch) anything with a data-help name.
// Each entry: what it is, what it means musically, the science, and where the code is.
export const HELP = {
  bpm: { what: "Tempo, in beats per minute.", music: "The pulse you tap your foot to. Ballads sit near 70 to 90, pop near 100 to 120, house near 120 to 128, Bollywood dance and bhangra often 90 to 110 or 130 and above.", science: "The app measures when new sound energy appears (onsets), then finds the gap at which that pattern repeats best (autocorrelation). It can report half or double the tempo you would tap.", code: "dsp.js: onsetEnvelope, estimateTempo" },
  key: { what: "The home note and mode of the song, for example A minor.", music: "Songs in the same or neighbouring keys share most of their notes, so they can overlap without the melodies clashing.", science: "The app adds up how much of each of the 12 notes sounds (a chroma vector) and correlates it with the Krumhansl–Kessler profiles of every major and minor key. Relative major and minor (same notes) are easily confused.", code: "dsp.js: chroma, estimateKey" },
  length: { what: "Duration of the track.", music: "Long intros and outros make mixing easier; radio edits are short and start with vocals.", science: "Number of samples divided by the sample rate (44,100 per second for CD-quality audio).", code: "AudioBuffer.duration" },
  loudness: { what: "Average level (RMS) and the highest peak, in decibels relative to full scale (dBFS).", music: "Tracks mastered at different loudness need their volumes matched when mixed, or the new one will seem better just because it is louder.", science: "RMS is the square root of the mean of the squared samples; dB = 20 log10(value). A peak above 0 dBFS means the decoded file overshoots full scale: loud mastering plus MP3 decoding.", code: "dsp.js: analyseTrack (rmsDb, peakDb, crestDb)" },
  brightness: { what: "The spectral centroid: the balance point of the spectrum, in Hz.", music: "A high value sounds bright or thin (hi-hats, synths); a low value warm or dark (bass, pads).", science: "Sum of frequency × magnitude over all frequencies, divided by the sum of magnitudes, from short Fourier transforms.", code: "dsp.js: spectralCentroid" },
  intro: { what: "Bars before the track gets loud, and bars after its last loud phrase.", music: "DJs mix over intros and outros, where there are usually drums but no vocals.", science: "Loudness per second, averaged over 8-bar phrases from the first beat; a phrase above half the loudest is counted as full.", code: "dsp.js: energyCurve, sections" },
  energy: { what: "Loudness of the track over time, one point per second.", music: "Peaks are choruses and drops; dips are breakdowns. Good transitions often happen as one track dips and the next rises.", science: "Root-mean-square of each second of samples.", code: "dsp.js: energyCurve" },
  chroma: { what: "How much of each of the 12 notes the track uses, whatever the octave.", music: "The tallest bars are the notes of its key. Two tracks with similar bars will sound good together.", science: "Each frequency of the Fourier transform is assigned to its nearest note name and the energies are summed.", code: "dsp.js: chroma" },
  crossfader: { what: "Slides the sound from deck A to deck B.", music: "The basic move of DJing: one song gives way to the next.", science: "Equal-power curve: gain A = cos(xπ/2), gain B = sin(xπ/2), so A² + B² stays 1 and the total loudness does not dip in the middle.", code: "app.js: setFade" },
  sync: { what: "Changes deck B's speed to match deck A's tempo, then lines up the beats.", music: "With matched beats two songs can play together without the drums galloping.", science: "rate = BPM of A / BPM of B; the pitch moves by 12 log2(rate) semitones. Then B is moved so its beat phase equals A's.", code: "app.js: sync" },
  eq: { what: "Low, mid and high equaliser bands on each deck.", music: "Turn down the bass of the incoming track while the outgoing one plays, then swap: two basslines at once sound muddy.", science: "Biquad filters: a low shelf at 250 Hz, a peak at 1 kHz and a high shelf at 4 kHz, in decibels.", code: "app.js: Deck.wire" },
  preset: { what: "The style of transition used between each pair of tracks.", music: "Different scenes mix differently: long bass-swap blends in house, short crossfades in pop, clean cuts on the sam in Bollywood, filter sweeps in acid, echo-outs when nothing fits.", science: "Each preset is a list of automation points (volume, EQ, filter, echo) placed in bars, so it scales with the tempo.", code: "mix.js: PRESETS, suggestPreset" },
  autoOrder: { what: "Puts the chosen tracks in an order that mixes well.", music: "Start calm, then move to the next track that is easiest to mix into, with energy rising through the set.", science: "A greedy search: from the current track, score every remaining one by tempo closeness, key fit after the speed change, and a small bonus for being louder; take the best.", code: "mix.js: orderSet" },
  render: { what: "Makes the whole mix as one audio file.", music: "What a recorded DJ set or a mixtape is. Each track is first trimmed to the same average loudness (-14 dB RMS), as a DJ sets the gain knob, so no song seems better just for being louder.", science: "An OfflineAudioContext plays every track through its filters and automation as fast as the computer can, then the samples are written as WAV (raw) or MP3 (compressed with the LAME encoder).", code: "render.js: renderSet, wavBlob, mp3Blob" },
  setFile: { what: "A small JSON file describing the set: tracks, their fingerprints, and every transition.", music: "Like a DJ's notes, but exact: open it with the same files and render to get the same mix.", science: "Each audio file's SHA-256 fingerprint proves the same recording is used; the plan stores every speed, time and automation value.", code: "mix.js: setFile; studio.js: openSet" },
  matrix: { what: "How easy each pair of tracks is to mix, in each direction.", music: "Green pairs can blend for a long time; red pairs are better cut or echoed out.", science: "Tempo change needed (allowing half or double time) and Camelot key fit after the pitch moves with the speed.", code: "studio.js: renderMatrix" },
  sargam: { what: "The pitch of the melody, against the swaras Sa, Re, Ga, Ma, Pa, Dha, Ni.", music: "Choose your Sa; the line shows which swara is sung and how singers glide between them.", science: "YIN pitch detection finds the period of the wave by comparing it with delayed copies of itself.", code: "dsp.js: yin, toSwara" },
  spectrum: { what: "All frequencies sounding now, bass on the left.", music: "Kick drums flash on the left, voices in the middle, cymbals on the right.", science: "A fast Fourier transform of the last 4096 samples, drawn on a logarithmic frequency axis like the ear hears.", code: "app.js: drawSpectrum" },
};

const tip = document.createElement("div");
tip.className = "tip"; tip.hidden = true;
document.body.append(tip);

function show(el) {
  const h = HELP[el.dataset.help];
  if (!h) return;
  tip.innerHTML = `<b>${h.what}</b><p><i>Music:</i> ${h.music}</p><p><i>Science:</i> ${h.science}</p><p class="code">${h.code}</p>`;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const top = r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8;
  tip.style.top = `${Math.max(8, top)}px`;
  tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left))}px`;
}
export function initHelp() {
  let timer;
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-help]"); if (el) show(el); else tip.hidden = true; });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-help]"); if (el) show(el); });
  document.addEventListener("touchstart", (e) => { const el = e.target.closest("[data-help]"); if (el) timer = setTimeout(() => show(el), 500); }, { passive: true });
  document.addEventListener("touchend", () => clearTimeout(timer));
  document.addEventListener("click", (e) => { if (!e.target.closest("[data-help]")) tip.hidden = true; });
}

// ---------------------------------------------------------------- first-run tour
const TOUR = [
  ["#lessons", "Lessons", "Start here. Each lesson explains one idea (a note, a beat, a key, a mix), gives you something to try, and shows the formula and the code behind it."],
  ["[data-view=library]", "Library", "Add your own audio files. The app measures each one: tempo, key, loudness, brightness, intro and outro, and draws its energy and notes."],
  ["[data-view=set]", "Set builder", "Tick tracks in the Library, choose a style of transition or let the app choose, put them in a good order, and render the whole mix as WAV or MP3, with a set file to make it again."],
  ["[data-view=lab]", "Sound lab", "Hear the ideas: a note, an octave, a fifth, major and minor chords, timbre, beats and bars, half and double time."],
  ["#deckA", "Decks", "Two players, as on a DJ controller. Play, set the speed, and use the Low, Mid and High knobs."],
  ["#xfade", "Crossfader", "Slides from deck A to deck B. Hover or press and hold anything with a dotted underline for an explanation."],
];
export function tour(step = 0) {
  document.querySelectorAll(".tour-on").forEach((e) => e.classList.remove("tour-on"));
  document.querySelector(".tourbox")?.remove();
  if (step >= TOUR.length) { try { localStorage.setItem("mal-tour-done", "1"); } catch {} return; }
  const [sel, title, text] = TOUR[step];
  const el = document.querySelector(sel);
  el?.classList.add("tour-on");
  el?.scrollIntoView({ block: "nearest" });
  const box = document.createElement("div");
  box.className = "tourbox";
  box.innerHTML = `<b>${step + 1} of ${TOUR.length}: ${title}</b><p>${text}</p>`;
  const next = document.createElement("button"); next.textContent = step + 1 < TOUR.length ? "Next" : "Done";
  next.onclick = () => tour(step + 1);
  const skip = document.createElement("button"); skip.textContent = "Skip tour";
  skip.onclick = () => tour(TOUR.length);
  box.append(next, " ", skip);
  document.body.append(box);
}
export function firstRun() {
  let done = false;
  try { done = localStorage.getItem("mal-tour-done") === "1"; } catch {}
  if (!done) tour(0);
}
