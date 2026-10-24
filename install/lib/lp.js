// The super partition's table (Android liblp metadata, format 10.2), laid out as GrapheneOS's install images carry it
// (checked byte for byte against tokay-install-2026102100's super_1.img in test/lp.test.mjs): geometry at 4 KiB and
// 8 KiB, three metadata slots and their three backups, groups "default" and google_dynamic_partitions_a/_b, the _a
// partitions packed from 1 MiB on (each at a 1 MiB boundary), the _b partitions empty, all read-only. The page writes
// this table and the partition images into super from the bootloader, as GrapheneOS's installer writes its super_N.img.

import { Sha256 } from "./sha256.js";

const BLOCK = 4096;
const SECTOR = 512;
const RESERVED = 4096; // LP_PARTITION_RESERVED_BYTES: the first 4 KiB of super stay empty
const GEOMETRY_SIZE = 4096;
const METADATA_MAX = 65536;
const SLOTS = 3;
const ALIGNMENT = 1 << 20;
const GROUP_RESERVE = 4 << 20; // Pixels: dynamic partition group size = super size - 4 MiB
const ATTR_READONLY = 1;
const FLAG_VIRTUAL_AB = 1;

const PARTITION_ENTRY = 52, EXTENT_ENTRY = 24, GROUP_ENTRY = 48, BLOCK_DEVICE_ENTRY = 64, HEADER = 256;

function sha256(bytes) {
  const h = new Sha256();
  h.update(bytes);
  return h.digest();
}

function putName(view, offset, name) {
  if (name.length > 35) throw new Error(`partition name "${name}" is too long`);
  for (let i = 0; i < name.length; i++) view.setUint8(offset + i, name.charCodeAt(i));
}

const alignUp = (n, a) => Math.ceil(n / a) * a;

/**
 * @param o.superSize the super partition's size in bytes (fastboot getvar partition-size:super)
 * @param o.partitions [{ name, size }] without slot suffix, in table order; sizes in whole 4 KiB blocks
 * @returns { geometry, metadata } (4 KiB blocks), extents [{ name, offset, size }] (where each image goes in super),
 *   tableBlocks [{ offset, kind }] (where geometry and metadata copies go), end (bytes of super in use)
 */
export function lpLayout({ superSize, partitions }) {
  const groupMax = superSize - GROUP_RESERVE;
  const firstLogical = alignUp(RESERVED + 2 * GEOMETRY_SIZE + 2 * SLOTS * METADATA_MAX, ALIGNMENT);
  let used = 0;
  let next = firstLogical;
  const extents = [];
  for (const p of partitions) {
    if (p.size % BLOCK !== 0) throw new Error(`${p.name}: size ${p.size} is not a multiple of 4096`);
    extents.push({ name: p.name, offset: next, size: p.size });
    used += p.size;
    next = alignUp(next + p.size, ALIGNMENT);
  }
  const end = extents.length ? extents.at(-1).offset + extents.at(-1).size : firstLogical;
  if (used > groupMax || end > superSize) throw new Error(`the partitions (${used} bytes) do not fit the super partition`);

  // Tables: partitions (_a then _b for each), extents (one per _a partition), groups, block devices.
  const nParts = partitions.length * 2, nExt = partitions.length, nGroups = 3;
  const partOff = 0, extOff = nParts * PARTITION_ENTRY, groupOff = extOff + nExt * EXTENT_ENTRY;
  const devOff = groupOff + nGroups * GROUP_ENTRY, tablesSize = devOff + BLOCK_DEVICE_ENTRY;
  const tables = new Uint8Array(tablesSize);
  const t = new DataView(tables.buffer);
  partitions.forEach((p, i) => {
    for (const [k, suffix] of [[0, "_a"], [1, "_b"]]) {
      const o = partOff + (2 * i + k) * PARTITION_ENTRY;
      putName(t, o, p.name + suffix);
      t.setUint32(o + 36, ATTR_READONLY, true);
      t.setUint32(o + 40, k === 0 ? i : i + 1, true); // first extent index (an empty _b points past its _a's extent)
      t.setUint32(o + 44, k === 0 ? 1 : 0, true); // number of extents
      t.setUint32(o + 48, k === 0 ? 1 : 2, true); // group: google_dynamic_partitions_a / _b
    }
    const e = extOff + i * EXTENT_ENTRY;
    t.setBigUint64(e, BigInt(p.size / SECTOR), true); // sectors
    t.setUint32(e + 8, 0, true); // LP_TARGET_TYPE_LINEAR
    t.setBigUint64(e + 12, BigInt(extents[i].offset / SECTOR), true); // physical sector
    t.setUint32(e + 20, 0, true); // block device 0
  });
  [["default", 0n], ["google_dynamic_partitions_a", BigInt(groupMax)], ["google_dynamic_partitions_b", BigInt(groupMax)]]
    .forEach(([name, max], i) => {
      const o = groupOff + i * GROUP_ENTRY;
      putName(t, o, name);
      t.setBigUint64(o + 40, max, true);
    });
  t.setBigUint64(devOff, BigInt(firstLogical / SECTOR), true);
  t.setUint32(devOff + 8, ALIGNMENT, true);
  t.setUint32(devOff + 12, 0, true); // alignment offset
  t.setBigUint64(devOff + 16, BigInt(superSize), true);
  putName(t, devOff + 24, "super");

  const metadata = new Uint8Array(BLOCK);
  const h = new DataView(metadata.buffer);
  h.setUint32(0, 0x414c5030, true); // LP_METADATA_HEADER_MAGIC
  h.setUint16(4, 10, true);
  h.setUint16(6, 2, true);
  h.setUint32(8, HEADER, true);
  h.setUint32(44, tablesSize, true);
  metadata.set(sha256(tables), 48);
  [[partOff, nParts, PARTITION_ENTRY], [extOff, nExt, EXTENT_ENTRY], [groupOff, nGroups, GROUP_ENTRY], [devOff, 1, BLOCK_DEVICE_ENTRY]]
    .forEach(([off, n, size], i) => {
      h.setUint32(80 + i * 12, off, true);
      h.setUint32(84 + i * 12, n, true);
      h.setUint32(88 + i * 12, size, true);
    });
  h.setUint32(128, FLAG_VIRTUAL_AB, true);
  metadata.set(sha256(metadata.subarray(0, HEADER)), 12); // the header checksum covers the header with it zeroed
  metadata.set(tables, HEADER);
  if (HEADER + tablesSize > BLOCK) throw new Error("the partition table is larger than one block");

  const geometry = new Uint8Array(BLOCK);
  const g = new DataView(geometry.buffer);
  g.setUint32(0, 0x616c4467, true); // LP_METADATA_GEOMETRY_MAGIC
  g.setUint32(4, 52, true);
  g.setUint32(40, METADATA_MAX, true);
  g.setUint32(44, SLOTS, true);
  g.setUint32(48, BLOCK, true);
  geometry.set(sha256(geometry.subarray(0, 52)), 8);

  const tableBlocks = [{ offset: RESERVED, kind: "geometry" }, { offset: RESERVED + GEOMETRY_SIZE, kind: "geometry" }];
  for (let i = 0; i < 2 * SLOTS; i++) tableBlocks.push({ offset: RESERVED + 2 * GEOMETRY_SIZE + i * METADATA_MAX, kind: "metadata" });
  return { geometry, metadata, extents, tableBlocks, end };
}

/** The first n bytes of the disk a sparse image describes (RAW, FILL and DONT_CARE chunks; don't-care reads as 0). */
export function sparseStart(sparse, n) {
  const v = new DataView(sparse.buffer, sparse.byteOffset, sparse.byteLength);
  if (v.getUint32(0, true) !== 0xed26ff3a) throw new Error("not a sparse image");
  const fileHeader = v.getUint16(8, true), blk = v.getUint32(12, true);
  const out = new Uint8Array(n);
  let p = fileHeader, at = 0;
  while (at < n && p + 12 <= sparse.length) {
    const type = v.getUint16(p, true), blocks = v.getUint32(p + 4, true), total = v.getUint32(p + 8, true);
    const len = Math.min(blocks * blk, n - at);
    if (type === 0xcac1) out.set(sparse.subarray(p + 12, p + 12 + len), at);
    else if (type === 0xcac2) for (let k = 0; k < len; k += 4) out.set(sparse.subarray(p + 12, p + 16).subarray(0, Math.min(4, len - k)), at + k);
    else if (type !== 0xcac3) throw new Error(`unexpected sparse chunk ${type.toString(16)}`);
    at += len;
    p += total;
  }
  return out;
}

const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Reads a super partition table (geometry at 4 KiB, metadata at 12 KiB) as GrapheneOS ships it, checks both
 * checksums, and checks that lpLayout given the same partitions and sizes writes exactly the same table, so the page
 * follows GrapheneOS's layout for this phone model or refuses.
 * @returns { superSize, partitions: [{ name, size }] (the _a partitions, slot suffix removed), matchesOurLayout: true }
 */
export function readLpTable(raw) {
  const geometry = raw.subarray(RESERVED, RESERVED + BLOCK);
  const metadata = raw.subarray(RESERVED + 2 * GEOMETRY_SIZE, RESERVED + 2 * GEOMETRY_SIZE + BLOCK);
  const g = new DataView(geometry.buffer, geometry.byteOffset, BLOCK), m = new DataView(metadata.buffer, metadata.byteOffset, BLOCK);
  if (g.getUint32(0, true) !== 0x616c4467 || m.getUint32(0, true) !== 0x414c5030) throw new Error("no super partition table found");
  const zeroed = (bytes, at) => { const c = Uint8Array.from(bytes); c.fill(0, at, at + 32); return c; };
  if (!equalBytes(sha256(zeroed(geometry.subarray(0, 52), 8)), geometry.subarray(8, 40))) throw new Error("geometry checksum mismatch");
  const headerSize = m.getUint32(8, true), tablesSize = m.getUint32(44, true);
  if (!equalBytes(sha256(zeroed(metadata.subarray(0, headerSize), 12)), metadata.subarray(12, 44))) throw new Error("metadata header checksum mismatch");
  const tables = metadata.subarray(headerSize, headerSize + tablesSize);
  if (!equalBytes(sha256(tables), metadata.subarray(48, 80))) throw new Error("metadata tables checksum mismatch");
  const td = new DataView(tables.buffer, tables.byteOffset, tables.byteLength);
  const desc = (i) => [m.getUint32(80 + i * 12, true), m.getUint32(84 + i * 12, true), m.getUint32(88 + i * 12, true)];
  const [po, pn, ps] = desc(0), [eo, , es] = desc(1), [bo] = desc(3);
  const name = (o) => new TextDecoder().decode(tables.subarray(o, o + 36)).replace(/\0.*$/s, "");
  const partitions = [];
  for (let i = 0; i < pn; i++) {
    const o = po + i * ps, n = name(o), first = td.getUint32(o + 40, true), count = td.getUint32(o + 44, true);
    if (!n.endsWith("_a")) continue;
    let size = 0;
    for (let k = first; k < first + count; k++) size += Number(td.getBigUint64(eo + k * es, true)) * SECTOR;
    partitions.push({ name: n.slice(0, -2), size });
  }
  const superSize = Number(td.getBigUint64(bo + 16, true));
  const ours = lpLayout({ superSize, partitions });
  if (!equalBytes(ours.geometry, geometry) || !equalBytes(ours.metadata, metadata)) {
    throw new Error("this phone model's super layout differs from what the page writes; it can't be loaded this way yet");
  }
  return { superSize, partitions, matchesOurLayout: true };
}
