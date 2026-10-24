// The build worker: runs avbroot and afsr (WebAssembly) on the GrapheneOS file the owner picked, with all files in the
// browser's private storage (OPFS). The signed OTA and the images to load are written straight into storage files of
// their own (a pool opened before the tools start), so nothing is copied afterwards; for large images the worker maps
// the zero blocks, and the page sends them to the phone in Android's sparse format built over the raw file.
//
// in:  { type: "build", ota: File, otaBuild, device, key: { p, q } (hex), fingerprint, plus: { apk, version, sha256 }, xmls, pins }
// out: { type: "step", id } | { type: "line", text } | { type: "io", read, written } (bytes so far, twice a second)
//      | { type: "export", name, done, total }
//      | { type: "done", files: [{ name, file, size, runs? }], fastbootInfo }   (file: name under plus-setup/files/)
//      | { type: "error", step, message, lines }      (the build's files are deleted again)
import { ExtentStore, HandleFile, HandlePool, StoredDirectory, readFile } from "./lib/store.js";
import { SourceFile, blobSource } from "./lib/source.js";
import { buildFirstImage } from "./lib/build.js";
import { keyFromPrimes } from "./lib/owner.js";
import { Sha256 } from "./lib/sha256.js";
import { sparseRuns } from "./lib/sparse.js";
import { onProgress } from "./lib/progress.js";
import { CachedHandle } from "./lib/cache.js";

const OPFS_DIR = "plus-setup";
const POOL_SIZE = 48; // the images to load (about 27) and the signed OTA with its temporary file
const SPARSE_ABOVE = 64 << 20;
const post = (m) => self.postMessage(m);

async function compile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`);
  // compileStreaming needs the server to say application/wasm; not every local server does.
  return WebAssembly.compile(await res.arrayBuffer());
}

async function build(msg, open) {
  // The tools block this worker for minutes at a time; progress goes out from inside their reads and writes.
  onProgress(({ read, written }) => post({ type: "io", read, written }));
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const filesDir = await dir.getDirectoryHandle("files", { create: true });
  const storeHandle = await (await dir.getFileHandle("work.bin", { create: true })).createSyncAccessHandle();
  open.push(storeHandle);
  const entries = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const name = `f${String(i).padStart(2, "0")}`;
    const handle = await (await filesDir.getFileHandle(name, { create: true })).createSyncAccessHandle();
    open.push(handle);
    entries.push({ name, handle: new CachedHandle(handle) }); // avbroot reads in small pieces: read ahead
  }
  const pool = new HandlePool(entries);

  const [avbroot, afsr] = await Promise.all([compile("tools/avbroot.wasm"), compile("tools/afsr.wasm")]);

  // The download's SHA-256 goes into the build manifest. Read in place, never copied.
  const ota = new SourceFile(blobSource(msg.ota));
  const h = new Sha256();
  const CHUNK = 16 << 20;
  for (let p = 0; p < msg.ota.size; p += CHUNK) h.update(ota.read(p, CHUNK));

  const store = new ExtentStore(new CachedHandle(storeHandle));
  const W = await buildFirstImage({
    tools: { avbroot, afsr },
    ota, otaBuild: msg.otaBuild, otaSha256: h.hex(), device: msg.device,
    pins: msg.pins, key: keyFromPrimes(BigInt("0x" + msg.key.p), BigInt("0x" + msg.key.q)),
    plus: msg.plus, xmls: msg.xmls, root: new StoredDirectory(store), pools: { final: pool, flash: pool },
    onStep: (id) => post({ type: "step", id }),
    onLine: (_, text) => post({ type: "line", text }),
  });

  // Each image is already in a storage file of its own; map the zero blocks of the large ones for sparse sending.
  const flash = W.path_lookup("flash", 0).inode_obj;
  const names = Array.from(flash.contents.keys());
  const files = [];
  for (const [i, name] of names.entries()) {
    post({ type: "export", name, done: i, total: names.length });
    let f = flash.contents.get(name);
    let file = f.poolName;
    if (!(f instanceof HandleFile)) {
      // The pool ran out (more images than expected): copy this one out into a storage file of its own.
      file = `x-${name}`;
      const out = await (await filesDir.getFileHandle(file, { create: true })).createSyncAccessHandle();
      open.push(out);
      for (let p = 0; p < f.size; p += CHUNK) out.write(f.read(p, CHUNK), { at: p });
      out.flush();
    }
    const runs = name.endsWith(".img") && f.size > SPARSE_ABOVE ? sparseRuns((p, n) => f.read(p, n), f.size) : undefined;
    files.push({ name, file, size: f.size, runs });
  }
  const fastbootInfo = new TextDecoder().decode(readFile(W, "flash/fastboot-info.txt"));
  return { files, fastbootInfo, used: new Set(files.map((f) => f.file)) };
}

self.onmessage = async (e) => {
  if (e.data.type !== "build") return;
  const open = [];
  const closeAll = () => { for (const h of open) { try { h.flush(); h.close(); } catch { /* already closed */ } } };
  let result;
  try {
    result = await build(e.data, open);
  } catch (err) {
    closeAll();
    // Give the space back: a failed build leaves nothing behind.
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
    post({ type: "error", step: err.step ?? "", message: err.message ?? String(err), lines: err.lines ?? [] });
    return;
  }
  closeAll();
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR);
  await dir.removeEntry("work.bin").catch(() => {});
  const filesDir = await dir.getDirectoryHandle("files");
  for await (const name of filesDir.keys()) if (!result.used.has(name)) await filesDir.removeEntry(name).catch(() => {});
  // What the page needs to continue after a reload: the key itself is never stored, only its fingerprint, so the
  // owner pastes the backup and the page checks it is the key this build was signed with.
  const saved = { device: e.data.device, otaBuild: e.data.otaBuild, fingerprint: e.data.fingerprint,
    files: result.files, fastbootInfo: result.fastbootInfo, created: new Date().toISOString() };
  const meta = await (await dir.getFileHandle("build.json", { create: true })).createSyncAccessHandle();
  meta.truncate(0);
  meta.write(new TextEncoder().encode(JSON.stringify(saved)), { at: 0 });
  meta.flush();
  meta.close();
  post({ type: "done", files: result.files, fastbootInfo: result.fastbootInfo });
};
