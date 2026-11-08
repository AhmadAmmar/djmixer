// Analyse audio files with the app's own dsp.js, outside the browser. Decoding is done by ffmpeg.
// Run: node tools/analyse.mjs "file1.mp3" "file2.mp3" ...   (prints JSON lines)
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { analyseTrack } from "../web/dsp.js";

const SR = 11025;
for (const file of process.argv.slice(2)) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const t0 = Date.now();
  const a = analyseTrack(x, SR);
  console.log(JSON.stringify({ file: basename(file), seconds: +(x.length / SR).toFixed(1), ms: Date.now() - t0, ...a, energy: undefined, chroma: a.chroma.map((v) => +v.toFixed(3)) }));
}
