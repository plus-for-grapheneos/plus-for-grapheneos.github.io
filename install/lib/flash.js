// Loads the built image onto the phone the way GrapheneOS's own installer does: it runs GrapheneOS's script.txt from
// the install package of the same release, in the bootloader only (no fastbootd), with these substitutions:
//   flash avb_custom_key  -> the owner's key instead of GrapheneOS's
//   flash <boot images>   -> +PLUS's images (boot, init_boot, vendor_boot, vbmeta, ...)
//   flash super super_N   -> +PLUS's super pieces (lib/super.js), all at the first super line
// Everything else (bootloader firmware to both slots, slot A, radio, erases, requirement checks, cancelling a pending
// update) runs as GrapheneOS wrote it, with GrapheneOS's firmware packs (checked by lib/gosinstall.js). A step the
// page doesn't know stops the load. Before the script: the bootloader is unlocked (the owner confirms on the phone);
// after it: locked again (the owner confirms), and the phone restarts.

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

/** android-info.txt's "require" lines, checked as fastboot's check-requirements does. */
async function checkRequirements(d, text) {
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^require\s+(.+?)=(.+)$/);
    if (!m) continue;
    const variable = m[1] === "board" ? "product" : m[1];
    if (variable === "partition-exists") {
      const has = await d.getVariable(`has-slot:${m[2]}`);
      if (has !== "yes" && has !== "no") throw new Error(`requirement partition-exists=${m[2]} failed`);
      continue;
    }
    const value = await d.getVariable(variable);
    if (!m[2].split("|").includes(value)) throw new Error(`requirement ${variable}=${m[2]} failed (the phone has ${value})`);
  }
}

/**
 * @param o.device a connected fastboot.js FastbootDevice in the bootloader; o.deviceName the expected product (tokay)
 * @param o.script parseScript(script.txt); o.androidInfo android-info.txt; o.superSize the super size the pieces are for
 * @param o.gosFile (fileName) => Blob, GrapheneOS's bootloader/radio packs named in the script (already checked)
 * @param o.ownImage (partition) => Blob | undefined, +PLUS's image; o.ownerPkmd the owner key's AVB blob
 * @param o.superPieces (maxDownloadBytes) => Blob[], +PLUS's super in pieces
 * @param o.ui { onReconnect (must end with the phone connected again), confirmUnlock, confirmLock, progress(label, fraction) }
 * @param o.usb, o.sleep, o.reconnectTries for tests (default navigator.usb, real time, about 2 minutes)
 */
export async function flashPhone(o) {
  const d = o.device;
  const product = await d.getVariable("product");
  if (product !== o.deviceName) throw new Error(`this phone reports "${product}", but the image was built for ${o.deviceName}`);
  if ((await d.getVariable("is-userspace")) === "yes") {
    // Left in fastbootd by an earlier attempt: GrapheneOS's steps run in the bootloader.
    o.ui.progress("Restarting into the bootloader…", 0);
    await d.runCommand("reboot-bootloader").catch(() => {});
    await reconnect(o);
  }
  const superSize = Number(await d.getVariable("partition-size:super"));
  if (superSize !== o.superSize) throw new Error(`this phone's super partition is ${superSize} bytes, not the ${o.superSize} the image was made for`);

  if ((await d.getVariable("unlocked")) !== "yes") {
    await o.ui.confirmUnlock();
    try {
      await d.runCommand("flashing unlock");
    } catch {
      await reconnect(o); // some bootloaders drop off USB while erasing
    }
    if ((await d.getVariable("unlocked")) !== "yes") throw new Error("the bootloader is still locked (unlocking was declined on the phone?)");
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
            step(label);
            await d.flashBlob("super", pieces[i], (f) => o.ui.progress(label, (done + (i + f) / pieces.length) / flashes));
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
      await d.runCommand("reboot-bootloader").catch(() => {}); // the phone may drop off USB before it answers
      await reconnect(o);
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

  o.ui.progress("Locking the bootloader", 1);
  await o.ui.confirmLock();
  await d.runCommand("flashing lock");
  await d.runCommand("reboot").catch(() => {});
}
