// Counts the bytes the WebAssembly tools read and write, so the page can show a long step moving (the tools print
// nothing for minutes). They block the worker while they run, so a report can only be sent from inside a read or a
// write; it goes out at most once per interval.

export const io = { read: 0, written: 0 };

let report = null;
let interval = 500;
let clock = () => performance.now();
let last = -Infinity;

/** Sets the reporter: fn({ read, written }) or null. Options for tests: interval (ms), clock. */
export function onProgress(fn, opts = {}) {
  report = fn;
  interval = opts.interval ?? 500;
  clock = opts.clock ?? (() => performance.now());
  last = -Infinity;
}

function tick() {
  if (!report) return;
  const now = clock();
  if (now - last < interval) return;
  last = now;
  report({ read: io.read, written: io.written });
}

export function countRead(n) { io.read += n; tick(); }
export function countWrite(n) { io.written += n; tick(); }
