// Storage for the files avbroot and afsr create while building an image (several GB: unpacked partitions, trees of
// thousands of files, the signed OTA). Too big for memory, so every file's data lives in ONE storage file opened once
// before the tools start: in the browser an OPFS FileSystemSyncAccessHandle, in tests a Node file. Its space is handed
// out in fixed-size extents, so creating, growing and deleting files stays synchronous, as WASI calls must be.
//
// Plugs into browser_wasi_shim (vendor/) through its Inode/Fd classes: StoredDirectory creates StoredFile and
// StoredDirectory entries instead of the library's in-memory File/Directory.
import { Fd, Inode } from "../vendor/browser_wasi_shim/fd.js";
import { Directory, OpenDirectory } from "../vendor/browser_wasi_shim/fs_mem.js";
import * as wasi from "../vendor/browser_wasi_shim/wasi_defs.js";
import { countRead, countWrite } from "./progress.js";

const HOLE = -1;

/** Hands out extents of one storage file; freed extents are reused before the file grows. */
export class ExtentStore {
  constructor(handle, { extent = 64 * 1024 } = {}) {
    this.handle = handle;
    this.extent = extent;
    this.free = [];
    this.next = 0;
    this.used = new Uint8Array(1024);
    this.zeros = new Uint8Array(extent);
  }
  get extentsInStore() { return this.next; }
  get extentsInUse() { return this.next - this.free.length; }
  alloc() {
    const e = this.free.length ? this.free.pop() : this.next++;
    if (e >= this.used.length) {
      const bigger = new Uint8Array(Math.max(e + 1, this.used.length * 2));
      bigger.set(this.used);
      this.used = bigger;
    }
    this.used[e] = 1;
    return e;
  }
  release(e) { this.used[e] = 0; this.free.push(e); }
  /** Truncates the storage file after the last extent still in use (the browser counts its full size against quota). */
  shrink() {
    let n = this.next;
    while (n > 0 && !this.used[n - 1]) n--;
    if (n === this.next) return;
    this.next = n;
    this.free = this.free.filter((e) => e < n);
    this.handle.truncate(n * this.extent);
  }
  read(dest, at) {
    for (let done = 0; done < dest.byteLength;) {
      const n = this.handle.read(dest.subarray(done), { at: at + done });
      if (n <= 0) break; // never written: stays zero
      done += n;
    }
  }
  write(src, at) {
    for (let done = 0; done < src.byteLength;) done += this.handle.write(src.subarray(done), { at: at + done });
  }
}

/** WASI's filestat, written at the offsets WASI defines (the library's own write_bytes puts the times at 38/46/52). */
class Stat extends wasi.Filestat {
  constructor(ino, filetype, size, nlink, atim, mtim) {
    super(ino, filetype, size);
    this.nlink = nlink;
    this.atim = atim;
    this.mtim = mtim;
    this.ctim = mtim;
  }
  write_bytes(view, ptr) {
    view.setBigUint64(ptr, this.dev, true);
    view.setBigUint64(ptr + 8, this.ino, true);
    view.setUint8(ptr + 16, this.filetype);
    view.setBigUint64(ptr + 24, this.nlink, true);
    view.setBigUint64(ptr + 32, this.size, true);
    view.setBigUint64(ptr + 40, this.atim, true);
    view.setBigUint64(ptr + 48, this.mtim, true);
    view.setBigUint64(ptr + 56, this.ctim, true);
  }
}

const nowNs = () => BigInt(Date.now()) * 1000000n;

export class StoredFile extends Inode {
  constructor(store) {
    super();
    this.store = store;
    this.map = new Int32Array(16).fill(HOLE); // file extent i -> store extent
    this.size = 0;
    this.links = 0; // names pointing at this file
    this.opens = 0; // open descriptors
    this.atim = this.mtim = nowNs();
  }

  read(pos, len) {
    const E = this.store.extent;
    const end = Math.min(this.size, pos + len);
    const out = new Uint8Array(Math.max(0, end - pos));
    for (let p = pos; p < end;) {
      // One storage read per run of consecutive extents.
      const first = Math.floor(p / E);
      let last = first;
      const ext = this.map[first] ?? HOLE;
      while (ext !== HOLE && (last + 1) * E < end && this.map[last + 1] === ext + (last + 1 - first)) last++;
      const runEnd = Math.min(end, (last + 1) * E);
      if (ext !== HOLE) this.store.read(out.subarray(p - pos, runEnd - pos), ext * E + (p - first * E));
      p = runEnd;
    }
    countRead(out.byteLength);
    return out;
  }

  write(pos, data) {
    const E = this.store.extent;
    for (let done = 0; done < data.byteLength;) {
      const p = pos + done;
      const i = Math.floor(p / E);
      const off = p - i * E;
      const n = Math.min(E - off, data.byteLength - done);
      this.ensure(i + 1);
      if (this.map[i] === HOLE) {
        this.map[i] = this.store.alloc();
        // A reused extent holds another file's old bytes: clear what this write doesn't cover.
        if (n < E) this.store.write(this.store.zeros, this.map[i] * E);
      }
      this.store.write(data.subarray(done, done + n), this.map[i] * E + off);
      done += n;
    }
    this.size = Math.max(this.size, pos + data.byteLength);
    this.mtim = nowNs();
    countWrite(data.byteLength);
  }

  setSize(n) {
    const E = this.store.extent;
    if (n < this.size) {
      const keep = Math.ceil(n / E);
      for (let i = keep; i < this.map.length; i++) {
        if (this.map[i] !== HOLE) { this.store.release(this.map[i]); this.map[i] = HOLE; }
      }
      // Bytes past the new end must read as zeros if the file grows again.
      const tail = n - (keep - 1) * E;
      if (n % E !== 0 && this.map[keep - 1] !== HOLE) {
        this.store.write(this.store.zeros.subarray(tail), this.map[keep - 1] * E + tail);
      }
    }
    this.size = n;
    this.mtim = nowNs();
  }

  /** The highest storage extent this file uses, or -1. */
  lastExtent() { return this.map.reduce((m, e) => Math.max(m, e), -1); }

  ensure(count) {
    if (count <= this.map.length) return;
    const bigger = new Int32Array(Math.max(count, this.map.length * 2)).fill(HOLE);
    bigger.set(this.map);
    this.map = bigger;
  }

  setTimes(atim, mtim, flags) {
    if (flags & wasi.FSTFLAGS_ATIM) this.atim = atim;
    if (flags & wasi.FSTFLAGS_ATIM_NOW) this.atim = nowNs();
    if (flags & wasi.FSTFLAGS_MTIM) this.mtim = mtim;
    if (flags & wasi.FSTFLAGS_MTIM_NOW) this.mtim = nowNs();
  }

  /** Frees the data once no name and no open descriptor refers to it (POSIX delete-while-open). */
  releaseIfUnused() {
    if (this.links > 0 || this.opens > 0) return;
    this.setSize(0);
  }

  path_open(oflags, fs_rights_base, fd_flags) {
    if ((oflags & wasi.OFLAGS_TRUNC) === wasi.OFLAGS_TRUNC) this.setSize(0);
    this.opens++;
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new StoredFd(this, fd_flags) };
  }

  stat() {
    return new Stat(this.ino, wasi.FILETYPE_REGULAR_FILE, BigInt(this.size), BigInt(this.links), this.atim, this.mtim);
  }
}

/** Storage files opened ahead of time, handed out to files created in a directory whose `pool` is set. */
export class HandlePool {
  /** entries: [{ name, handle }], each handle a FileSystemSyncAccessHandle (or the same methods) */
  constructor(entries) { this.free = [...entries]; }
  take() { return this.free.shift() ?? null; }
  give(entry) { this.free.push(entry); }
}

/**
 * A file with its own storage file from a HandlePool instead of extents of the work file: the signed OTA and the
 * images to load, which the page then reads directly (no copy). Deleting it empties the storage file and returns it.
 */
export class HandleFile extends StoredFile {
  constructor(entry, pool) {
    super(null);
    this.entry = entry;
    this.pool = pool;
    this.poolName = entry.name;
    this.released = false;
    entry.handle.truncate(0);
  }
  read(pos, len) {
    const out = new Uint8Array(Math.max(0, Math.min(this.size, pos + len) - pos));
    for (let done = 0; done < out.byteLength;) {
      const n = this.entry.handle.read(out.subarray(done), { at: pos + done });
      if (n <= 0) break; // past what was written: zeros
      done += n;
    }
    countRead(out.byteLength);
    return out;
  }
  write(pos, data) {
    for (let done = 0; done < data.byteLength;) done += this.entry.handle.write(data.subarray(done), { at: pos + done });
    this.size = Math.max(this.size, pos + data.byteLength);
    this.mtim = nowNs();
    countWrite(data.byteLength);
  }
  setSize(n) {
    this.entry.handle.truncate(n);
    this.size = n;
    this.mtim = nowNs();
  }
  lastExtent() { return -1; }
  releaseIfUnused() {
    if (this.links > 0 || this.opens > 0 || this.released) return;
    this.released = true;
    this.entry.handle.truncate(0);
    this.size = 0;
    this.pool.give(this.entry);
  }
}

class StoredFd extends Fd {
  constructor(file, fdflags) {
    super();
    this.file = file;
    this.fdflags = fdflags;
    this.pos = 0;
    this.closed = false;
  }
  fd_fdstat_get() {
    const s = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, this.fdflags);
    return { ret: wasi.ERRNO_SUCCESS, fdstat: s };
  }
  fd_fdstat_set_flags(flags) { this.fdflags = flags; return wasi.ERRNO_SUCCESS; }
  fd_filestat_get() { return { ret: wasi.ERRNO_SUCCESS, filestat: this.file.stat() }; }
  fd_filestat_set_size(size) { this.file.setSize(Number(size)); return wasi.ERRNO_SUCCESS; }
  fd_filestat_set_times(atim, mtim, flags) { this.file.setTimes(atim, mtim, flags); return wasi.ERRNO_SUCCESS; }
  fd_allocate(offset, len) {
    const end = Number(offset + len);
    if (end > this.file.size) this.file.setSize(end);
    return wasi.ERRNO_SUCCESS;
  }
  fd_read(size) {
    const data = this.file.read(this.pos, size);
    this.pos += data.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, data };
  }
  fd_pread(size, offset) { return { ret: wasi.ERRNO_SUCCESS, data: this.file.read(Number(offset), size) }; }
  fd_write(data) {
    if (this.fdflags & wasi.FDFLAGS_APPEND) this.pos = this.file.size;
    this.file.write(this.pos, data);
    this.pos += data.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }
  fd_pwrite(data, offset) {
    this.file.write(Number(offset), data);
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }
  fd_seek(offset, whence) {
    const base = whence === wasi.WHENCE_SET ? 0 : whence === wasi.WHENCE_CUR ? this.pos
      : whence === wasi.WHENCE_END ? this.file.size : NaN;
    const to = base + Number(offset);
    if (!(to >= 0)) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.pos = to;
    return { ret: wasi.ERRNO_SUCCESS, offset: BigInt(to) };
  }
  fd_tell() { return { ret: wasi.ERRNO_SUCCESS, offset: BigInt(this.pos) }; }
  fd_sync() { return wasi.ERRNO_SUCCESS; }
  fd_close() {
    if (!this.closed) {
      this.closed = true;
      this.file.opens--;
      this.file.releaseIfUnused();
    }
    return wasi.ERRNO_SUCCESS;
  }
}

/** The library's path rules (its Path class isn't exported): relative only, ".." can't leave the directory. */
function parsePath(str) {
  if (str.startsWith("/")) return { ret: wasi.ERRNO_NOTCAPABLE, path: null };
  if (str.includes("\0")) return { ret: wasi.ERRNO_INVAL, path: null };
  const parts = [];
  for (const c of str.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") { if (parts.pop() === undefined) return { ret: wasi.ERRNO_NOTCAPABLE, path: null }; continue; }
    parts.push(c);
  }
  return { ret: wasi.ERRNO_SUCCESS, path: { parts, is_dir: str.endsWith("/") } };
}

export class StoredDirectory extends Directory {
  constructor(store, contents = new Map()) {
    super(contents);
    this.store = store;
  }
  path_open() { return { ret: wasi.ERRNO_SUCCESS, fd_obj: new StoredOpenDirectory(this) }; }
  create_entry_for_path(path_str, is_dir) {
    const { ret, path } = parsePath(path_str);
    if (path == null) return { ret, entry: null };
    const found = this.get_parent_dir_and_entry_for_path(path, true);
    if (found.parent_entry == null || found.filename == null) return { ret: found.ret, entry: null };
    if (found.entry != null) return { ret: wasi.ERRNO_EXIST, entry: null };
    const pooled = !is_dir && found.parent_entry.pool?.take();
    const entry = is_dir ? new StoredDirectory(this.store)
      : pooled ? new HandleFile(pooled, found.parent_entry.pool) : new StoredFile(this.store);
    if (is_dir) entry.parent = found.parent_entry;
    else entry.links = 1;
    found.parent_entry.contents.set(found.filename, entry);
    return { ret: wasi.ERRNO_SUCCESS, entry };
  }
}

class StoredOpenDirectory extends OpenDirectory {
  lookup(path) { return this.path_lookup(path, 0).inode_obj; }
  // POSIX: O_EXCL means something only with O_CREAT. The library refuses any existing file when O_EXCL is set, but
  // e2fsprogs' mke2fs opens the image it writes with O_EXCL alone (exclusive open, ignored for regular files).
  path_open(dirflags, path, oflags, rights_base, rights_inheriting, fd_flags) {
    if ((oflags & wasi.OFLAGS_EXCL) && !(oflags & wasi.OFLAGS_CREAT)) oflags &= ~wasi.OFLAGS_EXCL;
    return super.path_open(dirflags, path, oflags, rights_base, rights_inheriting, fd_flags);
  }
  path_unlink_file(path) {
    const entry = this.lookup(path);
    const ret = super.path_unlink_file(path);
    if (ret === wasi.ERRNO_SUCCESS && entry instanceof StoredFile) { entry.links--; entry.releaseIfUnused(); }
    return ret;
  }
  // path_rename = path_unlink(old) + path_link(new); a failed link puts the inode back with path_link.
  path_unlink(path) {
    const r = super.path_unlink(path);
    if (r.ret === wasi.ERRNO_SUCCESS && r.inode_obj instanceof StoredFile) r.inode_obj.links--;
    return r;
  }
  path_link(path, inode, allow_dir) {
    const replaced = this.lookup(path);
    const ret = super.path_link(path, inode, allow_dir);
    if (ret !== wasi.ERRNO_SUCCESS) return ret;
    if (inode instanceof StoredFile) inode.links++;
    if (inode instanceof StoredDirectory) inode.parent = this.dir;
    if (replaced instanceof StoredFile && replaced !== inode) { replaced.links--; replaced.releaseIfUnused(); }
    return ret;
  }
  path_filestat_set_times(flags, path, atim, mtim, fst_flags) {
    const entry = this.lookup(path);
    if (entry == null) return wasi.ERRNO_NOENT;
    if (entry instanceof StoredFile) entry.setTimes(atim, mtim, fst_flags);
    return wasi.ERRNO_SUCCESS;
  }
  fd_filestat_set_times() { return wasi.ERRNO_SUCCESS; }
}

/** A stored directory given to a program as a preopened path, such as /work. */
export class StoredPreopen extends StoredOpenDirectory {
  constructor(name, dir) {
    super(dir);
    this.prestat_name = name;
  }
  fd_prestat_get() { return { ret: wasi.ERRNO_SUCCESS, prestat: wasi.Prestat.dir(this.prestat_name) }; }
}

// ---- Direct access for the page itself (the edit step, results, cleanup between steps)

const ALL_RIGHTS = 0xffffffffn;

/** Writes (replaces) a file, creating missing parent directories. */
export function writeFile(dir, path, bytes) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) dir.path_create_directory(parts.slice(0, i).join("/"));
  const { ret, fd_obj } = dir.path_open(0, path, wasi.OFLAGS_CREAT | wasi.OFLAGS_TRUNC, ALL_RIGHTS, ALL_RIGHTS, 0);
  if (ret !== wasi.ERRNO_SUCCESS) throw new Error(`cannot write ${path} (WASI error ${ret})`);
  fd_obj.fd_write(bytes);
  fd_obj.fd_close();
}

/** A file's whole content, or null if there is no such file. For small files (TOML, results). */
export function readFile(dir, path) {
  const f = dir.path_lookup(path, 0).inode_obj;
  return f instanceof StoredFile ? f.read(0, f.size) : null;
}

/** Deletes a file or a whole directory tree and frees its space; nothing happens if it doesn't exist. */
export function removePath(dir, path) {
  const entry = dir.path_lookup(path, 0).inode_obj;
  if (entry == null) return;
  if (entry instanceof Directory) {
    for (const name of Array.from(entry.contents.keys())) removePath(dir, `${path}/${name}`);
    dir.path_remove_directory(path);
  } else {
    dir.path_unlink_file(path);
  }
}
