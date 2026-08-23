//! Certificate generation for the OctOBX launcher's HTTPS server.
//!
//! Mode A (default, `--cert-mode self`):
//!   Self-signed ECDSA P-256 cert generated on first start (via rcgen),
//!   persisted to the config dir (~/.config/octobx/) and REUSED on every
//!   subsequent start so the browser's certificate exception stays stable.
//!   SANs cover localhost, the loopback IPs, the machine hostname, and the
//!   primary LAN IP, so browsing https://<lan-ip>:port only shows the
//!   self-signed warning — not a hostname-mismatch on top of it.
//!
//! Mode B (`--cert-mode pem`):
//!   Load PEM cert/key files from disk (e.g. produced by `mkcert` or a real
//!   CA). Browser uses normal PKI validation.
//!
//! Mode C (`--cert-mode off`):
//!   Plain HTTP. Only works as a secure context on http://localhost —
//!   SharedArrayBuffer (Emscripten pthreads) is denied otherwise.
//!
//! Mirrors the WebSRT gateway's cert handling (crates/websrt/src/cert.rs).

use std::path::PathBuf;

pub enum CertSource {
    /// Generated self-signed; caller persists the returned PEM for reuse.
    SelfSigned { sans: Vec<String> },
    /// Loaded from PEM files on disk.
    Pem { cert: PathBuf, key: PathBuf },
}

/// PEM-encoded certificate chain + PKCS#8 private key, ready for
/// `tiny_http::SslConfig`.
pub struct TlsMaterial {
    pub certificate: Vec<u8>,
    pub private_key: Vec<u8>,
}

pub fn build(src: CertSource) -> Result<TlsMaterial, String> {
    match src {
        CertSource::SelfSigned { sans } => build_self_signed(sans),
        CertSource::Pem { cert, key } => build_pem(cert, key),
    }
}

fn build_self_signed(sans: Vec<String>) -> Result<TlsMaterial, String> {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(sans)
            .map_err(|e| format!("self-signed cert generation failed: {e}"))?;
    Ok(TlsMaterial {
        certificate: cert.pem().into_bytes(),
        private_key: signing_key.serialize_pem().into_bytes(),
    })
}

fn build_pem(cert_path: PathBuf, key_path: PathBuf) -> Result<TlsMaterial, String> {
    let certificate = std::fs::read(&cert_path)
        .map_err(|e| format!("cannot read certificate '{}': {e}", cert_path.display()))?;
    let private_key = std::fs::read(&key_path)
        .map_err(|e| format!("cannot read key '{}': {e}", key_path.display()))?;
    Ok(TlsMaterial {
        certificate,
        private_key,
    })
}

/// Config dir for the persisted self-signed cert. `OCTOBX_CERT_DIR` overrides;
/// defaults to `$HOME/.config/octobx` (or `%USERPROFILE%\.config\octobx`).
pub fn config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("OCTOBX_CERT_DIR")
        && !d.trim().is_empty()
    {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("octobx")
}

/// The persisted self-signed cert/key paths inside [`config_dir`].
pub fn persisted_cert_paths() -> (PathBuf, PathBuf) {
    let dir = config_dir();
    (dir.join("launcher-cert.pem"), dir.join("launcher-key.pem"))
}

/// Subject Alternate Names for LAN self-signed certs: loopback names/IPs,
/// the machine hostname, and the primary LAN IP (best effort — a UDP
/// "connect" to a public address reveals the outbound interface IP without
/// sending any packet). Extra hosts (e.g. a specific --host) are appended.
pub fn self_signed_sans(extra: &[String]) -> Vec<String> {
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Ok(host) = std::env::var("HOSTNAME") {
        if !host.trim().is_empty() {
            sans.push(host.trim().to_string());
        }
    } else if let Some(name) = hostname() {
        sans.push(name);
    }
    if let Some(ip) = primary_lan_ip() {
        let ip = ip.to_string();
        if !sans.contains(&ip) {
            sans.push(ip);
        }
    }
    for e in extra {
        if !e.trim().is_empty() && !sans.contains(e) {
            sans.push(e.clone());
        }
    }
    sans
}

fn hostname() -> Option<String> {
    // Works on Linux/macOS; on Windows HOSTNAME is usually set instead.
    let s = std::fs::read_to_string("/proc/sys/kernel/hostname").ok()?;
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Outbound interface IP via a packet-less UDP "connect".
fn primary_lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip())
}
