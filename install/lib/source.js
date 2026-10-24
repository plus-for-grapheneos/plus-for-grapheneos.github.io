// Read-only inputs for the WebAssembly tools: the GrapheneOS download the owner picked (read in place, never copied)
// and small files such as the pinned GrapheneOS keys. A source is { size, read(dest: Uint8Array, at: number) -> n }.
import { Fd, Inode } from "../vendor/browser_wasi_shim/fd.js";
import * as wasi from "../vendor/browser_wasi_shim/wasi_defs.js";
import { countRead } from "./progress.js";

/**
 * A file the user picked in the page (a Blob), read synchronously in a worker. Each FileReaderSync call is slow (about
 * 1.6 ms on Windows) and avbroot reads this file 4-16 KiB at a time, so small reads are served from 8 MiB chunks
 * (the two most recent are kept: avbroot alternates between nearby places in the file).
 */
export function blobSource(blob, { reader = new FileReaderSync(), chunk = 8 << 20 } = {}) {
  const kept = []; // [{ start, bytes }], most recent last
  const load = (start) => {
    const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, Math.min(blob.size, start + chunk))));
    kept.push({ start, bytes });
    if (kept.length > 2) kept.shift();
    return kept.at(-1);
  };
  return {
    size: blob.size,
    read(dest, at) {
      if (dest.byteLength >= chunk) {
        const buf = reader.readAsArrayBuffer(blob.slice(at, at + dest.byteLength));
        dest.set(new Uint8Array(buf));
        return buf.byteLength;
      }
      let done = 0;
      while (done < dest.byteLength && at + done < blob.size) {
        const pos = at + done;
        const start = pos - (pos % chunk);
        const c = kept.find((k) => k.start === start) ?? load(start);
        const n = Math.min(c.bytes.byteLength - (pos - start), dest.byteLength - done);
        dest.set(c.bytes.subarray(pos - start, pos - start + n), done);
        done += n;
      }
      return done;
    },
  };
}

export function bytesSource(bytes) {
  return {
    size: bytes.byteLength,
    read(dest, at) {
      const part = bytes.subarray(at, at + dest.byteLength);
      dest.set(part);
      return part.byteLength;
    },
  };
}

export class SourceFile extends Inode {
  constructor(source) {
    super();
    this.source = source;
  }
  path_open(oflags, fs_rights_base) {
    const writing = (fs_rights_base & BigInt(wasi.RIGHTS_FD_WRITE)) === BigInt(wasi.RIGHTS_FD_WRITE);
    if (writing || (oflags & wasi.OFLAGS_TRUNC)) return { ret: wasi.ERRNO_PERM, fd_obj: null };
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new SourceFd(this) };
  }
  stat() { return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, BigInt(this.source.size)); }
  read(pos, len) {
    const out = new Uint8Array(Math.max(0, Math.min(len, this.source.size - pos)));
    for (let done = 0; done < out.byteLength;) {
      const n = this.source.read(out.subarray(done), pos + done);
      if (n <= 0) throw new Error("input file changed or became unreadable while in use");
      done += n;
    }
    countRead(out.byteLength);
    return out;
  }
}

class SourceFd extends Fd {
  constructor(file) {
    super();
    this.file = file;
    this.pos = 0;
  }
  fd_fdstat_get() { return { ret: wasi.ERRNO_SUCCESS, fdstat: new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0) }; }
  fd_filestat_get() { return { ret: wasi.ERRNO_SUCCESS, filestat: this.file.stat() }; }
  fd_read(size) {
    const data = this.file.read(this.pos, size);
    this.pos += data.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, data };
  }
  fd_pread(size, offset) { return { ret: wasi.ERRNO_SUCCESS, data: this.file.read(Number(offset), size) }; }
  fd_seek(offset, whence) {
    const base = whence === wasi.WHENCE_SET ? 0 : whence === wasi.WHENCE_CUR ? this.pos
      : whence === wasi.WHENCE_END ? this.file.source.size : NaN;
    const to = base + Number(offset);
    if (!(to >= 0)) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.pos = to;
    return { ret: wasi.ERRNO_SUCCESS, offset: BigInt(to) };
  }
  fd_tell() { return { ret: wasi.ERRNO_SUCCESS, offset: BigInt(this.pos) }; }
  fd_write() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
  fd_pwrite() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
}
