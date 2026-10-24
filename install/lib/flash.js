// Loads the built image onto the phone the way GrapheneOS's own installer does: it runs GrapheneOS's script.txt from
// the install package of the same release, in the bootloader only (no fastbootd), with these substitutions:
//   flash avb_custom_key  -> the owner's key instead of GrapheneOS's
//   flash <boot images>   -> +PLUS's images (boot, init_boot, vendor_boot, vbmeta, ...)
//   flash super super_N   -> +PLUS's super pieces (lib/super.js), all at the first super line
// Everything else (bootloader firmware to both slots, slot A, radio, erases, requirement checks, cancelling a pending
// update) runs as GrapheneOS wrote it, with GrapheneOS's firmware packs (checked by lib/gosinstall.js). A step the
// page doesn't know stops the load. Before the script: its cheap checks, then the bootloader is unlocked (the owner
// confirms on the phone); after it: locked again (the owner confirms; checked), and the phone restarts.
//
// Errors: a FAIL answer from the phone (fastboot.js FastbootError) always stops the load with the phone's message.
// Only USB trouble (the phone dropping off while it restarts or erases) is waited out.

const refused = (e) => e?.name === "FastbootError";

/**
 * After a restart (into the bootloader, or while unlocking), reopens the phone. fastboot.js reopens it by itself when
 * it reappears, but on Windows Chrome can hand over the phone while an earlier open or reset is still running ("An
 * operation that changes the device state is in progress") and that single attempt then fails. So: wait, then keep
 * trying (about 2 minutes); only if the phone never answers, ask the person to choose it again.
 */
async function reconnect(o) {
  const d = o.device;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const usb = o.usb ?? navigator.usb;
  await sleep(3000);
  for (let i = 0; i < (o.reconnectTries ?? 60); i++) {
    try {
      const devices = await usb.getDevices();
      if (devices.length > 0) {
        if (devices.length === 1) d.device = devices[0]; // normally fastboot.js's connect handler already did this
        // _validateAndConnectDevice is fastboot.js's own open-and-claim (vendored 1.1.3, so the name is fixed).
        if (!d.device?.opened) await d._validateAndConnectDevice();
        await d.getVariable("product");
        return;
      }
    } catch {
      // busy, or not back yet
    }
    await sleep(2000);
  }
  await o.ui.onReconnect();
}

/**
 * Restarts the bootloader: the command must not be refused, and the phone must really leave USB (up to 20 s) before
 * the page waits for it to come back, so a step meant for after the restart never runs on a phone that didn't restart.
 */
async function restartBootloader(o) {
  const d = o.device;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    await d.runCommand("reboot-bootloader");
  } catch (e) {
    if (refused(e)) throw e; // otherwise the phone dropped off USB before it answered: it is restarting
  }
  let left = false;
  for (let i = 0; i < 80 && !left; i++) {
    if (!d.isConnected) left = true;
    else await sleep(250);
  }
  if (!left) throw new Error("the phone didn't restart when asked; restart it into the bootloader (volume down + power) and press Connect again");
  await reconnect(o);
}

/** A variable, reopening the phone first if it just dropped off USB (some bootloaders restart after an unlock). */
async function getVar(o, name) {
  try {
    return await o.device.getVariable(name);
  } catch (e) {
    if (refused(e)) throw e;
    await reconnect(o);
    return o.device.getVariable(name);
  }
}

const matches = (value, expected) => expected.split("|").some((x) => (x.endsWith("*") ? value?.startsWith(x.slice(0, -1)) : value === x));

/** android-info.txt as fastboot's check-requirements reads it: require, require-for-product:<p>, reject. */
async function checkRequirements(d, text) {
  const product = await d.getVariable("product");
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^(require|reject|require-for-product:(\S+))\s+(.+?)=(.+)$/);
    if (!m) throw new Error(`GrapheneOS's requirements contain "${line}", which this page doesn't know`);
    if (m[2] && m[2] !== product) continue;
    const variable = m[3] === "board" ? "product" : m[3];
    if (variable === "partition-exists") {
      const has = await d.getVariable(`has-slot:${m[4]}`);
      if (has !== "yes" && has !== "no") throw new Error(`requirement partition-exists=${m[4]} failed`);
      continue;
    }
    const value = await d.getVariable(variable);
    const ok = matches(value, m[4]);
    if (m[1] === "reject" ? ok : !ok) throw new Error(`requirement "${line}" failed (the phone has ${variable}=${value})`);
  }
}

/** Locks the bootloader (the owner confirms on the phone; it erases the phone), checks it, restarts. */
export async function lockPhone(o) {
  const d = o.device;
  o.ui.progress("Locking the bootloader", 1);
  await o.ui.confirmLock();
  try {
    await d.runCommand("flashing lock");
  } catch (e) {
    if (refused(e)) throw new Error(`the phone refused to lock (${e.bootloaderMessage ?? e.message})`);
    await reconnect(o); // the phone may drop off USB while it erases
  }
  if ((await getVar(o, "unlocked")) !== "no") {
    throw new Error("the bootloader is still unlocked (was locking declined on the phone?); press Connect to lock it");
  }
  await d.runCommand("reboot").catch(() => {});
}

/**
 * @param o.device a connected fastboot.js FastbootDevice in the bootloader; o.deviceName the expected product (tokay)
 * @param o.script parseScript(script.txt); o.androidInfo android-info.txt; o.superSize the super size the pieces are for
 * @param o.gosFile (fileName) => Blob, GrapheneOS's bootloader/radio packs named in the script (already checked)
 * @param o.ownImage (partition) => Blob | undefined, +PLUS's image; o.ownerPkmd the owner key's AVB blob
 * @param o.superPieces (maxDownloadBytes) => Blob[] (each with .diskBytes), +PLUS's super in pieces
 * @param o.ui { onReconnect (must end with the phone connected again), confirmUnlock, confirmLock, progress(label, fraction),
 *   onWritten() (optional: everything is written, only locking is left) }
 * @param o.usb, o.sleep, o.reconnectTries for tests (default navigator.usb, real time, about 2 minutes)
 */
export async function flashPhone(o) {
  const d = o.device;
  const product = await d.getVariable("product");
  if (product !== o.deviceName) throw new Error(`this phone reports "${product}", but the image was built for ${o.deviceName}`);
  if ((await d.getVariable("is-userspace")) === "yes") {
    // Left in fastbootd by an earlier attempt: GrapheneOS's steps run in the bootloader.
    o.ui.progress("Restarting into the bootloader…", 0);
    await restartBootloader(o);
  }
  const superSize = Number(await d.getVariable("partition-size:super"));
  if (superSize !== o.superSize) throw new Error(`this phone's super partition is ${superSize} bytes, not the ${o.superSize} the image was made for`);
  // GrapheneOS's checks that don't depend on what the steps change (current-slot does), before the unlock erases the phone.
  for (const [cmd, name, expected] of o.script) {
    if (cmd !== "check-var" || name === "current-slot") continue;
    const value = await d.getVariable(name);
    if (value !== expected) throw new Error(`the phone's ${name} is ${value}, GrapheneOS's steps expect ${expected}`);
  }

  if ((await d.getVariable("unlocked")) !== "yes") {
    await o.ui.confirmUnlock();
    try {
      await d.runCommand("flashing unlock");
    } catch (e) {
      if (refused(e)) {
        throw new Error(`the phone refused to unlock (${e.bootloaderMessage ?? e.message}). On the phone, turn on OEM unlocking ` +
          "in Settings > System > Developer options, then restart into the bootloader and press Connect again");
      }
      await reconnect(o); // some bootloaders drop off USB while erasing
    }
    if ((await getVar(o, "unlocked")) !== "yes") throw new Error("the bootloader is still locked (unlocking was declined on the phone?)");
  }

  const other = async () => ((await d.getVariable("current-slot")) === "a" ? "b" : "a");
  const flashes = o.script.filter((c) => c[0] === "flash").length;
  let done = 0, superDone = false;
  const step = (label) => o.ui.progress(label, done / flashes);
  for (const [cmd, ...args] of o.script) {
    if (cmd === "check-var") {
      const value = await d.getVariable(args[0]);
      if (value !== args[1]) throw new Error(`the phone's ${args[0]} is ${value}, GrapheneOS's steps expect ${args[1]}`);
    } else if (cmd === "flash") {
      const [partition, file, slot] = args;
      if (slot !== undefined && slot !== "other-slot") throw new Error(`unknown flash option "${slot}"`);
      const target = slot === "other-slot" ? `${partition}_${await other()}` : partition;
      let blob;
      if (partition === "bootloader" || partition === "radio") blob = o.gosFile(file);
      else if (partition === "avb_custom_key") blob = new Blob([o.ownerPkmd]);
      else if (partition === "super") {
        if (!superDone) {
          const pieces = o.superPieces(Number(await d.getVariable("max-download-size")));
          for (let i = 0; i < pieces.length; i++) {
            const label = `Writing system partitions (${i + 1} of ${pieces.length})`;
            // fastboot.js measures a sparse piece against the whole disk it describes; measure it against the piece.
            const scale = (pieces[i].diskBytes ?? pieces[i].size) / pieces[i].size;
            step(label);
            await d.flashBlob("super", pieces[i], (f) => o.ui.progress(label, (done + (i + Math.min(1, f * scale)) / pieces.length) / flashes));
          }
          superDone = true;
        }
        done++;
        continue;
      } else {
        blob = o.ownImage(partition);
        if (!blob) throw new Error(`GrapheneOS's steps write ${partition}, which this build doesn't have`);
      }
      step(`Writing ${partition}`);
      await d.flashBlob(target, blob, (f) => o.ui.progress(`Writing ${partition}`, (done + f) / flashes));
      done++;
    } else if (cmd === "toggle-active-slot") {
      await d.runCommand(`set_active:${await other()}`);
    } else if (cmd === "reboot-bootloader") {
      step("Restarting the bootloader…");
      await restartBootloader(o);
    } else if (cmd === "run-cmd") {
      await d.runCommand(args.join(" "));
    } else if (cmd === "erase") {
      step(`Erasing ${args[0]}`);
      await d.runCommand(`erase:${args[0]}`);
    } else if (cmd === "check-requirements") {
      await checkRequirements(d, o.androidInfo);
    } else if (cmd === "maybe-cancel-snapshot-update") {
      const status = await d.getVariable("snapshot-update-status");
      if (status && status !== "none") await d.runCommand("snapshot-update:cancel");
    } else {
      throw new Error(`GrapheneOS's steps contain "${[cmd, ...args].join(" ")}", which this page doesn't know`);
    }
  }

  o.ui.onWritten?.();
  await lockPhone(o);
}
