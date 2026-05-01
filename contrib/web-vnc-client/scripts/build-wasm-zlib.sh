#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_WASM="$ROOT_DIR/public/zlib-inflate.wasm"
WRAPPER_C="$ROOT_DIR/src/wasm/zlib_inflate_wrapper.c"

mkdir -p "$ROOT_DIR/public"

if [[ ! -f "$WRAPPER_C" ]]; then
  echo "Missing wrapper source: $WRAPPER_C" >&2
  exit 1
fi

build_with_emcc() {
  local emcc_bin="$1"
  local work_dir
  work_dir="$(mktemp -d)"
  local zlib_tar="$work_dir/zlib.tar.gz"
  trap "rm -rf '$work_dir'" EXIT

  if ! curl -fsSL https://zlib.net/fossils/zlib-1.3.1.tar.gz -o "$zlib_tar"; then
    curl -fsSL https://github.com/madler/zlib/archive/refs/tags/v1.3.1.tar.gz -o "$zlib_tar"
  fi
  tar -xzf "$zlib_tar" -C "$work_dir"

  "$emcc_bin" -O3 --no-entry -s STANDALONE_WASM=1 \
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_wz_create","_wz_reset","_wz_destroy","_wz_inflate"]' \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    "$WRAPPER_C" \
    "$work_dir/zlib-1.3.1/adler32.c" \
    "$work_dir/zlib-1.3.1/crc32.c" \
    "$work_dir/zlib-1.3.1/inflate.c" \
    "$work_dir/zlib-1.3.1/inffast.c" \
    "$work_dir/zlib-1.3.1/inftrees.c" \
    "$work_dir/zlib-1.3.1/zutil.c" \
    -I"$work_dir/zlib-1.3.1" \
    -o "$OUT_WASM"

  echo "Built $OUT_WASM"
}

if command -v emcc >/dev/null 2>&1; then
  echo "Using local emcc"
  build_with_emcc "$(command -v emcc)"
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  echo "Using dockerized emscripten"
  docker run --rm -v "$ROOT_DIR":/src -w /src emscripten/emsdk:3.1.64 \
    bash -lc "set -euo pipefail && bash /src/scripts/build-wasm-zlib.sh"
  exit 0
fi

echo "Neither emcc nor docker is available. Install emscripten or docker to build wasm zlib." >&2
exit 1
