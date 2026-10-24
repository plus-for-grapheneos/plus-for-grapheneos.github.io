#!/bin/bash
# Build avbroot 3.37.0 and afsr 2.0.0 for wasm32-wasip1 (nightly Rust), as used by the setup page (install/tools/).
#
#   build.sh <work dir> [avbroot] [afsr]
#
# The work dir holds: avbroot/ (avbroot 3.37.0 with avbroot-wasi.patch), afsr/ (afsr 2.0.0 with afsr-wasi.patch and,
# in its external/e2fsprogs tree, e2fsprogs-journal-location.patch), rustup/ and cargo/ (nightly Rust with the
# wasm32-wasip1 target), wasi-sdk/ (wasi-sdk 25), venv/ (a Python venv with libclang, for bindgen), and compat/ from
# this directory. Output: <work dir>/out/{avbroot,afsr}.wasm. Build paths are remapped to /build and /cargo.
W=$(cd "${1:?usage: build.sh <work dir> [avbroot] [afsr]}" && pwd) || exit 1
shift
cd "$W" || exit 1
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
S=$W/wasi-sdk
SYS=$S/share/wasi-sysroot
export CC_wasm32_wasip1=$S/bin/clang AR_wasm32_wasip1=$S/bin/llvm-ar
REMAP="--remap-path-prefix=$W=/build --remap-path-prefix=$W/cargo=/cargo"
CMAP="-ffile-prefix-map=$W=/build"
mkdir -p logs out
for p in ${@:-avbroot afsr}; do
  echo "== $p $(date +%T)"
  if [ $p = afsr ]; then
    # e2fsprogs (C) needs WASI's emulation libraries and the compat header; bindgen sees the same headers.
    C="--sysroot=$SYS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PTHREAD -I$W/compat/include -include $W/compat/wasi_compat.h -Wno-error"
    export CFLAGS_wasm32_wasip1="$C $CMAP"
    export LIBCLANG_PATH=$(dirname $(find $W/venv -name "libclang*.so*" | head -1))
    export BINDGEN_EXTRA_CLANG_ARGS_wasm32_wasip1="$C --target=wasm32-wasip1 -fvisibility=default -isystem $S/lib/clang/19/include"
    export RUSTFLAGS="$REMAP -C link-arg=$SYS/lib/wasm32-wasip1/libwasi-emulated-signal.a -C link-arg=$SYS/lib/wasm32-wasip1/libwasi-emulated-process-clocks.a -C link-arg=$SYS/lib/wasm32-wasip1/libwasi-emulated-mman.a -C link-arg=$SYS/lib/wasm32-wasip1/libwasi-emulated-getpid.a"
  else
    export CFLAGS_wasm32_wasip1="--sysroot=$SYS $CMAP"
    export RUSTFLAGS="$REMAP"
    unset BINDGEN_EXTRA_CLANG_ARGS_wasm32_wasip1
  fi
  (cd $p && nice cargo +nightly build --release --target wasm32-wasip1 -j 10) > logs/$p.log 2>&1
  rc=$?; echo "$p exit $rc"
  [ $rc -eq 0 ] && cp $p/target/wasm32-wasip1/release/$p.wasm out/ && ls -la out/$p.wasm
  grep -E "^error(\[|:)" logs/$p.log | sort | uniq -c | head -15
done
