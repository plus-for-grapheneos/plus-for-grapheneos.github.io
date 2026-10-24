// Runs one WebAssembly command-line tool (avbroot.wasm or afsr.wasm, wasm32-wasip1) to completion, like a CLI call.
// Must run off the page's main thread (a worker): the tools block while they work.
import { ConsoleStdout, File, OpenFile, WASI } from "../vendor/browser_wasi_shim/index.js";

/**
 * browser_wasi_shim's WASI imports, except that path_open gives the new descriptor the lowest free number, as POSIX
 * and Node's WASI do. The library appends every new descriptor, so a tool that opens thousands of files gets fd
 * numbers above 16,000, and afsr's mke2fs then crashes ("memory access out of bounds") packing the system image.
 */
export function reuseLowestFd(w) {
  const open = w.wasiImport.path_open;
  return {
    ...w.wasiImport,
    path_open(fd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, openedPtr) {
      const ret = open(fd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, openedPtr);
      if (ret !== 0) return ret;
      const last = w.fds.length - 1;
      const free = w.fds.indexOf(undefined);
      if (free !== -1 && free < last) {
        w.fds[free] = w.fds[last];
        w.fds.length = last;
        new DataView(w.inst.exports.memory.buffer).setUint32(openedPtr, free, true);
      }
      return ret;
    },
  };
}

/**
 * @param module a compiled WebAssembly.Module
 * @param args argv including the program name, e.g. ["avbroot", "ota", "verify", ...]
 * @param preopens directories the tool may use (StoredPreopen, or the library's PreopenDirectory for inputs)
 * @param onLine called with ("out" | "err", line) for each line the tool prints
 * @param trace optional (call, args, result, memory) for every WASI call, for debugging
 * @returns the tool's exit code
 */
export async function runTool(module, args, { env = {}, preopens = [], onLine = () => {}, trace } = {}) {
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => onLine("out", l)),
    ConsoleStdout.lineBuffered((l) => onLine("err", l)),
    ...preopens,
  ];
  // debug must be false explicitly: the library treats a missing value as "log every lookup".
  const w = new WASI(args, Object.entries(env).map(([k, v]) => `${k}=${v}`), fds, { debug: false });
  let imports = reuseLowestFd(w);
  if (trace) {
    imports = Object.fromEntries(Object.entries(imports).map(([name, f]) =>
      [name, (...a) => { const r = f(...a); trace(name, a, r, w.inst.exports.memory); return r; }]));
  }
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports });
  return w.start(instance);
}
