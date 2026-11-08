// Print the hooks the app finds in audio files: node tools/hooks.mjs a.mp3 b.mp3   (needs ffmpeg)
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { estimateTempo, findHooks } from "../web/dsp.js";

const SR = 11025;
const mmss = (s) => { const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`; };
for (const file of process.argv.slice(2)) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const t = estimateTempo(x, SR), t0 = Date.now();
  const hooks = findHooks(x, SR, t.bpm, t.firstBeat);
  console.log(basename(file).slice(0, 40), `${t.bpm.toFixed(1)} BPM`, `(${Date.now() - t0} ms)`);
  hooks.forEach((h) => console.log(`   hook ${mmss(h.start)}-${mmss(h.start + h.seconds)}  similarity ${h.similarity}  loudness ${h.loudness}  also at ${h.repeatsAt.map(mmss).join(", ")}`));
}
