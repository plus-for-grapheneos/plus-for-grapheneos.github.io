// Appends entries to an afsr fs_metadata.toml, as +PLUS's FsEdit (Kotlin) does. afsr packs only what the TOML lists,
// so every added file and every missing parent directory needs an entry: system_file label, 755 directories / 644
// files (755 for native libraries), timestamps 2009-01-01 as in GrapheneOS images.

const TIME = "2009-01-01T00:00:00Z";
const PATH = /^path = "(.*)"$/gm;

/** entries: [{ path: "/system/…", dir?: boolean, executable?: boolean }] */
export function addEntries(fsToml, entries) {
  const known = new Set(Array.from(fsToml.matchAll(PATH), (m) => m[1]));
  let out = fsToml;
  const append = (path, dir, executable) => {
    if (!out.endsWith("\n")) out += "\n";
    out += "\n[[entries]]\n" +
      `path = "${path}"\n` +
      `file_type = "${dir ? "Directory" : "RegularFile"}"\n` +
      `file_mode = "${dir || executable ? "755" : "644"}"\n` +
      `atime = "${TIME}"\nctime = "${TIME}"\nmtime = "${TIME}"\ncrtime = "${TIME}"\n\n` +
      "[entries.xattrs]\n" +
      "\"security.selinux\" = 'u:object_r:system_file:s0\\0'\n";
  };
  for (const e of entries) {
    // eslint-disable-next-line no-control-regex
    if (!e.path.startsWith("/") || e.path.includes("..") || /["\\\u0000-\u001f\u007f-\u009f]/.test(e.path)) {
      throw new Error(`bad image path ${e.path}`);
    }
    const parents = [];
    for (let p = e.path.slice(0, e.path.lastIndexOf("/")); p !== ""; p = p.slice(0, p.lastIndexOf("/"))) parents.unshift(p);
    for (const dir of parents) if (!known.has(dir)) { known.add(dir); append(dir, true, false); }
    if (!known.has(e.path)) { known.add(e.path); append(e.path, !!e.dir, !!e.executable); }
  }
  return out;
}
