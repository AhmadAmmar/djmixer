// Known-answer tests for the set rules. Run: node web/test_mix.mjs
import assert from "node:assert";
import { encodeWav, keyFit, orderSet, planTransition, semitones, shiftedKey, suggestPreset, tempoMatch } from "./mix.js";

assert.ok(Math.abs(semitones(2) - 12) < 1e-9);
assert.equal(tempoMatch(70, 140).multiple, 2);                 // half time meets double time
assert.ok(Math.abs(tempoMatch(128, 124).rate - 128 / 124) < 1e-9);
assert.equal(shiftedKey("8A", 1), "3A");                      // A minor up a semitone is A# minor, 3A
assert.equal(shiftedKey("8B", 7), "9B");                      // up a fifth is one step clockwise
assert.equal(keyFit("8A", "8B").score, 0.9);
assert.equal(keyFit("8A", "9A").score, 0.8);
assert.equal(keyFit("11A", "10B").score, 0.6);                // diagonal move
assert.equal(suggestPreset({ bpm: 80, camelot: "11B" }, { bpm: 136, camelot: "10B" }).id, "echo-out");

const a = { bpm: 128, firstBeat: 0.5, duration: 300, outroBars: 8, camelot: "8A", rmsDb: -9 };
const b = { bpm: 126, firstBeat: 0.2, duration: 280, outroBars: 8, camelot: "8A", rmsDb: -8 };
const t = planTransition(a, b);
assert.equal(t.preset, "house-eq-swap");
assert.ok(Math.abs(t.bRate - 128 / 126) < 1e-4);
assert.ok(((t.aOutAt - a.firstBeat) / (240 / 128)) % 8 < 1e-6, "leaves A on an 8-bar boundary");

const order = orderSet([{ bpm: 80, camelot: "11B", rmsDb: -13 }, { bpm: 136, camelot: "10B", rmsDb: -10 }, { bpm: 89, camelot: "2B", rmsDb: -8 }, { bpm: 129, camelot: "11A", rmsDb: -11 }]);
assert.equal(order[0].rmsDb, -13);                              // starts with the calmest
assert.equal(order.length, 4);

const wav = new DataView(encodeWav([new Float32Array([0, 0.5, -1])], 8000));
assert.equal(wav.getUint32(40, true), 6);                       // three 2-byte samples
assert.equal(wav.getInt16(46, true), 16383);                 // 0.5 x 32767, cut to a whole number
assert.equal(wav.getInt16(48, true), -32768);                 // -1 is the most negative 16-bit value
console.log("mix tests passed;", "order:", order.map((o) => o.bpm).join(" -> "));
