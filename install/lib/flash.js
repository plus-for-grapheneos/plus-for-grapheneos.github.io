// Loads the built image onto the phone over WebUSB with fastboot.js, as plus-setup's Fastboot.flashFirstImage
// (Kotlin) does with the fastboot tool: check the model, unlock the bootloader (the owner confirms on the phone),
// install the owner's key as avb_custom_key, flash what avbroot's fastboot-info.txt lists (bootloader partitions,
// then the dynamic ones in fastbootd), return to the bootloader and lock it (the owner confirms again), restart.

/** fastboot-info.txt (version 1) as steps. Wipe lines are skipped: locking the bootloader erases the phone anyway. */
export function parseFastbootInfo(text) {
  const steps = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    if (words[0] === "version") { if (words[1] !== "1") throw new Error(`fastboot-info version ${words[1]} is not supported`); }
    else if (words[0] === "flash") steps.push({ op: "flash", partition: words.filter((w) => !w.startsWith("--")).at(-1) });
    else if (words[0] === "reboot") steps.push({ op: "reboot", target: words[1] ?? "" });
    else if (words[0] === "if-wipe") continue;
    else throw new Error(`fastboot-info: "${line}" is not supported`);
  }
  return steps;
}

/**
 * After a restart (into fastbootd, into the bootloader, or while unlocking), reopens the phone. fastboot.js reopens it
 * by itself when it reappears, but on Windows Chrome can hand over the phone while an earlier open or reset is still
 * running ("An operation that changes the device state is in progress") and that single attempt then fails. So: wait,
 * then keep trying (about 2 minutes); only if the phone never answers, ask the person to choose it again.
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
 * @param o.device a connected fastboot.js FastbootDevice; o.deviceName the expected product (tokay)
 * @param o.steps parseFastbootInfo(...); o.openImage(partition) => Promise<Blob> | Blob
 * @param o.ownerPkmd the owner key's AVB blob (Uint8Array)
 * @param o.ui { onReconnect (must end with the phone connected again), confirmUnlock, confirmLock, progress(label, fraction) }
 * @param o.usb, o.sleep, o.reconnectTries for tests (default navigator.usb, real time, about 2 minutes)
 */
export async function flashPhone(o) {
  const d = o.device;
  const restart = async (target) => {
    try {
      await d.runCommand(target ? `reboot-${target}` : "reboot");
    } catch {
      // the phone may drop off USB before it answers
    }
    if (target) await reconnect(o);
  };
  const product = await d.getVariable("product");
  if (product !== o.deviceName) throw new Error(`this phone reports "${product}", but the image was built for ${o.deviceName}`);
  if ((await d.getVariable("is-userspace")) === "yes") {
    // Left in fastbootd (an earlier attempt stopped there): the key and the first images go in from the bootloader.
    o.ui.progress("Restarting into the bootloader…", 0);
    await restart("bootloader");
  }

  if ((await d.getVariable("unlocked")) !== "yes") {
    await o.ui.confirmUnlock();
    try {
      await d.runCommand("flashing unlock");
    } catch {
      await reconnect(o); // some bootloaders drop off USB while erasing
    }
    if ((await d.getVariable("unlocked")) !== "yes") throw new Error("the bootloader is still locked (unlocking was declined on the phone?)");
  }

  o.ui.progress("Installing your key on the phone", 0);
  await d.runCommand("erase:avb_custom_key");
  await d.flashBlob("avb_custom_key", new Blob([o.ownerPkmd]));

  const flashes = o.steps.filter((s) => s.op === "flash").length;
  let done = 0;
  for (const s of o.steps) {
    if (s.op === "reboot") {
      o.ui.progress(`Restarting into ${s.target || "Android"}…`, done / flashes);
      await restart(s.target);
      continue;
    }
    const blob = await o.openImage(s.partition);
    await d.flashBlob(s.partition, blob, (f) => o.ui.progress(`Writing ${s.partition}`, (done + f) / flashes));
    done++;
  }

  o.ui.progress("Restarting into the bootloader…", 1);
  await restart("bootloader");
  await o.ui.confirmLock();
  await d.runCommand("flashing lock");
  await restart("");
}
