// Builds the owner's first image from the official GrapheneOS OTA, as +PLUS's Pipeline.kt does (same tool commands,
// same order), then extracts the images to flash. The edit step (putting +PLUS in place of GrapheneOS's Updater, its
// native libraries and system XMLs, and the build manifest) runs here in JavaScript. Intermediate files are deleted as
// soon as the next step no longer needs them, which keeps the peak storage near 6 GB.
import { Directory, File as MemFile, PreopenDirectory } from "../vendor/browser_wasi_shim/index.js";
import { runTool } from "./run.js";
import { StoredPreopen, readFile, removePath, writeFile } from "./store.js";
import { addEntries } from "./edit.js";
import { readZip } from "./zip.js";
import { avbPkmd, fingerprintHex, manifestJson, ownerCertPem, privateKeyPem } from "./owner.js";

/**
 * The steps. weight: seconds measured on the compile computer (single-threaded), for the overall bar. ioFactor: bytes
 * the step reads plus writes, as a multiple of the GrapheneOS file's size (measured 2026-10-23 on the tokay OTA), so
 * the page can show a real percentage within each step from the live byte counts (lib/progress.js).
 */
export const STEPS = [
  { id: "verify_input", label: "Checking GrapheneOS's signature", weight: 197, ioFactor: 13.92 },
  { id: "extract", label: "Taking out the system and product images", weight: 54, ioFactor: 2.19 },
  { id: "unpack", label: "Unpacking the images", weight: 42, ioFactor: 9.65 },
  { id: "edit", label: "Adding +PLUS", weight: 1, ioFactor: 0.017 },
  { id: "pack", label: "Packing the images", weight: 93, ioFactor: 13.08 },
  { id: "patch", label: "Signing with your key", weight: 257, ioFactor: 8.07 },
  { id: "verify_output", label: "Checking the signed image", weight: 200, ioFactor: 14.15 },
  { id: "flash_files", label: "Preparing the files to load", weight: 115, ioFactor: 10.4 },
];

export class BuildError extends Error {
  constructor(step, message, lines = []) {
    super(message);
    this.step = step;
    this.lines = lines; // the tool's last output lines, for "share the log"
  }
}

const PARTS = ["system", "product"];
const UPDATER = "system/priv-app/Updater";
const MANIFEST = "etc/plus/build-manifest.json";

/**
 * @param o.tools { avbroot, afsr }: compiled WebAssembly.Modules
 * @param o.ota an Inode for the official OTA zip (SourceFile over the file the owner picked)
 * @param o.otaBuild GrapheneOS build number, e.g. "2026101600"; o.otaSha256 its hex SHA-256
 * @param o.device GrapheneOS codename (tokay); o.pins { avbPkmd: Uint8Array, otaCertPem: string } for that model
 * @param o.key the owner key (lib/owner.js); o.plus { apk: Uint8Array, version, sha256 }; o.xmls { "system/…": bytes }
 * @param o.root the StoredDirectory all work goes into; o.onStep(id); o.onLine(stream, line)
 * @param o.pools optional { final, flash } HandlePools: the signed OTA (final/) and the images to load (flash/) then get
 *   storage files of their own instead of space in the work file, so nothing has to be copied out afterwards
 * @param o.keepOutput keep final/out.zip (tests); by default it is deleted once the images to load are out
 * @returns the work directory (StoredPreopen); the images to flash are in flash/, with flash/fastboot-info.txt
 */
export async function buildFirstImage(o) {
  const enc = (s) => new TextEncoder().encode(s);
  const inputs = new Directory(new Map([
    ["ota.zip", o.ota],
    ["grapheneos_avb_pkmd.bin", new MemFile(o.pins.avbPkmd, { readonly: true })],
    ["grapheneos_ota.x509.pem", new MemFile(enc(o.pins.otaCertPem), { readonly: true })],
    // The private key is only ever in memory, never in browser storage.
    ["owner.key", new MemFile(enc(privateKeyPem(o.key)), { readonly: true })],
    ["owner.crt", new MemFile(enc(await ownerCertPem(o.key)), { readonly: true })],
    ["owner_pkmd.bin", new MemFile(avbPkmd(o.key), { readonly: true })],
  ]));
  const work = () => new StoredPreopen("/work", o.root);
  const W = work();
  for (const name of Array.from(o.root.contents.keys())) removePath(W, name);
  W.path_create_directory("tmp");
  for (const d of ["final", "flash"]) {
    W.path_create_directory(d);
    if (o.pools?.[d]) W.path_lookup(d, 0).inode_obj.pool = o.pools[d];
  }
  // Cut the work file back whenever the space at its end is free again (browser storage counts its full size).
  const shrink = () => o.root.store.shrink();

  let step = "";
  const tool = async (name, ...args) => {
    const lines = [];
    const code = await runTool(o.tools[name], [name, ...args], {
      env: { TMPDIR: "/work/tmp" },
      preopens: [new PreopenDirectory("/in", inputs.contents), work()],
      onLine: (s, l) => { lines.push(l); if (lines.length > 50) lines.shift(); o.onLine?.(s, l); },
    });
    if (code !== 0) {
      const last = lines.filter(Boolean).at(-1) ?? "";
      throw new BuildError(step, /No space left|os error 28|ENOSPC/.test(lines.join("\n"))
        ? "the browser ran out of storage space" : `${name} failed (exit ${code}): ${last}`, lines);
    }
  };
  const begin = (id) => { shrink(); step = id; o.onStep?.(id); };

  begin("verify_input");
  await tool("avbroot", "ota", "verify", "--input", "/in/ota.zip",
    "--public-key-avb", "/in/grapheneos_avb_pkmd.bin", "--cert-ota", "/in/grapheneos_ota.x509.pem");

  begin("extract");
  await tool("avbroot", "ota", "extract", "-i", "/in/ota.zip", "-d", "/work/ex", "-p", "system", "-p", "product");

  begin("unpack");
  for (const p of PARTS) {
    await tool("avbroot", "avb", "unpack", "-i", `/work/ex/${p}.img`, "--output-info", `/work/${p}.avb.toml`,
      "--output-raw", `/work/${p}.raw`, "-q");
    removePath(W, `ex/${p}.img`);
    await tool("afsr", "unpack", "-i", `/work/${p}.raw`, "--output-metadata", `/work/${p}.fs.toml`,
      "--output-tree", `/work/${p}.tree`);
    removePath(W, `${p}.raw`);
  }

  begin("edit");
  await edit(W, o);

  begin("pack");
  for (const p of PARTS) {
    await tool("afsr", "pack", "--input-metadata", `/work/${p}.fs.toml`, "--input-tree", `/work/${p}.tree`,
      "-o", `/work/${p}.new.raw`);
    removePath(W, `${p}.tree`);
    await tool("avbroot", "avb", "pack", "-o", `/work/${p}.new.img`, "--input-info", `/work/${p}.avb.toml`,
      "--input-raw", `/work/${p}.new.raw`, "--recompute-size", "-q");
    removePath(W, `${p}.new.raw`);
    removePath(W, `${p}.avb.toml`);
    removePath(W, `${p}.fs.toml`);
  }

  begin("patch");
  await tool("avbroot", "ota", "patch", "--input", "/in/ota.zip", "--output", "/work/final/out.zip", "--rootless",
    "--key-avb", "/in/owner.key", "--key-ota", "/in/owner.key", "--cert-ota", "/in/owner.crt",
    "--replace", "product", "/work/product.new.img", "--replace", "system", "/work/system.new.img");
  for (const p of PARTS) removePath(W, `${p}.new.img`);

  begin("verify_output");
  await tool("avbroot", "ota", "verify", "--input", "/work/final/out.zip", "--public-key-avb", "/in/owner_pkmd.bin",
    "--cert-ota", "/in/owner.crt");

  begin("flash_files");
  await tool("avbroot", "ota", "extract", "--input", "/work/final/out.zip", "--directory", "/work/flash", "--all", "--fastboot");
  if (!o.keepOutput) removePath(W, "final/out.zip");
  removePath(W, "tmp");
  shrink();
  return W;
}

/** Pipeline.kt's edit() for the first image: +PLUS replaces the Updater; no add-ons yet. */
async function edit(W, o) {
  const sys = (p) => `system.tree/${p}`;
  if (W.path_lookup(sys(`${UPDATER}/Updater.apk`), 0).inode_obj == null) {
    throw new BuildError("edit", "this GrapheneOS image has no Updater app; it is not an official GrapheneOS release");
  }
  writeFile(W, sys(`${UPDATER}/Updater.apk`), o.plus.apk);
  const systemNew = [];
  // Preinstalled apps get no native-library extraction: +PLUS's libraries (avbroot, afsr, its signing helper) go to
  // lib/arm64 next to the APK, executable.
  for (const e of readZip(o.plus.apk)) {
    if (!e.name.startsWith("lib/arm64-v8a/") || e.name.endsWith("/")) continue;
    const name = e.name.slice("lib/arm64-v8a/".length);
    if (!/^[A-Za-z0-9._+-]+\.so$/.test(name)) throw new BuildError("edit", "unsafe native library name in the +PLUS app");
    writeFile(W, sys(`${UPDATER}/lib/arm64/${name}`), await e.bytes());
    systemNew.push({ path: `/${UPDATER}/lib/arm64/${name}`, executable: true });
  }
  for (const [path, bytes] of Object.entries(o.xmls)) {
    if (!path.startsWith("system/")) throw new Error(`installer files go to system/, got ${path}`);
    if (W.path_lookup(sys(path), 0).inode_obj == null) systemNew.push({ path: `/${path}` });
    writeFile(W, sys(path), bytes);
  }
  const dec = (b) => new TextDecoder().decode(b);
  const enc = (s) => new TextEncoder().encode(s);
  writeFile(W, "system.fs.toml", enc(addEntries(dec(readFile(W, "system.fs.toml")), systemNew)));

  const manifest = manifestJson({
    device: o.device,
    grapheneos: { build: o.otaBuild, otaSha256: o.otaSha256 },
    ownerKeyFingerprint: "sha256:" + await fingerprintHex(o.key),
    installer: { version: o.plus.version, apkSha256: o.plus.sha256 },
  });
  writeFile(W, `product.tree/${MANIFEST}`, enc(manifest));
  writeFile(W, "product.fs.toml", enc(addEntries(dec(readFile(W, "product.fs.toml")), [{ path: `/${MANIFEST}` }])));
}
