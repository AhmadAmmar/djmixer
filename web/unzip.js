// Read the files inside a .zip, with no library. A zip ends with a "central directory": one entry per file giving
// its name, its compression method and where its data starts. Data is either stored as is (method 0) or compressed
// with DEFLATE (method 8), which every modern browser can undo with DecompressionStream("deflate-raw").
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i;

export async function audioFromZip(file) {
  const buf = await file.arrayBuffer();
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;                                         // end-of-central-directory record, signature 0x06054b50
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [], dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;      // central directory entry
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split("/").pop();
    if (!AUDIO.test(base) || base.startsWith("._") || name.includes("__MACOSX")) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else continue;                                       // other compression methods are rare for audio
    out.push(new File([bytes], base));
  }
  return out;
}

export const isZip = (f) => /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";
