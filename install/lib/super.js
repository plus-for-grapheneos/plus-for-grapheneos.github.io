// The whole super partition as sparse images no bigger than the phone's download limit, the way GrapheneOS ships
// super_1.img ... super_N.img: every piece describes all of super, writes its own part, and marks the rest
// "don't care". Flashed one after another to "super" from the bootloader, they write the partition table (lib/lp.js)
// and each partition image at its offset. No fastbootd. Pieces are lists of parts: { bytes } (headers, table blocks)
// or { name, offset, length } (a range of that partition image), so the page builds each piece as a Blob of slices.

const BLOCK = 4096;
const FILE_HEADER = 28, CHUNK_HEADER = 12;
const RAW = 0xcac1, FILL = 0xcac2, SKIP = 0xcac3;
const MAX_RAW_BLOCKS = 4096; // 16 MiB per data chunk

function chunkHeader(type, blocks, payload) {
  const h = new DataView(new ArrayBuffer(type === FILL ? 16 : CHUNK_HEADER));
  h.setUint16(0, type, true);
  h.setUint32(4, blocks, true);
  h.setUint32(8, CHUNK_HEADER + payload, true);
  return new Uint8Array(h.buffer); // a FILL chunk's value stays 0
}

const chunkBytes = (c) => CHUNK_HEADER + (c.type === RAW ? c.blocks * BLOCK : c.type === FILL ? 4 : 0);

/** Super as chunks in block order: { block, blocks, type, data? }; data = { bytes } or { name, offset }. */
function chunksOf(layout, images) {
  const chunks = [];
  let at = 0;
  const skipTo = (block) => { if (block > at) chunks.push({ block: at, blocks: block - at, type: SKIP }); at = block; };
  const raw = (block, blocks, data) => { skipTo(block); chunks.push({ block, blocks, type: RAW, data }); at = block + blocks; };
  chunks.push({ block: 0, blocks: 1, type: FILL }); // the reserved first 4 KiB, zeroed as in GrapheneOS's image
  at = 1;
  for (const t of layout.tableBlocks) raw(t.offset / BLOCK, 1, { bytes: t.kind === "geometry" ? layout.geometry : layout.metadata });
  for (const e of layout.extents) {
    const runs = images[e.name]?.runs ?? [[true, e.size / BLOCK]];
    let b = e.offset / BLOCK;
    skipTo(b);
    for (const [isData, n] of runs) {
      if (!isData) { chunks.push({ block: b, blocks: n, type: FILL }); b += n; at = b; continue; }
      for (let done = 0; done < n; done += MAX_RAW_BLOCKS) {
        const k = Math.min(MAX_RAW_BLOCKS, n - done);
        raw(b, k, { name: e.name, offset: (b - e.offset / BLOCK) * BLOCK });
        b += k;
      }
    }
    if (b * BLOCK !== e.offset + e.size) throw new Error(`${e.name}: the block map does not cover the image`);
  }
  return { chunks, total: Math.ceil(layout.end / BLOCK) };
}

function splitRaw(c, blocks) {
  const head = { ...c, blocks, data: c.data.bytes ? { bytes: c.data.bytes.subarray(0, blocks * BLOCK) } : c.data };
  const tail = { ...c, block: c.block + blocks, blocks: c.blocks - blocks,
    data: c.data.bytes ? { bytes: c.data.bytes.subarray(blocks * BLOCK) } : { ...c.data, offset: c.data.offset + blocks * BLOCK } };
  return [head, tail];
}

/**
 * @param o.layout lpLayout(...); o.images { name: { runs? } } (runs: sparseRuns of the image, else all data)
 * @param o.maxBytes the phone's max-download-size
 * @returns pieces: [[{ bytes } | { name, offset, length }, ...], ...], each with .diskBytes (whole disk it describes)
 */
export function superPieces({ layout, images, maxBytes }) {
  const { chunks, total } = chunksOf(layout, images);
  // Room in a piece besides its chunks: file header, a leading and a trailing "don't care".
  const room = maxBytes - FILE_HEADER - 2 * CHUNK_HEADER;
  if (room < CHUNK_HEADER + BLOCK) throw new Error(`a download limit of ${maxBytes} bytes is too small`);
  const groups = [];
  let cur = [], size = 0;
  const queue = chunks.filter((c) => c.type !== SKIP);
  // A chunk that doesn't start where the previous one in the same piece ended needs a "don't care" between them.
  const gap = (c) => (cur.length && c.block !== cur.at(-1).block + cur.at(-1).blocks ? CHUNK_HEADER : 0);
  for (let i = 0; i < queue.length; i++) {
    let c = queue[i];
    if (size + gap(c) + chunkBytes(c) > room) {
      if (c.type === RAW) {
        const fit = Math.floor((room - size - gap(c) - CHUNK_HEADER) / BLOCK);
        if (fit > 0) { const [head, tail] = splitRaw(c, fit); size += gap(head); cur.push(head); queue.splice(i + 1, 0, tail); c = null; }
      }
      if (cur.length) groups.push(cur);
      cur = [], size = 0;
      if (c === null) continue;
    }
    size += gap(c) + chunkBytes(c);
    cur.push(c);
  }
  if (cur.length) groups.push(cur);

  return groups.map((g) => {
    const body = [];
    if (g[0].block > 0) body.push({ type: SKIP, blocks: g[0].block });
    for (let i = 0; i < g.length; i++) {
      body.push(g[i]);
      const end = g[i].block + g[i].blocks, next = i + 1 < g.length ? g[i + 1].block : total;
      if (next > end) body.push({ type: SKIP, blocks: next - end });
    }
    const header = new DataView(new ArrayBuffer(FILE_HEADER));
    header.setUint32(0, 0xed26ff3a, true);
    header.setUint16(4, 1, true);
    header.setUint16(8, FILE_HEADER, true);
    header.setUint16(10, CHUNK_HEADER, true);
    header.setUint32(12, BLOCK, true);
    header.setUint32(16, total, true);
    header.setUint32(20, body.length, true);
    const parts = [{ bytes: new Uint8Array(header.buffer) }];
    for (const c of body) {
      parts.push({ bytes: chunkHeader(c.type, c.blocks, c.type === RAW ? c.blocks * BLOCK : c.type === FILL ? 4 : 0) });
      if (c.type === RAW) parts.push(c.data.bytes ? { bytes: c.data.bytes } : { name: c.data.name, offset: c.data.offset, length: c.blocks * BLOCK });
    }
    parts.diskBytes = total * BLOCK; // the disk size the piece describes (fastboot.js measures progress against it)
    return parts;
  });
}
