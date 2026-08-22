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
    fn start(port: u16) -> Result<Server, String> {
        let server = Arc::new(
            tiny_http::Server::http(("127.0.0.1", port))
                .map_err(|e| format!("Cannot bind port {}: {}", port, e))?,
        );
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
    http_port: String,
    server: Option<Server>,
    error: String,
}

impl Default for OctobxApp {
    fn default() -> Self {
        Self {
            http_port: "8080".to_string(),
            server: None,
            error: String::new(),
        }
    }
}

impl OctobxApp {
    fn running(&self) -> bool {
        self.server.is_some()
    }

    fn start(&mut self) {
        if self.running() {
            return;
        }
        let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
        match Server::start(port) {
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

fn open_browser(port: u16) {
    let url = format!("http://localhost:{}", port);
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
                ui.label("Web Port:");
                ui.add_enabled(
                    !running,
                    egui::TextEdit::singleline(&mut self.http_port).desired_width(60.0),
                );
            });

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
                        let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
                        open_browser(port);
                    }
                    let port: u16 = self.http_port.trim().parse().unwrap_or(8080);
                    ui.label(format!("http://localhost:{}", port));
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
    //   --no-gui      headless: serve + print URL, no window (Ctrl+C exits)
    //   --port N      override the port (default 8080)
    let mut no_gui = false;
    let mut port_arg: Option<u16> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--no-gui" => no_gui = true,
            "--port" => {
                if let Some(n) = args.next().and_then(|n| n.parse().ok()) {
                    port_arg = Some(n);
                }
            }
            _ => {
                if let Some(n) = a.strip_prefix("--port=") {
                    port_arg = n.parse().ok();
                }
            }
        }
    }

    if no_gui {
        let port = port_arg.unwrap_or(8080);
        match Server::start(port) {
            Ok(_server) => {
                println!(
                    "OctOBX serving on http://localhost:{}  (Ctrl+C to quit)",
                    port
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
            .with_inner_size([440.0, 280.0])
            .with_resizable(true),
        ..Default::default()
    };
    let _ = eframe::run_native(
        "OctOBX",
        options,
        Box::new(move |_cc| {
            let mut app = OctobxApp::default();
            if let Some(port) = port_arg {
                app.http_port = port.to_string();
            }
            // Serving starts immediately at launch; the browser is only
            // opened when the user clicks "Open Browser".
            app.start();
            Ok(Box::new(app))
        }),
    );
}
