#!/bin/bash
# build.sh — Build both the Octopus WASM engine and the OctoDAW TypeScript app.
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
        echo "=== Building OctoDAW TypeScript app ==="
        npm install
        npm run build
        echo "=== App build complete ==="
        ;;
    all)
        echo "=== Building Octopus WASM engine ==="
        make -C wasm -f Makefile
        echo ""
        echo "=== Building Obxd synth WASM module ==="
        make -C wasm/obxd -f Makefile
        cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
        cat wasm/build/_awp_shim.js wasm/build/obxd_wasm.js src/obxd-processor.tail.js > wasm/build/obxd-processor.js
        rm wasm/build/_awp_shim.js
        echo ""
        echo "=== Building OctoDAW TypeScript app ==="
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
