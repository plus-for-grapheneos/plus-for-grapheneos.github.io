// Read-ahead cache for the browser's storage files (OPFS FileSystemSyncAccessHandle, same methods). avbroot reads in
// 4-16 KiB pieces, millions of times per build, and each read is a browser file call; this serves small reads from
// large chunks kept in memory. Writes and truncation drop the chunks they could make stale, so a read always returns
// what the file holds.

export class CachedHandle {
  /**
   * @param handle the storage file's sync access handle
   * @param opts.chunk chunk size (default 1 MiB); opts.chunks chunks kept (default 16); opts.bypass reads at least this
   *   big go straight to the file (default 256 KiB)
   */
  constructor(handle, { chunk = 1 << 20, chunks = 16, bypass = 256 << 10 } = {}) {
    this.handle = handle;
    this.chunk = chunk;
    this.max = chunks;
    this.bypass = bypass;
    this.cache = new Map(); // chunk start -> bytes (shorter than a chunk only at the end of the file); oldest first
  }

  get(base) {
    let c = this.cache.get(base);
    if (c) {
      this.cache.delete(base); // most recently used goes last
    } else {
      const buf = new Uint8Array(this.chunk);
      let n = 0;
      while (n < buf.byteLength) {
        const k = this.handle.read(buf.subarray(n), { at: base + n });
        if (k <= 0) break;
        n += k;
      }
      c = buf.subarray(0, n);
      if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(base, c);
    return c;
  }

  read(buf, { at }) {
    if (buf.byteLength >= this.bypass) return this.handle.read(buf, { at });
    let done = 0;
    while (done < buf.byteLength) {
      const pos = at + done;
      const base = pos - (pos % this.chunk);
      const c = this.get(base);
      const off = pos - base;
      if (off >= c.byteLength) break; // end of file
      const n = Math.min(c.byteLength - off, buf.byteLength - done);
      buf.set(c.subarray(off, off + n), done);
      done += n;
    }
    return done;
  }

  write(buf, { at }) {
    const n = this.handle.write(buf, { at });
    const end = at + n;
    for (const [base, c] of this.cache) {
      // Overlapping chunks are stale; a chunk that ended at the old end of the file may now be too short.
      if ((base < end && base + this.chunk > at) || c.byteLength < this.chunk) this.cache.delete(base);
    }
    return n;
  }

  truncate(n) {
    this.handle.truncate(n);
    this.cache.clear();
  }

  getSize() { return this.handle.getSize(); }
  flush() { this.handle.flush(); }
  close() { this.cache.clear(); this.handle.close(); }
}
