#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! OctOBX GUI — desktop launcher for the OctOBX browser app.
//!
//! The entire app (Octopus sequencer engine WASM, OB-Xf AudioWorklet synth,
//! drum sampler, Web MIDI) runs in the browser page; this launcher serves
//! the built app from an embedded copy of dist/ on localhost with the
//! COOP/COEP/CORP headers cross-origin isolation (SharedArrayBuffer)
//! requires. Serving starts automatically at launch; the browser opens only
//! via the "Open Browser" button.
//!
//! Rebuild after ./build.sh — the dist/ tree is embedded at compile time.

use eframe::egui;
use rust_embed::RustEmbed;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

mod cert;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Dist;

const NUM_ACCEPTORS: usize = 3;

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "wasm" => "application/wasm",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes().to_vec(), value.as_bytes().to_vec()).unwrap()
}

fn respond(request: tiny_http::Request) {
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    let path = percent_decode(&url);
    let path = if path == "/" {
        "/index.html".to_string()
    } else {
        path
    };

    // Traversal guard — the embedded asset table is keyed by clean relative
    // paths anyway, but reject anything suspicious before the lookup.
    if path.split('/').any(|seg| seg == "..") {
        let _ = request.respond(tiny_http::Response::from_string("403").with_status_code(403));
        return;
    }

    let rel = path.trim_start_matches('/');
    let response = match Dist::get(rel) {
        Some(file) => tiny_http::Response::from_data(file.data)
            .with_header(header("Content-Type", mime_for(rel)))
            .with_header(header(
                "Cache-Control",
                if rel.ends_with(".html") {
                    "no-store"
                } else {
                    "max-age=3600"
                },
            ))
            .with_header(header("Cross-Origin-Opener-Policy", "same-origin"))
            .with_header(header("Cross-Origin-Embedder-Policy", "require-corp"))
            .with_header(header("Cross-Origin-Resource-Policy", "same-origin")),
        None => tiny_http::Response::from_string("404").with_status_code(404),
    };
    let _ = request.respond(response);
}

struct Server {
    stop: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
    server: Arc<tiny_http::Server>,
}

impl Server {
    fn start(host: &str, port: u16, tls: Option<cert::TlsMaterial>) -> Result<Server, String> {
        let addr = (host, port);
        let server = match tls {
            None => Arc::new(
                tiny_http::Server::http(addr)
                    .map_err(|e| format!("Cannot bind {}:{}: {}", host, port, e))?,
            ),
            Some(tls) => Arc::new(
                tiny_http::Server::https(
                    addr,
                    tiny_http::SslConfig {
                        certificate: tls.certificate,
                        private_key: tls.private_key,
                    },
                )
                .map_err(|e| format!("Cannot bind https://{}:{}: {}", host, port, e))?,
            ),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::with_capacity(NUM_ACCEPTORS + 1);

        // Acceptor threads: plain blocking recv(), exit on error once the
        // stop flag is set (the stop path unblock()s each of them).
        for _ in 0..NUM_ACCEPTORS {
            let server = server.clone();
            let stop = stop.clone();
            handles.push(std::thread::spawn(move || {
                loop {
                    match server.recv() {
                        Ok(request) => respond(request),
                        Err(_) => {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                    }
                }
            }));
        }

        // Main poller: timeout-based recv so it observes the stop flag.
        {
            let server = server.clone();
            let stop = stop.clone();
            handles.push(std::thread::spawn(move || {
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match server.recv_timeout(Duration::from_millis(250)) {
                        Ok(Some(request)) => respond(request),
                        Ok(None) => continue,
                        Err(_) => continue,
                    }
                }
            }));
        }

        Ok(Server {
            stop,
            handles,
            server,
        })
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock every acceptor stuck in recv() (one call per thread).
        for _ in 0..NUM_ACCEPTORS {
            self.server.unblock();
        }
        // The poller observes the flag within its 250ms timeout.
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

struct OctobxApp {
    http_host: String,
    http_port: String,
    use_tls: bool,
    server: Option<Server>,
    error: String,
}

impl Default for OctobxApp {
    fn default() -> Self {
        Self {
            http_host: "127.0.0.1".to_string(),
            http_port: "8080".to_string(),
            use_tls: true,
            server: None,
            error: String::new(),
        }
    }
}

impl OctobxApp {
    fn running(&self) -> bool {
        self.server.is_some()
    }

    fn scheme(&self) -> &'static str {
        if self.use_tls { "https" } else { "http" }
    }

    fn start(&mut self) {
        if self.running() {
            return;
        }
        let host = self.http_host.trim();
        let host = if host.is_empty() { "127.0.0.1" } else { host };
        let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
        let tls = if self.use_tls {
            match self_signed_or_reuse(host) {
                Ok(t) => Some(t),
                Err(e) => {
                    self.error = e;
                    return;
                }
            }
        } else {
            None
        };
        match Server::start(host, port, tls) {
            Ok(server) => {
                self.server = Some(server);
                self.error.clear();
            }
            Err(e) => self.error = e,
        }
    }

    fn stop(&mut self) {
        if let Some(mut server) = self.server.take() {
            server.stop();
        }
    }
}

/*
 * Self-signed TLS material, WebSRT-style: reuse the persisted cert under the
 * config dir so the browser's certificate exception stays stable; generate +
 * persist on first start (or when the files are gone). Extra SAN: the bind
 * host when it is a concrete IP.
 */
fn self_signed_or_reuse(host: &str) -> Result<cert::TlsMaterial, String> {
    let (cert_path, key_path) = cert::persisted_cert_paths();
    if cert_path.exists() && key_path.exists() {
        eprintln!("TLS: reusing persisted self-signed cert ({})", cert_path.display());
        return cert::build(cert::CertSource::Pem { cert: cert_path, key: key_path });
    }

    let mut extra = Vec::new();
    if host.parse::<std::net::IpAddr>().is_ok() && host != "0.0.0.0" && host != "::" {
        extra.push(host.to_string());
    }
    let sans = cert::self_signed_sans(&extra);
    let material = cert::build(cert::CertSource::SelfSigned { sans })?;

    if let Err(e) = std::fs::create_dir_all(cert::config_dir())
        .and_then(|()| std::fs::write(&cert_path, &material.certificate))
        .and_then(|()| std::fs::write(&key_path, &material.private_key))
    {
        // Non-fatal: the cert still works this session; it just regenerates
        // next start (browser shows the warning again).
        eprintln!("TLS: failed to persist self-signed cert ({e}); will regenerate next start");
    } else {
        eprintln!("TLS: generated self-signed cert -> {} (+ key)", cert_path.display());
    }
    Ok(material)
}

fn open_browser(scheme: &str, host: &str, port: u16) {
    // 0.0.0.0 (or ::) is a bind address, not a browsing address.
    let browse_host = if host == "0.0.0.0" || host == "::" || host.is_empty() {
        "localhost"
    } else {
        host
    };
    let url = format!("{}://{}:{}", scheme, browse_host, port);
    #[cfg(target_os = "linux")]

    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
}

impl eframe::App for OctobxApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Stop the server before the window closes — eframe may skip Drop
        if ctx.input(|i| i.viewport().close_requested()) {
            self.stop();
        }
        if self.running() {
            ctx.request_repaint_after(Duration::from_millis(500));
        }
    }

    fn on_exit(&mut self) {
        self.stop();
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let running = self.running();

        egui::CentralPanel::default().show(ui, |ui| {
            ui.add_space(8.0);
            ui.heading("OctOBX");
            ui.label("Octopus sequencer + OB-Xf synth in the browser");
            ui.add_space(8.0);
            ui.separator();
            ui.add_space(8.0);

            ui.horizontal(|ui| {
                ui.label("Bind Address:");
                ui.add_enabled(
                    !running,
                    egui::TextEdit::singleline(&mut self.http_host).desired_width(100.0),
                );
                ui.label("Port:");
                ui.add_enabled(
                    !running,
                    egui::TextEdit::singleline(&mut self.http_port).desired_width(60.0),
                );
            });
            if !running {
                ui.small("Bind 0.0.0.0 to serve the LAN (default 127.0.0.1 = this machine only)");
            }
            ui.horizontal(|ui| {
                ui.add_enabled(!running, egui::Checkbox::new(&mut self.use_tls, "HTTPS (self-signed)"));
            });
            if !running && self.use_tls {
                ui.small(format!("Cert persisted in {} — accept the browser warning once", cert::config_dir().display()));
            } else if !running {
                ui.small("HTTP only works on http://localhost (SharedArrayBuffer needs HTTPS elsewhere)");
            }
            ui.add_space(8.0);
            ui.separator();
            ui.add_space(8.0);

            ui.horizontal(|ui| {
                if !running {
                    if ui
                        .add(egui::Button::new("Start").min_size(egui::vec2(100.0, 28.0)))
                        .clicked()
                    {
                        self.start();
                    }
                } else if ui
                    .add(egui::Button::new("Stop").min_size(egui::vec2(100.0, 28.0)))
                    .clicked()
                {
                    self.stop();
                }
                let color = if running {
                    egui::Color32::from_rgb(0, 180, 0)
                } else {
                    egui::Color32::from_rgb(180, 0, 0)
                };
                ui.colored_label(
                    color,
                    format!("● {}", if running { "Serving" } else { "Stopped" }),
                );
            });

            if running {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    if ui.button("Open Browser").clicked() {
                        let host = self.http_host.trim().to_string();
                        let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
                        open_browser(self.scheme(), &host, port);
                    }
                    let host = self.http_host.trim();
                    let browse_host = if host == "0.0.0.0" || host == "::" || host.is_empty() {
                        "localhost"
                    } else {
                        host
                    };
                    let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
                    ui.label(format!("{}://{}:{}", self.scheme(), browse_host, port));
                });
            }

            ui.add_space(4.0);

            if !self.error.is_empty() {
                ui.add_space(8.0);
                ui.colored_label(egui::Color32::from_rgb(200, 80, 80), &self.error);
            }
        });
    }
}

fn main() {
    // Flags (any order):
    //   --no-gui            headless: serve + print URL, no window (Ctrl+C exits)
    //   --host ADDR         bind address (default 127.0.0.1; use 0.0.0.0 for LAN)
    //   --port N            override the port (default 8080)
    //   --cert-mode MODE    self (default): persisted self-signed cert
    //                       pem: use --cert-pem/--key-pem (e.g. mkcert)
    //                       off: plain HTTP (localhost only)
    //   --cert-pem PATH     cert PEM for --cert-mode pem
    //   --key-pem PATH      key PEM for --cert-mode pem
    let mut no_gui = false;
    let mut host_arg: Option<String> = None;
    let mut port_arg: Option<u16> = None;
    let mut cert_mode = CertMode::Self_;
    let mut cert_pem: Option<String> = None;
    let mut key_pem: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--no-gui" => no_gui = true,
            "--host" => {
                if let Some(h) = args.next() {
                    host_arg = Some(h);
                }
            }
            "--port" => {
                if let Some(n) = args.next().and_then(|n| n.parse().ok()) {
                    port_arg = Some(n);
                }
            }
            "--cert-mode" => match args.next().as_deref() {
                Some("self") => cert_mode = CertMode::Self_,
                Some("pem") => cert_mode = CertMode::Pem,
                Some("off") | Some("http") => cert_mode = CertMode::Off,
                other => {
                    eprintln!("unknown --cert-mode {other:?} (expected self|pem|off)");
                    std::process::exit(2);
                }
            },
            "--cert-pem" => cert_pem = args.next(),
            "--key-pem" => key_pem = args.next(),
            _ => {
                if let Some(h) = a.strip_prefix("--host=") {
                    host_arg = Some(h.to_string());
                } else if let Some(n) = a.strip_prefix("--port=") {
                    port_arg = n.parse().ok();
                } else if let Some(m) = a.strip_prefix("--cert-mode=") {
                    cert_mode = match m {
                        "self" => CertMode::Self_,
                        "pem" => CertMode::Pem,
                        "off" | "http" => CertMode::Off,
                        _ => {
                            eprintln!("unknown --cert-mode {m:?} (expected self|pem|off)");
                            std::process::exit(2);
                        }
                    };
                } else if let Some(p) = a.strip_prefix("--cert-pem=") {
                    cert_pem = Some(p.to_string());
                } else if let Some(p) = a.strip_prefix("--key-pem=") {
                    key_pem = Some(p.to_string());
                }
            }
        }
    }

    if no_gui {
        let host = host_arg
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or("127.0.0.1");
        let port = port_arg.unwrap_or(8080);
        let tls = build_tls(cert_mode, &cert_pem, &key_pem, host).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(1);
        });
        let scheme = if tls.is_some() { "https" } else { "http" };
        match Server::start(host, port, tls) {
            Ok(_server) => {
                let browse_host = if host == "0.0.0.0" || host == "::" {
                    "localhost"
                } else {
                    host
                };
                println!(
                    "OctOBX serving on {}://{}:{}  (bound to {})  (Ctrl+C to quit)",
                    scheme, browse_host, port, host
                );
                // Park forever; SIGINT's default action terminates the
                // process, taking the server threads with it.
                loop {
                    std::thread::park();
                }
            }
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([440.0, 330.0])
            .with_resizable(true),
        ..Default::default()
    };
    let _ = eframe::run_native(
        "OctOBX",
        options,
        Box::new(move |_cc| {
            let mut app = OctobxApp::default();
            if let Some(host) = host_arg {
                let host = host.trim().to_string();
                if !host.is_empty() {
                    app.http_host = host;
                }
            }
            if let Some(port) = port_arg {
                app.http_port = port.to_string();
            }
            if cert_mode == CertMode::Off {
                app.use_tls = false;
            }
            // Serving starts immediately at launch; the browser is only
            // opened when the user clicks "Open Browser".
            app.start();
            Ok(Box::new(app))
        }),
    );
}

#[derive(Clone, Copy, PartialEq)]
enum CertMode {
    Self_,
    Pem,
    Off,
}

fn build_tls(
    mode: CertMode,
    cert_pem: &Option<String>,
    key_pem: &Option<String>,
    host: &str,
) -> Result<Option<cert::TlsMaterial>, String> {
    match mode {
        CertMode::Off => Ok(None),
        CertMode::Pem => {
            let cert = cert_pem
                .clone()
                .ok_or_else(|| "--cert-pem required for --cert-mode pem".to_string())?;
            let key = key_pem
                .clone()
                .ok_or_else(|| "--key-pem required for --cert-mode pem".to_string())?;
            cert::build(cert::CertSource::Pem {
                cert: std::path::PathBuf::from(cert),
                key: std::path::PathBuf::from(key),
            })
            .map(Some)
        }
        CertMode::Self_ => self_signed_or_reuse(host).map(Some),
    }
}
