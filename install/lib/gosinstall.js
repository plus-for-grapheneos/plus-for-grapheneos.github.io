// GrapheneOS's install package (<device>-install-<build>.zip on releases.grapheneos.org), read with range requests: the
// page takes from it only what its own installer uses and +PLUS can't make itself: script.txt (the steps, run by
// lib/flash.js), android-info.txt (the requirements), the bootloader and radio firmware packs (about 160 MB), and the
// partition table at the start of super_1.img (the template the page's super follows). The firmware packs are checked
// against the pieces of the signed update file the owner picked before anything is written to the phone.

import { crc32 } from "./zip.js";

const TRIES = 5;

/** One byte range, checked for length, retried on network errors and short answers (waits 1, 2, 4, 8 s). */
async function get(zip, start, end) {
  const sleep = zip.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const r = await zip.fetch(zip.url, { headers: { Range: `bytes=${start}-${end}` } });
      if (r.status === 404) throw Object.assign(new Error("GrapheneOS's server no longer has this release"), { final: true });
      if (r.status !== 206) throw new Error(`GrapheneOS's server answered ${r.status} instead of a part of the file`);
      const body = new Uint8Array(await r.arrayBuffer());
      if (body.length !== end - start + 1) throw new Error(`GrapheneOS's server sent ${body.length} of ${end - start + 1} bytes`);
      return body;
    } catch (e) {
      if (e.final) throw e;
      last = e;
    }
  }
  throw new Error(`downloading from GrapheneOS's server failed ${TRIES} times (${last.message}); check the network and press Connect again`);
}

/** A long range in pieces of at most zip.chunk bytes, with progress. */
async function getLong(zip, start, length, onProgress) {
  const out = new Uint8Array(length);
  for (let pos = 0; pos < length; pos += zip.chunk) {
    const n = Math.min(zip.chunk, length - pos);
    out.set(await get(zip, start + pos, start + pos + n - 1), pos);
    onProgress?.((pos + n) / length);
  }
  return out;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** @returns { url, entries: [{ name, method, compressedSize, size, crc, localOffset }], find(nameOrRegExp) } */
export async function openRemoteZip(url, { fetch = globalThis.fetch.bind(globalThis), chunk = 8 << 20, sleep } = {}) {
  // From a web page only plain "bytes=a-b" ranges go without a CORS preflight (which the server refuses), and
  // Content-Range isn't readable, so: the size from HEAD (Content-Length is), then a plain range for the tail.
  let head;
  try {
    head = await fetch(url, { method: "HEAD" });
  } catch (e) {
    throw new Error(`GrapheneOS's server can't be reached (${e.message}); check the network`);
  }
  if (head.status === 404) throw new Error("GrapheneOS's server no longer has this release");
  if (!head.ok) throw new Error(`GrapheneOS's server answered ${head.status}`);
  const total = Number(head.headers.get("content-length"));
  if (!(total > 22)) throw new Error("GrapheneOS's server didn't say how big the install package is");
  const tailStart = Math.max(0, total - 131072);
  const tail = await get({ url, fetch, sleep }, tailStart, total - 1);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("GrapheneOS's install package has no file list");
  let cdSize = u32(tail, e + 12), cdOffset = u32(tail, e + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = e - 20; // zip64 end-of-directory locator
    if (u32(tail, loc) !== 0x07064b50) throw new Error("zip64 locator missing");
    const z = u64(tail, loc + 8) - tailStart;
    cdSize = u64(tail, z + 40);
    cdOffset = u64(tail, z + 48);
  }
  const zip = { url, fetch, chunk, sleep, entries: [] };
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await get(zip, cdOffset, cdOffset + cdSize - 1);
  for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50;) {
    const n = u16(cd, p + 28), x = u16(cd, p + 30), c = u16(cd, p + 32);
    const entry = { name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + n)), method: u16(cd, p + 10), crc: u32(cd, p + 16),
      compressedSize: u32(cd, p + 20), size: u32(cd, p + 24), localOffset: u32(cd, p + 42) };
    for (let q = p + 46 + n; q < p + 46 + n + x;) { // zip64 extra field: the 0xffffffff values, in order
      const id = u16(cd, q), len = u16(cd, q + 2);
      if (id === 1) {
        let r = q + 4;
        for (const k of ["size", "compressedSize", "localOffset"]) if (entry[k] === 0xffffffff) { entry[k] = u64(cd, r); r += 8; }
      }
      q += 4 + len;
    }
    zip.entries.push(entry);
    p += 46 + n + x + c;
  }
  zip.find = (want) => {
    const hit = zip.entries.find((x) => (typeof want === "string" ? x.name.endsWith(`/${want}`) || x.name === want : want.test(x.name)));
    if (!hit) throw new Error(`GrapheneOS's install package has no ${want}`);
    return hit;
  };
  return zip;
}

async function dataStart(zip, entry) {
  const h = await get(zip, entry.localOffset, entry.localOffset + 29);
  if (u32(h, 0) !== 0x04034b50) throw new Error(`${entry.name}: bad local header`);
  return entry.localOffset + 30 + u16(h, 26) + u16(h, 28);
}

/** The whole entry, downloaded in pieces (onProgress(0..1)), inflated and CRC-checked. */
export async function readEntry(zip, entry, onProgress) {
  const start = await dataStart(zip, entry);
  const comp = entry.compressedSize ? await getLong(zip, start, entry.compressedSize, onProgress) : new Uint8Array(0);
  let data;
  if (entry.method === 0) data = comp;
  else if (entry.method === 8) {
    try {
      const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw new Error(`${entry.name} is damaged (${e.message})`);
    }
  } else throw new Error(`${entry.name}: compression method ${entry.method} is not supported`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`${entry.name} is damaged (CRC)`);
  return data;
}

/** The first n bytes of a deflated entry, reading only as much of the download as that needs. */
export async function readEntryStart(zip, entry, n) {
  const start = await dataStart(zip, entry);
  if (entry.method === 0) return getLong(zip, start, n);
  const step = Math.min(zip.chunk, 256 << 10);
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter(), reader = ds.readable.getReader();
  const out = [];
  let have = 0, pos = 0, failure = null;
  // Feeds the compressed bytes; ends the stream when done or when a download fails, so the reader never waits forever.
  const pump = (async () => {
    for (; pos < entry.compressedSize && have < n; pos += step) {
      await writer.write(await get(zip, start + pos, start + Math.min(pos + step, entry.compressedSize) - 1));
    }
  })().then(() => writer.close(), (e) => { failure = e; return writer.abort(e); }).catch(() => {});
  try {
    while (have < n) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
      have += value.length;
    }
  } catch (e) {
    throw failure ?? new Error(`${entry.name} is damaged (${e.message})`);
  } finally {
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    await pump;
  }
  if (failure && have < n) throw failure;
  const all = new Uint8Array(have);
  let o = 0;
  for (const c of out) { all.set(c, o); o += c.length; }
  if (have < n) throw new Error(`${entry.name} is shorter than ${n} bytes`);
  return all.subarray(0, n);
}

/** script.txt as [[command, ...args]]; run-cmd keeps the rest of the line as one argument. */
export function parseScript(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    out.push(words[0] === "run-cmd" ? ["run-cmd", line.slice("run-cmd".length).trim()] : words);
  }
  return out;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Checks the firmware packs against the signed update file: every slot firmware entry of the bootloader pack (FBPK v2)
 * must equal that partition's image from the update file, and the radio pack (FBPK v1) must end with its modem image.
 * The remaining bootloader-pack entries (storage chip setup: ufs, partition tables, ufs firmware) are not in the update
 * file; they come from GrapheneOS's server over HTTPS, as for GrapheneOS's own installer.
 * @param o.otaImage async (name) => Uint8Array | undefined, the partition image extracted from the signed update file
 * @returns { bootloaderVersion, checked: [names] }
 */
export async function checkFirmware({ bootloader, radio, otaImage }) {
  const checked = [];
  let bootloaderVersion;
  if (bootloader) {
    if (new TextDecoder().decode(bootloader.subarray(0, 4)) !== "FBPK" || u32(bootloader, 4) !== 2) throw new Error("the bootloader pack is not FBPK version 2");
    const hsz = u32(bootloader, 8), esz = u32(bootloader, 12), count = u32(bootloader, 104);
    bootloaderVersion = new TextDecoder().decode(bootloader.subarray(32, 96)).replace(/\0.*$/s, "");
    for (let i = 0; i < count; i++) {
      const o = hsz + i * esz;
      const name = new TextDecoder().decode(bootloader.subarray(o + 4, o + 80)).replace(/\0.*$/s, "");
      const off = u64(bootloader, o + 80), size = u64(bootloader, o + 88), slotted = u32(bootloader, o + 96) === 1;
      if (!slotted) continue;
      const ota = await otaImage(name);
      if (!ota) throw new Error(`the bootloader pack has ${name}, which the update file doesn't have`);
      if (!same(bootloader.subarray(off, off + size), ota)) throw new Error(`the bootloader pack's ${name} differs from the update file's`);
      checked.push(name);
    }
    if (checked.length === 0) throw new Error("the bootloader pack has no slot firmware to check");
  }
  if (radio) {
    if (new TextDecoder().decode(radio.subarray(0, 4)) !== "FBPK" || u32(radio, 4) !== 1) throw new Error("the radio pack is not FBPK version 1");
    const modem = await otaImage("modem");
    if (!modem || !same(radio.subarray(radio.length - modem.length), modem)) throw new Error("the radio pack's modem differs from the update file's");
    checked.push("modem");
  }
  return { bootloaderVersion, checked };
}
