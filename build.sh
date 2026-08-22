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

# Copy all .fxp patches from the OB-Xf submodule into wasm/obxd/patches/,
# flattened with category prefix and zero-padded numbering for stable sort:
#   Basses_001_Acid Bass.fxp, Basses_002_..., Winds_017_...
# This runs every build so new patches in the submodule propagate automatically.
sync_patches() {
    local src_dir="third_party/OB-Xf/assets/installer/Surge Synth Team/OB-Xf/Patches"
    local dst_dir="wasm/obxd/patches"
    mkdir -p "$dst_dir"
    rm -f "$dst_dir"/*.fxp
    if [ ! -d "$src_dir" ]; then
        echo "  (OB-Xf submodule not initialized — skipping patch sync)"
        return 0
    fi
    for category_dir in "$src_dir"/*/; do
        local category
        category=$(basename "$category_dir")
        local idx=1
        for f in "$category_dir"*.fxp; do
            [ -f "$f" ] || continue
            local patch_name
            patch_name=$(basename "$f" .fxp)
            local padded_idx
            padded_idx=$(printf "%03d" "$idx")
            cp "$f" "$dst_dir/${category}_${padded_idx}_${patch_name}.fxp"
            idx=$((idx + 1))
        done
    done
    echo "  Synced $(ls "$dst_dir"/*.fxp 2>/dev/null | wc -l) patches from OB-Xf submodule"
}

# Generate wasm/obxd/patches.h from wasm/obxd/patches/*.fxp.
# Each .fxp becomes a byte array; the lookup tables (pointers, sizes, names,
# categories) are auto-generated so main_obxd.cpp never needs manual editing
# when patches are added or removed.
generate_patches_h() {
    local patch_dir="wasm/obxd/patches"
    rm -f wasm/obxd/patches.h
    if [ ! -d "$patch_dir" ] || ! ls "$patch_dir"/*.fxp >/dev/null 2>&1; then
        echo "  (no .fxp patches found in $patch_dir — using programmatic factory patches)"
        return 0
    fi

    local count=0
    local ptr_entries=""
    local size_entries=""
    local name_entries=""
    local cat_entries=""

    # Sanitized names can collide ("A-B" and "A_B" both -> "patch_A_B"),
    # which would emit duplicate array definitions and break the compile.
    # Uniquify with a _2, _3, ... suffix on collision.
    declare -A seen_syms=()

    for f in "$patch_dir"/*.fxp; do
        local basename_noext
        basename_noext=$(basename "$f" .fxp)
        # Sanitize basename to a valid C identifier for the array symbol.
        local sym_name
        sym_name=$(echo "$basename_noext" | tr -c 'a-zA-Z0-9' '_')
        local sym="patch_${sym_name}"
        local final_sym="$sym"
        local n=2
        while [[ -n "${seen_syms[$final_sym]:-}" ]]; do
            final_sym="${sym}_${n}"
            n=$((n + 1))
        done
        seen_syms[$final_sym]=1
        sym="$final_sym"

        # xxd -i emits `unsigned char <path>[] = {...}` and `<path>_len = N`.
        # Rename the array to our `patch_<sanitized>` symbol, drop _len.
        xxd -i "$f" \
            | sed -e "s/^unsigned char [a-zA-Z0-9_]*\[\]/static const unsigned char ${sym}[]/" \
            | grep -v "_len = " \
            >> wasm/obxd/patches.h
        echo "" >> wasm/obxd/patches.h

        # Extract the 28-byte program name from offset 0x1C in the .fxp.
        # Fall back to the filename if extraction fails.
        local prog_name
        prog_name=$(dd if="$f" bs=1 skip=28 count=28 2>/dev/null | tr -d '\0' | sed 's/"/\\"/g')
        [ -z "$prog_name" ] && prog_name="$basename_noext"

        # Extract the category from the filename prefix (before first _NNN_).
        local category
        category=$(echo "$basename_noext" | sed 's/_[0-9]*_.*//')

        ptr_entries="${ptr_entries}    ${sym},\n"
        size_entries="${size_entries}    sizeof(${sym}),\n"
        name_entries="${name_entries}    \"${prog_name}\",\n"
        cat_entries="${cat_entries}    \"${category}\",\n"

        count=$((count + 1))
    done

    # Append the auto-generated lookup tables.
    {
        echo ""
        echo "#define FACTORY_PATCH_COUNT ${count}"
        echo ""
        echo "static const unsigned char* const g_factory_patches[] = {"
        echo -e "$ptr_entries"
        echo "};"
        echo ""
        echo "static const unsigned g_factory_patch_sizes[] = {"
        echo -e "$size_entries"
        echo "};"
        echo ""
        echo "static const char* const g_factory_patch_names[] = {"
        echo -e "$name_entries"
        echo "};"
        echo ""
        echo "static const char* const g_factory_patch_categories[] = {"
        echo -e "$cat_entries"
        echo "};"
    } >> wasm/obxd/patches.h

    echo "  Generated patches.h from $count .fxp file(s)"

    # Also generate a TS-side catalog for the UI patch browser dropdown.
    # This lets the UI render the full categorized list at module load
    # time without waiting for async worklet RPCs.
    {
        echo "// AUTO-GENERATED by build.sh — do not edit by hand."
        echo "export interface FactoryPatch { name: string; category: string; }"
        echo "export const FACTORY_PATCHES: FactoryPatch[] = ["
        for f in "$patch_dir"/*.fxp; do
            local basename_noext
            basename_noext=$(basename "$f" .fxp)
            local prog_name
            prog_name=$(dd if="$f" bs=1 skip=28 count=28 2>/dev/null | tr -d '\0' | sed 's/"/\\"/g')
            [ -z "$prog_name" ] && prog_name="$basename_noext"
            local category
            category=$(echo "$basename_noext" | sed 's/_[0-9]*_.*//')
            echo "  { name: \"${prog_name}\", category: \"${category}\" },"
        done
        echo "];"
    } > src/patch-catalog.ts
    echo "  Generated src/patch-catalog.ts"
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
        sync_patches
        generate_patches_h
        # Regenerate the parameter dispatch tables from tools/param-spec.mjs
        # (the single source of truth for the OB-Xd→OB-Xf mapping) BEFORE
        # compiling: wasm/obxd/param_table.h is consumed by main_obxd.cpp at
        # build time, and src/obxf-param-mappings.ts +
        # src/generated/param-table.json feed the TS side + tests. Deterministic
        # output — `node tools/gen-param-table.mjs --check` verifies the
        # committed files are fresh (CI gate).
        node tools/gen-param-table.mjs
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
        #
        # Splice the AWP task queue between the emcc output and the processor
        # tail (shim -> emcc JS -> task queue -> tail): the tail references
        # the AwpTaskQueue binding, and everything ships as one classic
        # script, so the queue must ride along in the same concatenation.
        cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
        cat wasm/build/_awp_shim.js wasm/build/obxd_wasm.js src/awp-task-queue.js src/obxd-processor.tail.js > wasm/build/obxd-processor.js
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
        sync_patches
        generate_patches_h
        # Param table generation must precede make — see the comment in the
        # `synth` case above (same step, shared outputs + --check gate).
        node tools/gen-param-table.mjs
        make -C wasm/obxd -f Makefile
        cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
        cat wasm/build/_awp_shim.js wasm/build/obxd_wasm.js src/awp-task-queue.js src/obxd-processor.tail.js > wasm/build/obxd-processor.js
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
