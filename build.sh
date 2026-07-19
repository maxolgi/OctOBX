#!/bin/bash
# build.sh — Build both the Octopus WASM engine and the OctOBX TypeScript app.
#
# Prerequisites:
#   - Emscripten SDK activated (source emsdk_env.sh)
#   - Node.js >= 23
#   - Firmware submodule initialized (git submodule update --init)
#
# Usage:
#   ./build.sh         # build everything
#   ./build.sh wasm    # build only the WASM module
#   ./build.sh app     # build only the TypeScript app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Conditionally generate wasm/obxd/patches.h from wasm/obxd/patches/*.fxp.
# When no .fxp files are present (the default), patches.h is removed and the
# C side falls back to its programmatic factory table (see
# g_factory_programs in wasm/obxd/main_obxd.cpp). When .fxp files ARE
# present, xxd -i emits a `static const unsigned char patch_<name>[]` for
# each; main_obxd.cpp's #if __has_include("patches.h") guard picks them up.
generate_patches_h() {
    local patch_dir="wasm/obxd/patches"
    # Always start from a clean state — a stale patches.h from a previous
    # build with .fxp files would silently override the programmatic
    # fallback even after the files were removed.
    rm -f wasm/obxd/patches.h
    if [ ! -d "$patch_dir" ] || ! ls "$patch_dir"/*.fxp >/dev/null 2>&1; then
        echo "  (no .fxp patches found in $patch_dir — using programmatic factory patches)"
        return 0
    fi
    local count=0
    for f in "$patch_dir"/*.fxp; do
        local name
        name=$(basename "$f" .fxp)
        # xxd -i emits two symbols per file: `unsigned char <sanitized_path>[] = {...}`
        # and `unsigned int <sanitized_path>_len = N`. The sanitized path
        # replaces every non-alphanumeric char with `_`, so it isn't a stable
        # identifier we can match on — rewrite the whole array decl to our
        # chosen `patch_<name>` symbol and drop the _len line (the C side
        # uses sizeof() on the array instead).
        xxd -i "$f" \
            | sed -e "s/^unsigned char [a-zA-Z0-9_]*\[\]/static const unsigned char patch_${name}[]/" \
            | grep -v "_len = " \
            >> wasm/obxd/patches.h
        echo "" >> wasm/obxd/patches.h
        count=$((count + 1))
    done
    echo "  Generated patches.h from $count .fxp file(s)"
}

case "${1:-all}" in
    wasm)
        echo "=== Building Octopus WASM engine ==="
        make -C wasm -f Makefile clean
        make -C wasm -f Makefile
        echo "=== WASM build complete ==="
        echo "Output: wasm/build/octopus_wasm.js + wasm/build/octopus_wasm.wasm"
        ;;
    synth)
        echo "=== Building Obxd synth WASM module ==="
        generate_patches_h
        make -C wasm/obxd -f Makefile clean
        make -C wasm/obxd -f Makefile
        # Concatenate emcc output + processor wrapper into a single classic
        # script. AudioWorkletGlobalScope disallows importScripts() and dynamic
        # import(), so the only way to give the worklet both the emcc JS and
        # our AudioWorkletProcessor subclass is to feed them as one file to
        # audioWorklet.addModule().
        #
        # Prepend an AWP shim: Chrome's AudioWorkletGlobalScope does NOT define
        # `self` or `location` (it defines globalThis only), but emcc's
        # worker-env output references both. Aliasing self to globalThis and
        # synthesizing a minimal location lets the emcc output run unchanged.
        cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
        cat wasm/build/_awp_shim.js wasm/build/obxd_wasm.js src/obxd-processor.tail.js > wasm/build/obxd-processor.js
        rm wasm/build/_awp_shim.js
        echo "=== Synth build complete ==="
        echo "Output: wasm/build/obxd_wasm.{js,wasm} + wasm/build/obxd-processor.js (combined)"
        ;;
    app)
        echo "=== Building OctOBX TypeScript app ==="
        npm install
        npm run build
        echo "=== App build complete ==="
        ;;
    all)
        echo "=== Building Octopus WASM engine ==="
        make -C wasm -f Makefile
        echo ""
        echo "=== Building Obxd synth WASM module ==="
        generate_patches_h
        make -C wasm/obxd -f Makefile
        cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
        cat wasm/build/_awp_shim.js wasm/build/obxd_wasm.js src/obxd-processor.tail.js > wasm/build/obxd-processor.js
        rm wasm/build/_awp_shim.js
        echo ""
        echo "=== Building OctOBX TypeScript app ==="
        npm install
        npm run build
        echo ""
        echo "=== All builds complete ==="
        echo "Run: python3 serve.py  (then open http://localhost:8080)"
        ;;
    *)
        echo "Usage: $0 {wasm|synth|app|all}"
        exit 1
        ;;
esac
