#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ffmpeg;
mod pixverse;
mod storage;
mod thumbs;
mod utils;

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use storage::{load_graph, save_graph};
use tauri::http::{ResponseBuilder, status::StatusCode};
use tauri::{AppHandle, Window};
use utils::{expand_tilde, percent_decode};

// ─── Node router ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn run_node(
    app: AppHandle,
    window: Window,
    node: Value,
    deps: Vec<Value>,
    config: Value,
    run_id: String,
) -> Result<Value, String> {
    match cli_bin_name(&node).as_str() {
        "pixverse" => pixverse::run_pixverse(app, window, node, deps, config, run_id).await,
        "ffmpeg"   => ffmpeg::run_ffmpeg(app, window, node, deps, config, run_id).await,
        other      => Err(format!("Unsupported command: {other}")),
    }
}

/// Extract the bare binary name from a node (handles both provider nodes and CLI nodes).
fn cli_bin_name(node: &Value) -> String {
    // Provider-based PixVerse node (kind=gen/motion, provider=pixverse)
    if node
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s == "pixverse")
        .unwrap_or(false)
    {
        return "pixverse".to_string();
    }
    // CLI node — first token of cmd/bin, last path component
    let raw = node
        .get("cli")
        .and_then(|c| c.get("cmd").or_else(|| c.get("bin")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    expand_tilde(raw)
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split(['/', '\\'])
        .last()
        .unwrap_or("")
        .to_string()
}

// ─── Download output to user-chosen directory ─────────────────────────────────
//
// Copies `src` into `{dest_dir}/{filename}`.
// Returns the full destination path on success.
#[tauri::command]
fn copy_to_downloads(src: String, project_name: String, dest_dir: String) -> Result<String, String> {
    let src_expanded = expand_tilde(&src);
    let src_path = std::path::Path::new(&src_expanded);
    if !src_path.exists() {
        return Err(format!("Source file not found: {src_expanded}"));
    }

    // Derive file extension from source
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();

    // Sanitize project name: keep alphanumerics + spaces, replace everything else with _
    let safe_name: String = project_name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_");
    let safe_name = if safe_name.is_empty() { "Output".to_string() } else { safe_name };

    let dest_root = expand_tilde(&dest_dir);
    let dest_subdir = std::path::Path::new(&dest_root);
    std::fs::create_dir_all(dest_subdir).map_err(|e| format!("Cannot create directory: {e}"))?;

    // Find the next available index: ProjectName_01.ext, _02.ext, …
    let mut idx = 1u32;
    let dest_file = loop {
        let candidate = dest_subdir.join(format!("{safe_name}_{idx:02}.{ext}"));
        if !candidate.exists() {
            break candidate;
        }
        idx += 1;
        if idx > 9999 {
            break dest_subdir.join(format!("{safe_name}_{idx}.{ext}"));
        }
    };

    std::fs::copy(src_path, &dest_file).map_err(|e| format!("Copy failed: {e}"))?;

    dest_file
        .to_str()
        .map(String::from)
        .ok_or_else(|| "Destination path contains invalid UTF-8".to_string())
}

// ─── Local media protocol for video preview ──────────────────────────────────
//
// Tauri's built-in asset:// protocol is fine for images, but local video in
// WebKit is stricter about MIME and byte-range responses. This custom protocol
// serves rendered videos from disk with explicit video/* headers and Range
// support so <video> can paint output-node previews in dev and packaged builds.
fn media_protocol(
    app: &AppHandle,
    request: &tauri::http::Request,
) -> Result<tauri::http::Response, Box<dyn std::error::Error>> {
    let uri = request.uri();
    let encoded = uri
        .strip_prefix("atlasmedia://localhost/")
        .unwrap_or_else(|| uri.trim_start_matches('/'));
    let raw_path = percent_decode(encoded);
    let path = std::path::PathBuf::from(&raw_path);
    let canonical = std::fs::canonicalize(&path)?;

    let app_data = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Cannot resolve app data dir")?;
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| app_data.clone());
    let allowed = canonical.starts_with(&app_data) || canonical.starts_with(&home);
    if !allowed {
        return Ok(ResponseBuilder::new().status(403).body(Vec::new())?);
    }

    let mut file = std::fs::File::open(&canonical)?;
    let len = file.metadata()?.len();
    let mime = media_mime(&canonical);
    let mut response = ResponseBuilder::new()
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes");

    if let Some((start, end)) = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|range| parse_byte_range(range, len))
    {
        let read_len = end + 1 - start;
        let mut buf = vec![0; read_len as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header("Content-Length", read_len.to_string())
            .header("Content-Range", format!("bytes {start}-{end}/{len}"));
        return Ok(response.body(buf)?);
    }

    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf)?;
    Ok(response
        .status(StatusCode::OK)
        .header("Content-Length", len.to_string())
        .body(buf)?)
}

fn parse_byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let range = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start_s, end_s) = range.split_once('-')?;
    if start_s.is_empty() {
        let suffix = end_s.parse::<u64>().ok()?.min(len);
        return Some((len - suffix, len - 1));
    }
    let start = start_s.parse::<u64>().ok()?;
    if start >= len {
        return None;
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        end_s.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn media_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/mp4",
        "mp4" => "video/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("atlasmedia", media_protocol)
        .invoke_handler(tauri::generate_handler![load_graph, save_graph, run_node, copy_to_downloads])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
