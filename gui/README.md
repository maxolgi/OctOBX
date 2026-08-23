# OctOBX desktop launcher (egui)

A small native panel that serves the OctOBX web app from an **embedded copy
of `dist/`** (via `rust-embed`) on localhost and opens the default browser.
The whole app — Octopus sequencer engine, OB-Xf AudioWorklet synth, drum
sampler, Web MIDI — runs in the browser page; the launcher only provides the
localhost origin with the COOP/COEP/CORP headers cross-origin isolation
(SharedArrayBuffer) requires.

Sister app of `octopus_gui` in the [Octopus](https://github.com/maxolgi/Octopus)
repo (same egui launcher pattern; that one hosts the native C engine, this
one serves the WASM app).

## Build

```bash
./build.sh desktop    # from the repo root: builds dist/ then the launcher
# or manually:
npm run build
cargo build --release
```

The build **fails if `dist/` doesn't exist** — `rust-embed` embeds it at
compile time. Rebuild the launcher after every app change.

## Run

```bash
./target/release/octobx_gui              # HTTPS on 127.0.0.1:8080 (self-signed)
./target/release/octobx_gui --port 8090  # same, on a different port
./target/release/octobx_gui --host 0.0.0.0        # serve the LAN (default: 127.0.0.1)
./target/release/octobx_gui --no-gui     # headless: serve + print URL, no window
./target/release/octobx_gui --no-gui --host 0.0.0.0 --port 8090   # flags combine, any order
./target/release/octobx_gui --cert-mode pem --cert-pem cert.pem --key-pem key.pem  # real cert (mkcert/CA)
./target/release/octobx_gui --cert-mode off       # plain HTTP (localhost only)
```

The GUI server auto-starts at launch; the browser opens only when you click
**Open Browser** in the panel (Stop/Start remain available to change the
address/port — both are editable fields). `--no-gui` skips the window
entirely and runs until Ctrl+C. `--host` / the **Bind Address** field accept
any address `tiny_http` can bind; `0.0.0.0` exposes the server on all
interfaces, `127.0.0.1` (default) keeps it local.

## TLS (self-signed, LAN)

HTTPS is ON by default — a non-localhost plain-HTTP origin is
"untrustworthy", so the browser ignores the COOP/COEP headers and
`SharedArrayBuffer` (Emscripten pthreads) is denied. Same scheme as WebSRT:

- On first start a self-signed ECDSA P-256 cert is generated (rcgen) with
  SANs covering `localhost`, `127.0.0.1`, `::1`, the machine hostname, and
  the primary LAN IP.
- It is persisted to `~/.config/octobx/launcher-{cert,key}.pem` and reused
  on every start, so the browser's one-time "proceed anyway" exception
  stays stable. Delete the files to regenerate (e.g. after a LAN IP
  change). `OCTOBX_CERT_DIR` relocates the directory.
- `--cert-mode pem` + `--cert-pem`/`--key-pem` uses a real cert (mkcert,
  LAN CA) for warning-free browsing. `--cert-mode off` disables TLS.

`http://localhost` is a secure context, so Web MIDI + AudioWorklet work
without HTTPS.

## Windows

Cross-compile from Linux (mirrors the Octopus repo flow):

```bash
rustup target add x86_64-pc-windows-gnu
sudo apt install mingw-w64   # x86_64-w64-mingw32-gcc
cargo build --release --target x86_64-pc-windows-gnu
# → target/x86_64-pc-windows-gnu/release/octobx_gui.exe
```

## Implementation notes

- `tiny_http` with a small acceptor-thread pool (3 + one poller); graceful
  stop via the stop flag + `Server::unblock()`.
- Every response carries COOP/COEP/CORP headers; `.wasm` → `application/wasm`.
- HTML is served `Cache-Control: no-store`, everything else `max-age=3600`
  (hashed asset names make that safe).
- Path traversal is rejected before the embedded asset lookup.
