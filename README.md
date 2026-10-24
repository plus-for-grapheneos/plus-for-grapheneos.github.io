# plus-for-grapheneos.github.io

The website of +PLUS for GrapheneOS: plus-ups for GrapheneOS. https://plus-for-grapheneos.github.io/

- `index.html`, `icon.svg`: the landing page.
- `install/`: the setup page (test version). It builds GrapheneOS with +PLUS for a phone, signed with a key only the
  owner holds, and loads it over USB from desktop Chrome or Edge. Everything runs in the browser; nothing is uploaded.
  - `install/tools/avbroot.wasm`, `install/tools/afsr.wasm`: avbroot 3.37.0 and afsr 2.0.0 by Andrew Gunnerson
    (GPL-3.0, https://github.com/chenxiaolong/avbroot, https://github.com/chenxiaolong/afsr), compiled to WebAssembly
    with the changes in `install/wasm-build/` (patches and build script).
  - `install/assets/plus/Plus.apk`: the +PLUS app (version 14) the page puts into the image.
  - `install/assets/pins/`: GrapheneOS's published verified-boot and OTA keys for each supported phone.
  - `install/vendor/`: browser_wasi_shim 0.4.2 (MIT or Apache-2.0), fastboot.js 1.1.3 (MIT; bundles zip.js,
    BSD-3-Clause), qrcode-generator 2.0.4 (MIT), unchanged, with their licences.
- The add-on catalog is in the `catalog` repository: https://plus-for-grapheneos.github.io/catalog/

Our code is licensed GPL-3.0-or-later (`LICENSE`). The vendored code keeps its own licences.

+PLUS for GrapheneOS is an independent project, not affiliated with or endorsed by the GrapheneOS project.
