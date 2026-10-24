// Minimal zip reader for APKs held in memory (the +PLUS APK, a few MB): the central directory, stored and deflated
// entries (deflate through the browser's DecompressionStream), CRC-checked. No zip64: APKs are far below 4 GB.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @returns [{ name, size, dataOffset, bytes(): Promise<Uint8Array> }] in central-directory order */
export function readZip(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = names.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const dataOffset = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    entries.push({
      name, size, dataOffset,
      async bytes() {
        const raw = zip.subarray(dataOffset, dataOffset + compSize);
        const data = method === 0 ? raw.slice() : method === 8 ? await inflate(raw) : null;
        if (data == null) throw new Error(`${name}: unsupported compression ${method}`);
        if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: CRC mismatch (damaged file)`);
        return data;
      },
    });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return entries;
}
