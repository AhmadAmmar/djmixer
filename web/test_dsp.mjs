// Known-answer tests. Run: node web/test_dsp.mjs
import assert from "node:assert";
import { estimateKey, estimateTempo, freqToNote, keyRelation, makeDemo, parsePlaylist, rateToSemitones, toM3U, toSwara, yin } from "./dsp.js";

const sr = 22050;
const tone = (f, n = 4096) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));

assert.equal(freqToNote(440).name, "A");
assert.equal(freqToNote(440).octave, 4);
assert.equal(freqToNote(261.63).name, "C");
assert.equal(toSwara(330, 220).name, "Pa");
assert.equal(toSwara(220 * (15 / 16), 220).name, "Ni");
assert.equal(toSwara(220 * (15 / 16), 220).octave, -1);
for (const f of [110, 220, 440, 880]) assert.ok(Math.abs(yin(tone(f), sr).freq - f) < 1, `yin ${f}`);
assert.ok(Math.abs(rateToSemitones(2) - 12) < 1e-9);

for (const bpm of [90, 120, 128, 140]) {
  const x = makeDemo(bpm, 57, true, 30, sr);
  const got = estimateTempo(x, sr).bpm;
  assert.ok(Math.abs(got - bpm) < 0.6, `tempo ${bpm} got ${got}`);   // within 0.6 BPM after the fractional search
  console.log("tempo", bpm, "->", got.toFixed(1));
}
const am = estimateKey(makeDemo(120, 57, true, 30, sr), sr);
const c = estimateKey(makeDemo(120, 60, false, 30, sr), sr);
console.log("keys", am.name, am.camelot, c.name, c.camelot);
assert.equal(am.name, "A minor");
assert.equal(am.camelot, "8A");
assert.equal(c.name, "C major");
assert.equal(c.camelot, "8B");
assert.match(keyRelation("8A", "8B"), /relative/);
assert.match(keyRelation("8A", "9A"), /neighbours/);

assert.deepEqual(parsePlaylist('Track Name,Artist Name(s)\n"Socha Hai","Farhan Akhtar"'), [{ title: "Farhan Akhtar - Socha Hai" }]);
assert.equal(parsePlaylist(toM3U([{ title: "A" }]))[0].title, "A");
console.log("all passed");
