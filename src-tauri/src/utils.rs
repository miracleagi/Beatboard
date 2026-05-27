// Path helpers and environment utilities.
// All functions here are pure: no Tauri types, no I/O side-effects beyond std::env/fs reads.

use std::path::Path;

/// Expand a leading `~/` to `$HOME/`.
pub fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{}/{}", home, &path[2..])
    } else {
        path.to_string()
    }
}

/// Build a PATH string that prepends the directories macOS GUI apps miss
/// (Homebrew, npm-global, nvm active version) in front of the inherited PATH.
pub fn npm_augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let existing = std::env::var("PATH").unwrap_or_default();

    let mut parts: Vec<String> = vec![
        "/usr/local/bin".into(),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.local/bin"),
    ];

    // Resolve the nvm default alias → real version path
    if let Ok(ver) = std::fs::read_to_string(format!("{home}/.nvm/alias/default")) {
        let v = ver.trim();
        let nvm_bin = format!("{home}/.nvm/versions/node/{v}/bin");
        if Path::new(&nvm_bin).exists() {
            parts.push(nvm_bin);
        }
    }

    if !existing.is_empty() {
        parts.push(existing);
    }
    parts.join(":")
}

/// Search common filesystem locations for a bare binary name (e.g. "pixverse").
/// Returns a full path if found; otherwise returns the name as-is so the OS can try.
pub fn find_bin(name: &str) -> String {
    if name.contains('/') {
        return name.to_string(); // already absolute / relative path
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("/usr/local/bin/{name}"),
        format!("/opt/homebrew/bin/{name}"),
        format!("{home}/.npm-global/bin/{name}"),
        format!("{home}/.local/bin/{name}"),
    ];
    for p in &candidates {
        if Path::new(p).exists() {
            return p.clone();
        }
    }
    // Check nvm active node version
    if let Ok(ver) = std::fs::read_to_string(format!("{home}/.nvm/alias/default")) {
        let v = ver.trim();
        let p = format!("{home}/.nvm/versions/node/{v}/bin/{name}");
        if Path::new(&p).exists() {
            return p;
        }
    }
    name.to_string()
}

/// Minimal URL percent-decoding (no external crates).
pub fn percent_decode(s: &str) -> String {
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push(char::from(h * 16 + l));
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
