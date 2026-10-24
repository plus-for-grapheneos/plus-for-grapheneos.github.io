// The setup page: one section per step. The owner key lives only in this page's memory (and in the backup the owner
// saves); the build runs in worker.js; flashing uses fastboot.js over WebUSB (lib/flash.js has the sequence).
import { FastbootDevice, setDebugLevel } from "./vendor/fastboot/fastboot.mjs";
import qrcode from "./vendor/qrcode-generator/qrcode.mjs";
import { STEPS } from "./lib/build.js";
import { sparseLayout } from "./lib/sparse.js";
import { flashPhone, parseFastbootInfo } from "./lib/flash.js";
import { avbPkmd, decodeBackup, encodeBackup, fingerprintDisplay, fingerprintHex, generateOwnerKey, qrPayload } from "./lib/owner.js";

const $ = (id) => document.getElementById(id);
const OPFS_DIR = "plus-setup";
// Peak: the work file (~5 GB while the signed image is checked) plus the signed image (~1.7 GB), then the images to
// load (~4.6 GB) on their own. Browsers report a storage quota, not the free disk space, so the page also says it.
const NEEDED_BYTES = 8e9;

const state = { config: null, device: null, ota: null, otaBuild: null, key: null, files: null, fastbootInfo: null };

function show(step) {
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== step;
  const order = Array.from(document.querySelectorAll("#steps li"), (li) => li.dataset.step);
  for (const li of document.querySelectorAll("#steps li")) {
    const i = order.indexOf(li.dataset.step), at = order.indexOf(step);
    li.classList.toggle("done", i < at);
    if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  }
  $(step).querySelector("h2")?.focus?.();
}
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

// ---- 1. Browser checks

async function checks() {
  state.config = await (await fetch("assets/config.json")).json();
  const list = $("checks");
  const results = [
    ["Desktop Chrome or Edge with USB support (WebUSB)", "usb" in navigator],
    ["Opened from https:// or localhost", window.isSecureContext],
    ["Browser storage for large files (OPFS)", !!navigator.storage?.getDirectory],
  ];
  const est = await navigator.storage?.estimate?.();
  const free = est ? est.quota - est.usage : 0;
  results.push([`About ${gb(NEEDED_BYTES)} of disk space the browser may use (${gb(free)} available)`, free >= NEEDED_BYTES]);
  for (const [label, ok] of results) {
    const li = document.createElement("li");
    li.textContent = `${ok ? "✓" : "✗"} ${label}`;
    li.className = ok ? "ok" : "bad";
    list.append(li);
  }
  $("check-next").disabled = !results.every(([, ok]) => ok);
  $("space-needed").textContent = gb(NEEDED_BYTES);
}
$("check-next").addEventListener("click", () => { renderModels(); show("model"); });

// ---- 2. Phone model

function renderModels() {
  const box = $("models");
  box.replaceChildren();
  for (const [codename, m] of Object.entries(state.config.devices)) {
    const id = `model-${codename}`;
    const row = document.createElement("div");
    row.innerHTML = `<input type="radio" name="model" id="${id}" value="${codename}" ${m.supported ? "" : "disabled"} required>
      <label for="${id}">${m.name}${m.supported ? "" : " (not supported yet)"}</label>`;
    box.append(row);
  }
}
$("model-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.device = new FormData(e.target).get("model");
  renderRelease();
  show("file");
});

// ---- 3. GrapheneOS file

async function renderRelease() {
  const d = state.device;
  $("ota-pattern").textContent = `${d}-ota_update-<build>.zip`;
  const ul = $("release-links");
  ul.replaceChildren();
  for (const channel of ["stable", "beta"]) {
    const li = document.createElement("li");
    li.textContent = `${channel}: checking…`;
    ul.append(li);
    try {
      const line = (await (await fetch(`https://releases.grapheneos.org/${d}-${channel}`)).text()).trim().split(" ");
      if (line.length !== 4 || line[2] !== d) throw new Error("unexpected release data");
      const name = `${d}-ota_update-${line[0]}.zip`;
      li.innerHTML = `${channel === "stable" ? "Stable" : "Beta"} ${line[0]}: <a href="https://releases.grapheneos.org/${name}" download>${name}</a>`;
    } catch {
      li.innerHTML = `${channel}: open <a href="https://grapheneos.org/releases">grapheneos.org/releases</a> and download the full update ("ota_update") for this model`;
    }
  }
}
$("ota").addEventListener("change", () => {
  const f = $("ota").files[0];
  const m = f?.name.match(new RegExp(`^${state.device}-ota_update-([0-9]{10,12})\\.zip$`));
  const ok = !!m && f.size > 500e6;
  $("ota-status").textContent = !f ? "" : ok ? `${f.name}, ${gb(f.size)}. GrapheneOS's signature is checked during the build.`
    : `That isn't a GrapheneOS update file for this phone (expected ${state.device}-ota_update-<build>.zip).`;
  $("file-next").disabled = !ok;
  if (ok) { state.ota = f; state.otaBuild = m[1]; }
});
$("file-form").addEventListener("submit", (e) => { e.preventDefault(); show("key"); });

// ---- 4. Key

async function showKey() {
  const backup = await encodeBackup(state.key);
  $("backup-text").textContent = backup.match(/.{1,48}/g).join("\n");
  $("fingerprint").textContent = $("finish-fingerprint").textContent = await fingerprintDisplay(state.key);
  const qr = qrcode(0, "M");
  qr.addData(await qrPayload(state.key), "Alphanumeric");
  qr.make();
  $("qr").innerHTML = $("finish-qr").innerHTML = $("sheet-qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  // The printable key sheet (index.html #print-sheet): five blocks of five characters per line, easy to type back.
  const blocks = backup.split("-");
  const lines = [blocks[0]];
  for (let i = 1; i < blocks.length; i += 6) lines.push(blocks.slice(i, i + 6).join(" "));
  $("sheet-text").textContent = lines.join("\n");
  $("sheet-fingerprint").textContent = $("fingerprint").textContent;
  $("sheet-phone").textContent = state.config.devices[state.device]?.name ?? state.device ?? "";
  $("sheet-date").textContent = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("key-new").hidden = true;
  $("key-sheet").hidden = false;
}
$("key-create").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = "Creating…";
  state.key = await generateOwnerKey();
  await showKey();
});
$("key-restore").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    state.key = await decodeBackup($("backup-in").value);
    await showKey();
    $("key-confirm").hidden = true;
    const next = document.createElement("button");
    next.textContent = "Next";
    next.addEventListener("click", () => show("build"));
    $("key-sheet").append(next);
  } catch (err) {
    $("backup-in-status").textContent = `That backup can't be used: ${err.message}.`;
  }
});
$("backup-copy").addEventListener("click", async () => navigator.clipboard.writeText(await encodeBackup(state.key)));
$("backup-download").addEventListener("click", async () => {
  const text = `+PLUS key backup (keep it secret)\nFingerprint: ${await fingerprintDisplay(state.key)}\n\n${await encodeBackup(state.key)}\n`;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "plus-key-backup.txt" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});
$("backup-print").addEventListener("click", () => window.print());
$("finish-print").addEventListener("click", () => window.print());
$("key-confirm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const last = (await encodeBackup(state.key)).split("-").at(-1);
  if ($("last-block").value.trim().toUpperCase() === last) show("build");
  else $("last-block-status").textContent = "That doesn't match the last block. Check what you saved.";
});

// ---- 5. Build

async function asset(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`could not load ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

$("build-start").addEventListener("click", async (e) => {
  e.target.disabled = true;
  const est = await navigator.storage.estimate();
  if (est.quota - est.usage < NEEDED_BYTES) {
    $("space-status").textContent = `Not enough space: ${gb(est.quota - est.usage)} available, about ${gb(NEEDED_BYTES)} needed.`;
    e.target.disabled = false;
    return;
  }
  await navigator.storage.persist?.();
  const wake = await navigator.wakeLock?.request("screen").catch(() => null);
  const plusCfg = state.config.plus;
  const apk = await asset(plusCfg.apk);
  const xmls = {};
  for (const [path, file] of Object.entries(state.config.systemXmls)) xmls[path] = await asset(file);
  const pins = {
    avbPkmd: await asset(`assets/pins/${state.device}/grapheneos_avb_pkmd.bin`),
    otaCertPem: new TextDecoder().decode(await asset(`assets/pins/${state.device}/grapheneos_ota.x509.pem`)),
  };

  $("build-progress").hidden = false;
  const stepsList = $("build-steps");
  const steps = [{ id: "hash", label: "Reading the GrapheneOS file", weight: 25, ioFactor: 1 }, ...STEPS]
    .map((s) => ({ ...s, io: s.ioFactor * state.ota.size }));
  stepsList.replaceChildren(...steps.map((s) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    li.textContent = s.label;
    return li;
  }));
  const total = steps.reduce((n, s) => n + s.weight, 0);
  let current = steps[0], stepStart = performance.now(), doneWeight = 0;
  // Bytes the tools have read and written (from the worker): the real sign that a long step is moving.
  let ioNow = 0, ioStepStart = 0, rate = 0, sample = { t: performance.now(), b: 0 };
  const started = performance.now();
  const fmtGb = (b) => `${(b / 1e9).toFixed(2)} GB`;
  const stepFraction = () => current.io
    ? Math.min(0.99, (ioNow - ioStepStart) / current.io)
    : Math.min(0.95, (performance.now() - stepStart) / 1000 / current.weight);
  const tick = setInterval(() => {
    const f = stepFraction();
    $("build-bar").value = (doneWeight + f * current.weight) / total;
    const s = Math.floor((performance.now() - started) / 1000);
    $("build-activity").textContent = `${Math.floor(f * 100)}% of this step · ${fmtGb(ioNow)} processed` +
      ` · ${rate.toFixed(0)} MB/s · ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  }, 500);
  const setStep = (id) => {
    stepsList.querySelector(`[data-id="${current.id}"]`).classList.add("done");
    doneWeight += current.weight;
    current = steps.find((s) => s.id === id) ?? current;
    stepStart = performance.now();
    ioStepStart = ioNow;
    stepsList.querySelector(`[data-id="${id}"]`)?.classList.add("active");
    $("build-status").textContent = current.label; // announced once per step (role=status)
  };
  stepsList.firstElementChild.classList.add("active");
  $("build-status").textContent = current.label;
  const log = $("build-log");
  const addLog = (raw) => {
    const t = raw.replace(/\x1b\[[0-9;]*m/g, ""); // the tools colour their output for terminals
    log.textContent += t + "\n";
    if (log.textContent.length > 200_000) log.textContent = log.textContent.slice(-150_000);
    const msg = t.replace(/^\s*[\d.]+s\s+(INFO|WARN|ERROR)\s+/, "").trim();
    if (msg) $("build-last").textContent = msg;
  };

  const worker = new Worker("worker.js", { type: "module" });
  worker.onmessage = (m) => {
    const d = m.data;
    if (d.type === "step") setStep(d.id);
    else if (d.type === "io") {
      ioNow = d.read + d.written;
      const t = performance.now();
      if (t - sample.t >= 2000) { rate = rate * 0.5 + ((ioNow - sample.b) / 1e6 / ((t - sample.t) / 1000)) * 0.5; sample = { t, b: ioNow }; }
    }
    else if (d.type === "line") addLog(d.text);
    else if (d.type === "export") $("build-last").textContent = `Preparing ${d.name} (${d.done + 1} of ${d.total})`;
    else if (d.type === "done") {
      clearInterval(tick);
      wake?.release();
      worker.terminate();
      $("build-bar").value = 1;
      state.files = d.files;
      state.fastbootInfo = d.fastbootInfo;
      addLog(`Done in ${Math.round((performance.now() - started) / 60000)} min.`);
      show("flash");
    } else if (d.type === "error") {
      clearInterval(tick);
      wake?.release();
      worker.terminate();
      for (const l of d.lines) addLog(l);
      $("build-status").textContent = `The build stopped${d.step ? ` (${d.step})` : ""}: ${d.message}. Nothing was changed on your phone, and the build's files were deleted again. Copy the log if you report this.`;
      e.target.disabled = false;
    }
  };
  worker.postMessage({
    type: "build", ota: state.ota, otaBuild: state.otaBuild, device: state.device,
    key: { p: state.key.p.toString(16), q: state.key.q.toString(16) }, fingerprint: await fingerprintHex(state.key),
    plus: { apk, version: plusCfg.version, sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", apk))) },
    xmls, pins,
  });
});
$("log-copy").addEventListener("click", () => navigator.clipboard.writeText($("build-log").textContent));

// ---- 6. Flash

function prompt(text, button) {
  $("flash-prompt").hidden = false;
  $("flash-prompt-text").textContent = text;
  $("flash-prompt-button").textContent = button;
  return new Promise((resolve) => {
    $("flash-prompt-button").onclick = () => { $("flash-prompt").hidden = true; resolve(); };
  });
}

$("flash-connect").addEventListener("click", async (e) => {
  e.target.disabled = true;
  setDebugLevel(1);
  const device = new FastbootDevice();
  try {
    await device.connect();
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR)).getDirectoryHandle("files");
    await flashPhone({
      device, deviceName: state.device,
      steps: parseFastbootInfo(state.fastbootInfo),
      openImage: async (p) => {
        const f = state.files.find((x) => x.name === `${p}.img`);
        if (!f) throw new Error(`the image for ${p} is missing`);
        const file = await (await dir.getFileHandle(f.file)).getFile();
        // Large images go as Android sparse images: headers plus slices of the raw file, no second copy.
        return f.runs ? new Blob(sparseLayout(f.runs, f.size).map((x) => x.bytes ?? file.slice(x.offset, x.offset + x.length))) : file;
      },
      ownerPkmd: avbPkmd(state.key),
      ui: {
        // After a restart the browser needs the phone chosen again; that must come from a click.
        onReconnect: () => prompt("The phone restarted. Press Reconnect and choose it again.", "Reconnect").then(() => device.connect()),
        confirmUnlock: () => prompt("Next: unlock the bootloader. After you press Unlock, use the volume keys on the phone to select \"Unlock the bootloader\" and press power.", "Unlock"),
        confirmLock: () => prompt("Last: lock the bootloader again. THIS ERASES THE PHONE. After you press Lock, select \"Lock the bootloader\" on the phone and press power.", "Lock"),
        progress: (label, f) => { $("flash-status").textContent = label; $("flash-bar").value = f; },
      },
    });
    $("flash-status").textContent = "Done. The phone is restarting.";
    show("finish");
  } catch (err) {
    $("flash-status").textContent = `Loading stopped: ${err.message}. You can press Connect to try again from the start.`;
    e.target.disabled = false;
  }
});

// ---- 7. Finish

$("cleanup").addEventListener("click", async () => {
  if (!confirm("Delete the built image files from this browser? Your key backup is not affected.")) return;
  await (await navigator.storage.getDirectory()).removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
  $("cleanup-status").textContent = "Deleted.";
});

// ---- Continue after a reload: a finished build is still in browser storage (worker.js saves build.json).

async function savedBuild() {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR);
    return JSON.parse(await (await (await dir.getFileHandle("build.json")).getFile()).text());
  } catch {
    return null;
  }
}

async function offerResume() {
  const b = await savedBuild();
  if (!b) return;
  const fp = b.fingerprint.toUpperCase().match(/.{4}/g).join(" ");
  $("resume-text").textContent = `A finished build is still in this browser: ${state.config.devices[b.device]?.name ?? b.device}, ` +
    `GrapheneOS ${b.otaBuild}, made ${new Date(b.created).toLocaleString()}, signed with the key ${fp}. ` +
    "You can load it without building again.";
  $("resume").hidden = false;
  $("resume-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const key = await decodeBackup($("resume-backup").value);
      if ((await fingerprintHex(key)) !== b.fingerprint) {
        $("resume-status").textContent = "That backup is a different key from the one this build was signed with.";
        return;
      }
      Object.assign(state, { key, device: b.device, files: b.files, fastbootInfo: b.fastbootInfo });
      await showKey();
      show("flash");
    } catch (err) {
      $("resume-status").textContent = `That backup can't be used: ${err.message}.`;
    }
  };
  $("resume-delete").onclick = async () => {
    if (!confirm("Delete the finished build from this browser? You would have to build again.")) return;
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_DIR, { recursive: true }).catch(() => {});
    $("resume").hidden = true;
  };
}

checks().then(() => { show("check"); return offerResume(); });
