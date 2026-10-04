#!/bin/bash
# build.sh — Build both the Octopus WASM engine and the OctOBX TypeScript app.
#
# Prerequisites:
#   - Emscripten SDK activated (source emsdk_env.sh)
#   - Node.js >= 23
#   - Firmware submodule initialized (git submodule update --init)
#
# Usage:
#   ./build.sh         # build everything (WASM + synth + app + desktop launcher)
#   ./build.sh wasm    # build only the WASM module
#   ./build.sh app     # build only the TypeScript app
#   ./build.sh catalog # sync .fxp patches + generate src/patch-catalog.ts (no emcc)

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

    generate_ts_catalog
}

# Generate src/patch-catalog.ts from wasm/obxd/patches/*.fxp — the UI-side
# factory-patch name+category catalog (gitignored). Depends only on the
# synced .fxp files, NOT on emcc, so CI check jobs can run it cheaply.
generate_ts_catalog() {
    local patch_dir="wasm/obxd/patches"
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
    echo "  Generated src/patch-catalog.ts ($(ls "$patch_dir"/*.fxp 2>/dev/null | wc -l) patches)"
}

# Combine the worklet: shim → octopus emcc JS → obxd emcc JS → (optional)
# CakeMix mixer glue → restore layout → task queue → processor tail, one
# classic script for audioWorklet.addModule(). Also stages the mixer
# engine binary into wasm/build/ (vite's publicDir) so the main thread can
# pre-fetch /mixer_wasm_bg.wasm. The committed artifacts in wasm/mixer/
# are refreshed from the sibling CakeMix checkout via
# tools/prep-mixer-wasm.mjs; when absent (and CakeMix unavailable) the
# build degrades gracefully — no glue concat, no binary, and the worklet
# falls back to the legacy C-side master sum.
combine_worklet() {
    # Required inputs — the two emcc glues are products of `make -C wasm` /
    # `make -C wasm/obxd`; the rest are committed sources. If ANY is missing
    # the concat would emit a truncated worklet, so warn and keep the
    # previous wasm/build/obxd-processor.js instead (vite's publicDir copies
    # it verbatim — a stale-but-intact worklet beats a broken one). The
    # mixer glue below stays optional either way.
    local missing=""
    local input
    local nl=$'\n'
    for input in wasm/build/octopus_wasm.js wasm/build/obxd_wasm.js \
                 src/generated/restore-layout.js src/awp-task-queue.js \
                 src/obxd-processor.tail.js src/obxd-awp-shim.js; do
        [ -f "$input" ] || missing="${missing}${nl}  $input"
    done
    if [ -n "$missing" ]; then
        echo "WARNING: combined worklet NOT regenerated — missing required input(s):" >&2
        echo "$missing" >&2
        echo "  (keeping previous wasm/build/obxd-processor.js; run ./build.sh wasm && ./build.sh synth first)" >&2
        return 0
    fi
    local glue_arg=""
    if [ -f wasm/mixer/mixer_wasm_glue.js ] && [ -f wasm/mixer/mixer_wasm_bg.wasm ]; then
        cp wasm/mixer/mixer_wasm_glue.js wasm/build/mixer_wasm_glue.js
        cp wasm/mixer/mixer_wasm_bg.wasm wasm/build/mixer_wasm_bg.wasm
        glue_arg="wasm/build/mixer_wasm_glue.js"
        echo "  Mixer engine: wasm/mixer artifacts staged (glue + binary)"
    else
        echo "  (mixer artifacts missing — attempting tools/prep-mixer-wasm.mjs)"
        if node tools/prep-mixer-wasm.mjs; then
            cp wasm/mixer/mixer_wasm_glue.js wasm/build/mixer_wasm_glue.js
            cp wasm/mixer/mixer_wasm_bg.wasm wasm/build/mixer_wasm_bg.wasm
            glue_arg="wasm/build/mixer_wasm_glue.js"
            echo "  Mixer engine: artifacts refreshed from CakeMix + staged"
        else
            echo "  (mixer engine unavailable — worklet built without it; legacy master sum in effect)"
        fi
    fi
    cp src/obxd-awp-shim.js wasm/build/_awp_shim.js
    cat wasm/build/_awp_shim.js wasm/build/octopus_wasm.js wasm/build/obxd_wasm.js \
        $glue_arg \
        src/generated/restore-layout.js src/awp-task-queue.js src/obxd-processor.tail.js \
        > wasm/build/obxd-processor.js
    rm wasm/build/_awp_shim.js
}

case "${1:-all}" in
    catalog)
        # Sync .fxp patches from the OB-Xf submodule and generate ONLY the
        # TS-side catalog (src/patch-catalog.ts). No emcc required — used
        # by CI check jobs and fresh clones that only run tsc/vitest.
        echo "=== Generating factory patch catalog ==="
        sync_patches
        generate_ts_catalog
        echo "=== Catalog complete ==="
        ;;
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
        # Combined worklet concatenation — same layout as the `all` case
        # below: the octopus glue (OctopusModuleFactory) rides in ahead of
        # the obxd glue so ensureOctopus can boot the sequencer in-worklet,
        # and (when present) the CakeMix mixer glue rides between the obxd
        # glue and the restore layout (see combine_worklet above).
        combine_worklet
        echo "=== Synth build complete ==="
        echo "Output: wasm/build/obxd_wasm.{js,wasm} + wasm/build/obxd-processor.js (combined)"
        ;;
    app)
        echo "=== Building OctOBX TypeScript app ==="
        # Refresh the combined worklet BEFORE the vite build — publicDir is
        # wasm/build, so `npm run build` copies obxd-processor.js into dist/
        # verbatim. Without this, editing src/obxd-processor.tail.js or
        # src/obxd-awp-shim.js and running only `./build.sh app` would ship
        # a stale worklet (combine_worklet warns + keeps the previous one
        # when the emcc glues are missing).
        combine_worklet
        npm install
        npm run build
        echo "=== App build complete ==="
        ;;
    desktop)
        echo "=== Building OctOBX desktop launcher (embedded dist) ==="
        # The egui launcher embeds dist/ at compile time (rust-embed), so
        # the app must be built first. Requires rustup (rust + cargo).
        # Refresh the combined worklet first — same rationale as the `app`
        # case above (vite copies wasm/build into dist verbatim).
        combine_worklet
        npm install
        npm run build
        cargo build --release --manifest-path gui/Cargo.toml
        echo "=== Desktop build complete ==="
        echo "Binary: gui/target/release/octobx_gui (serves embedded app + opens browser)"
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
        # Combined worklet concatenation — see combine_worklet above for the
        # layout rationale (shim → octopus → obxd → mixer glue → layout →
        # task queue → tail).
        combine_worklet
        echo ""
        echo "=== Building OctOBX TypeScript app ==="
        npm install
        npm run build
        echo ""
        echo "=== Building desktop launcher (embedded dist) ==="
        # rust-embed bakes dist/ into the binary at compile time, so the
        # launcher must be rebuilt after every app build.
        cargo build --release --manifest-path gui/Cargo.toml
        echo ""
        echo "=== All builds complete ==="
        echo "Run: python3 serve.py  (then open http://localhost:8080)"
        ;;
    *)
        echo "Usage: $0 {wasm|synth|app|desktop|catalog|all}"
        exit 1
        ;;
esac
