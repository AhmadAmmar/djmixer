// Known-answer tests for the zip reader and the hook medley. Run: node web/test_hooks.mjs
import assert from "node:assert";
import { deflateRawSync } from "node:zlib";
import { audioFromZip } from "./unzip.js";
import { chosenHook, planHookMedley } from "./mix.js";
import { findHooks, makeDemo } from "./dsp.js";

// A zip made by hand: one stored file, one deflated file, one text file (skipped). Checks the parser byte by byte.
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data, method] of entries) {
    const body = method === 8 ? deflateRawSync(data) : data, n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(method, 10); c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(local, n, body); central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...parts, cd, end])], "test.zip");
}
const a = Buffer.from("stored audio bytes"), b = Buffer.from("deflated audio bytes ".repeat(50));
const files = await audioFromZip(zip([["songs/a.mp3", a, 0], ["songs/b.wav", b, 8], ["readme.txt", Buffer.from("x"), 0]]));
assert.deepEqual(files.map((f) => f.name), ["a.mp3", "b.wav"]);
assert.equal(Buffer.from(await files[1].arrayBuffer()).toString(), b.toString());

// Hooks: a demo whose 8-bar loop repeats is found to repeat strongly.
const sr = 11025, x = makeDemo(120, 57, true, 60, sr);
const hooks = findHooks(x, sr, 120, 0);
assert.ok(hooks.length >= 2 && hooks.every((h) => h.similarity > 0.9), "a repeating loop has repeated hooks");

// Medley: each track leaves at the end of its chosen hook and the next enters at the start of its own.
const t1 = { file: "one", bpm: 120, firstBeat: 0, duration: 200, camelot: "8A", hooks: [{ rank: 1, start: 40, seconds: 16 }] };
const t2 = { file: "two", bpm: 122, firstBeat: 0.5, duration: 200, camelot: "8A", hooks: [{ rank: 2, start: 30, seconds: 16 }, { rank: 1, start: 70, seconds: 16 }], hookStart: 30 };
const [p] = planHookMedley([t1, t2]);
assert.equal(chosenHook(t2).start, 30);            // the hook chosen by hand wins over the best-ranked one
assert.equal(p.aOutAt, 56); assert.equal(p.bInAt, 30);
assert.ok(Math.abs(p.bRate - 120 / 122) < 1e-4);   // 1.6% apart: matched
console.log("zip and hook tests passed;", hooks.length, "hooks in the demo");
