// Analyse audio files and plan a set from them, with the app's own code, outside the browser.
//   node tools/plan.mjs [--order given|auto] [--preset auto|house-eq-swap|...] [--tex out.tex] file1 file2 ...
// Prints the measurements and every transition; with --tex also writes them as a LaTeX table for the guide.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { analyseTrack } from "../web/dsp.js";
import { orderSet, planTransition } from "../web/mix.js";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const orderMode = opt("--order", "given"), preset = opt("--preset", "auto"), tex = opt("--tex", null);
const SR = 11025;
const short = (f) => basename(f).replace(/ \(SPOTISAVER\)/, "").replace(/\.mp3$/i, "");

let tracks = args.map((file) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  return { file: short(file), duration: x.length / SR, ...analyseTrack(x, SR) };
});
if (orderMode === "auto") tracks = orderSet(tracks);
const plans = tracks.slice(1).map((b, i) => planTransition(tracks[i], b, preset));

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
tracks.forEach((t) => console.log(`${t.file}: ${t.bpm} BPM, ${t.key} (${t.camelot}), ${t.rmsDb} dB RMS, intro ${t.introBars} bars, outro ${t.outroBars} bars, ${mmss(t.duration)}`));
plans.forEach((p, i) => console.log(`  ${tracks[i].file} -> ${tracks[i + 1].file}: ${p.presetName}; leave at ${mmss(p.aOutAt)}, speed ${p.bRate}x (${p.stretchPct}%), pitch ${p.pitchShift} st, key ${p.bKeyAfter} (${p.keyFit.why}); because ${p.why}`));

if (tex) {
  const e = (s) => String(s).replace(/([&%$#_{}])/g, "\\$1").replace(/->/g, "$\\to$");
  let out = "\\begin{tabularx}{\\linewidth}{@{}Xrlrr@{}}\\toprule\nTrack & BPM & Key & RMS (dB) & Length \\\\\\midrule\n";
  tracks.forEach((t) => (out += `${e(t.file)} & ${t.bpm.toFixed(1)} & ${e(t.key)} (${t.camelot}) & ${t.rmsDb} & ${mmss(t.duration)} \\\\\n`));
  out += "\\bottomrule\\end{tabularx}\n\n\\begin{enumerate}\n";
  plans.forEach((p, i) => (out += `\\item \\textbf{${e(tracks[i].file)} $\\to$ ${e(tracks[i + 1].file)}}: ${e(p.presetName)}. Leave at ${mmss(p.aOutAt)}; next track at ${p.bRate}$\\times$ (${p.stretchPct}\\,\\%), pitch ${p.pitchShift} semitones, key after the change ${p.bKeyAfter}: ${e(p.keyFit.why)}. \\emph{Why:} ${e(p.why)}.\n`));
  writeFileSync(tex, out + "\\end{enumerate}\n", "utf8");
  writeFileSync(tex.replace(/\.tex$/, "_tracks.tex"), out.split("\n\n")[0] + "\n", "utf8");   // the table alone
}
