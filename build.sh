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
        echo "=== Building OctoDAW TypeScript app ==="
        npm install
        npm run build
        echo ""
        echo "=== All builds complete ==="
        echo "Run: python3 serve.py  (then open http://localhost:8080)"
        ;;
    *)
        echo "Usage: $0 {wasm|app|all}"
        exit 1
        ;;
esac
