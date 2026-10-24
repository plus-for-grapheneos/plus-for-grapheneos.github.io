// Android sparse images (libsparse format: RAW and FILL chunks), so fastboot.js can flash large partition images piece
// by piece; it converts raw images bigger than the download limit in memory, which a 1.4 GB system image would not
// survive. The page needs no second copy: sparseRuns maps the raw image's zero and data blocks (one pass, in the
// worker), sparseLayout turns that map into headers plus byte ranges of the raw file, and the page composes a Blob from
// the headers and slices of the raw file.

const BLOCK = 4096;
const READ_BLOCKS = 1024; // 4 MiB per read

/**
 * Runs of all-zero and data blocks, data runs capped at maxChunkBlocks (default 4096 blocks = 16 MiB, so each piece
 * fastboot.js reads is small).
 * @param read (pos, len) => Uint8Array of the raw image; size: a multiple of 4096
 * @returns [[isData, blocks], ...]
 */
export function sparseRuns(read, size, { maxChunkBlocks = 4096 } = {}) {
  if (size % BLOCK !== 0) throw new Error(`image size ${size} is not a multiple of 4096`);
  const blocks = size / BLOCK;
  const runs = [];
  for (let b = 0; b < blocks; b += READ_BLOCKS) {
    const n = Math.min(READ_BLOCKS, blocks - b);
    const data = read(b * BLOCK, n * BLOCK);
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    for (let i = 0; i < n; i++) {
      let isData = false;
      for (let w = i * 1024, end = w + 1024; w < end; w++) if (words[w] !== 0) { isData = true; break; }
      const last = runs.at(-1);
      if (last && last[0] === isData && (!isData || last[1] < maxChunkBlocks)) last[1]++;
      else runs.push([isData, 1]);
    }
  }
  return runs;
}

/** The sparse image as parts: { bytes } for headers, { offset, length } for data taken from the raw image. */
export function sparseLayout(runs, size) {
  const header = new DataView(new ArrayBuffer(28));
  header.setUint32(0, 0xed26ff3a, true); // magic
  header.setUint16(4, 1, true); // major version
  header.setUint16(6, 0, true);
  header.setUint16(8, 28, true); // file header size
  header.setUint16(10, 12, true); // chunk header size
  header.setUint32(12, BLOCK, true);
  header.setUint32(16, size / BLOCK, true);
  header.setUint32(20, runs.length, true);
  header.setUint32(24, 0, true); // no checksum
  const parts = [{ bytes: new Uint8Array(header.buffer) }];
  let b = 0;
  for (const [isData, n] of runs) {
    const h = new DataView(new ArrayBuffer(isData ? 12 : 16));
    h.setUint16(0, isData ? 0xcac1 : 0xcac2, true);
    h.setUint32(4, n, true);
    h.setUint32(8, isData ? 12 + n * BLOCK : 16, true);
    parts.push({ bytes: new Uint8Array(h.buffer) }); // a FILL chunk's 4-byte value is 0
    if (isData) parts.push({ offset: b * BLOCK, length: n * BLOCK });
    b += n;
  }
  return parts;
}

/** Writes the whole sparse image in order through write(bytes). */
export function toSparse(read, size, write, opts) {
  for (const p of sparseLayout(sparseRuns(read, size, opts), size)) write(p.bytes ?? read(p.offset, p.length));
}
