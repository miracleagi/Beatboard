// PixVerse CLI execution: argument resolution and subprocess management.

use crate::storage::runs_dir;
use crate::thumbs::{collect_thumbs, parse_json_output, resolve_asset_thumbs};
use crate::utils::{expand_tilde, find_bin, npm_augmented_path, percent_decode};
use serde_json::Value;
use std::process::Stdio;
use tauri::{AppHandle, Window};
use tokio::process::Command;

// ─── Prompt / image extraction ───────────────────────────────────────────────

/// Find the text prompt for a node: checks the node's own `prompt` field first,
/// then looks at connected prompt-kind dep nodes. Motion nodes append `motionPrompt`.
pub fn first_prompt(node: &Value, deps: &[Value]) -> String {
    if let Some(p) = node.get("prompt").and_then(|v| v.as_str()) {
        if !p.is_empty() {
            return p.to_string();
        }
    }
    let connected: Option<String> = deps.iter().find_map(|dep| {
        let from = dep.get("from")?;
        if from.get("kind")?.as_str()? != "prompt" {
            return None;
        }
        let p = from.get("prompt")?.as_str()?;
        if p.is_empty() { None } else { Some(p.to_string()) }
    });

    let motion_prompt = node
        .get("motionPrompt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    match (connected, motion_prompt) {
        (Some(p), Some(m)) => format!("{p}\nMotion: {m}"),
        (Some(p), None) => p,
        (None, Some(m)) => m,
        (None, None) => String::new(),
    }
}

/// Return the first image URL or path from any upstream dep's thumbs.
pub fn first_image_input(deps: &[Value]) -> String {
    for dep in deps {
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(thumbs) = thumbs_ptr.and_then(|t| t.as_array()) {
                for thumb in thumbs {
                    if let Some(p) = thumb.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        return p.to_string();
                    }
                    if let Some(p) = thumb.get("local_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        return p.to_string();
                    }
                    if let Some(p) = thumb.get("localPath").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        return p.to_string();
                    }
                    if let Some(u) = thumb.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        // Decode atlasmedia:// / asset:// back to a real local path.
                        if u.starts_with("atlasmedia://localhost") {
                            return percent_decode(u.trim_start_matches("atlasmedia://localhost"));
                        }
                        if u.starts_with("asset://localhost") {
                            return percent_decode(u.trim_start_matches("asset://localhost"));
                        }
                        return u.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

/// Extract a single media path from a thumb object (shared helper).
fn thumb_path(thumb: &Value) -> String {
    if let Some(p) = thumb.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return p.to_string();
    }
    if let Some(p) = thumb.get("local_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return p.to_string();
    }
    if let Some(p) = thumb.get("localPath").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return p.to_string();
    }
    if let Some(u) = thumb.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        if u.starts_with("atlasmedia://localhost") {
            return percent_decode(u.trim_start_matches("atlasmedia://localhost"));
        }
        if u.starts_with("asset://localhost") {
            return percent_decode(u.trim_start_matches("asset://localhost"));
        }
        return u.to_string();
    }
    String::new()
}

/// Return all media paths from deps whose thumbs have the given type ("image" or "video"),
/// sorted by destination port index.  Used for {images} and {videos} multi-value tokens.
fn all_inputs_of_type(deps: &[Value], kind: &str) -> Vec<String> {
    let is_video = kind == "video";
    let mut entries: Vec<(u64, String)> = Vec::new();
    for dep in deps {
        let port_idx = dep.get("edge")
            .and_then(|e| e.get("to"))
            .and_then(|t| t.get("port"))
            .and_then(|p| p.as_u64())
            .unwrap_or(999);
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(thumbs) = thumbs_ptr.and_then(|t| t.as_array()) {
                let mut found = false;
                for thumb in thumbs {
                    // "type" is the serde rename of thumb_type
                    let ttype = thumb.get("type").and_then(|v| v.as_str()).unwrap_or("image");
                    let matches = if is_video { ttype == "video" } else { ttype == "image" };
                    if matches {
                        let p = thumb_path(thumb);
                        if !p.is_empty() {
                            entries.push((port_idx, p));
                            found = true;
                            break;
                        }
                    }
                }
                if found { break; }
            }
        }
    }
    entries.sort_by_key(|(p, _)| *p);
    entries.into_iter().map(|(_, path)| path).collect()
}

/// Return the PixVerse cloud video/asset ID from the first upstream dep result.
/// This is the `id` field stored on a Thumb — set from video_id / asset_id / id
/// in the API JSON response.  Used for `--video-id` in extend/upscale/speech.
/// Falls back to the local file path so the flag is never completely empty.
fn first_video_id(deps: &[Value]) -> String {
    for dep in deps {
        // Prefer result thumbs over node thumbs (result is from the actual run)
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(thumbs) = thumbs_ptr.and_then(|t| t.as_array()) {
                for thumb in thumbs {
                    // Prefer the cloud ID field
                    if let Some(id) = thumb.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        return id.to_string();
                    }
                }
                // No cloud ID found in this dep; fall back to local path
                for thumb in thumbs {
                    let p = thumb_path(thumb);
                    if !p.is_empty() {
                        return p;
                    }
                }
            }
        }
    }
    String::new()
}

/// Return media paths from all deps, sorted by the destination port index.
/// This lets args like {from}/{to} reliably reference port 0 / port 1 inputs.
fn sorted_media_inputs(deps: &[Value]) -> Vec<String> {
    let mut entries: Vec<(u64, String)> = Vec::new();
    for dep in deps {
        let port_idx = dep.get("edge")
            .and_then(|e| e.get("to"))
            .and_then(|t| t.get("port"))
            .and_then(|p| p.as_u64())
            .unwrap_or(999);
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(thumbs) = thumbs_ptr.and_then(|t| t.as_array()) {
                for thumb in thumbs {
                    let p = thumb_path(thumb);
                    if !p.is_empty() {
                        entries.push((port_idx, p));
                        break;
                    }
                }
                if entries.last().map(|(pi, _)| *pi == port_idx).unwrap_or(false) {
                    break; // one path per dep
                }
            }
        }
    }
    entries.sort_by_key(|(p, _)| *p);
    entries.into_iter().map(|(_, path)| path).collect()
}

// ─── Argument builders ───────────────────────────────────────────────────────

/// Build the CLI argument list for a PixVerse node.
/// Handles both provider-based gen/motion nodes and raw CLI nodes.
pub fn resolve_pixverse_args(node: &Value, deps: &[Value]) -> Result<Vec<String>, String> {
    let kind = node.get("kind").and_then(|v| v.as_str()).unwrap_or("gen");
    if kind == "gen" || kind == "motion" {
        return build_provider_args(node, deps);
    }

    // CLI node — substitute {prompt}, {image}, {from}, {to}, {video}, {in}, {prev.out} tokens
    let raw_args: Vec<String> = node
        .get("cli")
        .and_then(|c| c.get("args"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let prompt = first_prompt(node, deps);
    let image = first_image_input(deps);
    let video_id = first_video_id(deps);
    let sorted = sorted_media_inputs(deps);
    let from_input = sorted.first().cloned().unwrap_or_default();
    let to_input   = sorted.get(1).cloned().unwrap_or_default();
    // {video} = same as {image} — a file path for a video dep
    let video_input = image.clone();
    // Multi-value tokens: expand to one arg per connected dep of that type
    let all_images = all_inputs_of_type(deps, "image");
    let all_videos = all_inputs_of_type(deps, "video");

    let mut out: Vec<String> = Vec::new();
    // Tracks whether {from} was just dropped so we also drop the sibling {to}
    // (used by `--images {from} {to}` multi-value pattern).
    let mut dropped_from = false;

    for arg in &raw_args {
        // If {from} was dropped on the previous iteration, also drop {to}
        // so the --images group doesn't leave an orphan path argument.
        if dropped_from && arg.contains("{to}") {
            dropped_from = false;
            continue;
        }
        dropped_from = false;

        // ── Multi-value expansion tokens ──────────────────────────────────
        // {images} expands to N separate args (one per connected image dep).
        // {videos} expands to N separate args (one per connected video dep).
        if arg == "{images}" {
            if all_images.is_empty() {
                if out.last().map(|s: &String| s.starts_with("--")).unwrap_or(false) {
                    out.pop();
                }
            } else {
                out.extend(all_images.clone());
            }
            continue;
        }
        if arg == "{videos}" {
            if all_videos.is_empty() {
                if out.last().map(|s: &String| s.starts_with("--")).unwrap_or(false) {
                    out.pop();
                }
            } else {
                out.extend(all_videos.clone());
            }
            continue;
        }

        // ── Single-value optional tokens ──────────────────────────────────
        let needs_drop = |token: &str, val: &str| arg.contains(token) && val.is_empty();
        if needs_drop("{prompt}", &prompt)
            || needs_drop("{image}", &image)
            || needs_drop("{video_id}", &video_id)
            || needs_drop("{from}", &from_input)
            || needs_drop("{to}", &to_input)
            || needs_drop("{video}", &video_input)
        {
            // Note whether we just dropped a {from} so we can chain-drop {to}
            if arg.contains("{from}") && from_input.is_empty() {
                dropped_from = true;
            }
            if out.last().map(|s: &String| s.starts_with("--")).unwrap_or(false) {
                out.pop();
            }
            continue;
        }
        out.push(
            arg.replace("{prompt}", &prompt)
                .replace("{image}", &image)
                .replace("{video_id}", &video_id)
                .replace("{from}", &from_input)
                .replace("{to}", &to_input)
                .replace("{video}", &video_input)
                .replace("{in}", &image)
                .replace("{prev.out}", &image),
        );
    }
    Ok(out)
}

fn build_provider_args(node: &Value, deps: &[Value]) -> Result<Vec<String>, String> {
    let kind = node.get("kind").and_then(|v| v.as_str()).unwrap_or("gen");
    let mode = if kind == "motion" { "video" } else { "image" };

    let prompt = first_prompt(node, deps);
    if prompt.is_empty() {
        return Err("PixVerse node needs a connected Prompt node.".to_string());
    }
    let image = first_image_input(deps);

    let mut args = vec![
        "create".to_string(),
        mode.to_string(),
        "--prompt".to_string(),
        prompt,
    ];
    if !image.is_empty() {
        args.extend_from_slice(&["--image".to_string(), image]);
    }

    let model = node
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(if mode == "video" { "v6" } else { "qwen-image" });
    args.extend_from_slice(&["--model".to_string(), model.to_string()]);

    let quality = node
        .get("quality")
        .and_then(|v| v.as_str())
        .unwrap_or(if mode == "video" { "720p" } else { "1080p" });
    args.extend_from_slice(&["--quality".to_string(), quality.to_string()]);

    let ratio = node
        .get("aspectRatio")
        .and_then(|v| v.as_str())
        .unwrap_or("16:9");
    args.extend_from_slice(&["--aspect-ratio".to_string(), ratio.to_string()]);

    if let Some(count) = node.get("count").and_then(|v| v.as_u64()) {
        args.extend_from_slice(&["--count".to_string(), count.to_string()]);
    }

    if mode == "video" {
        let duration = node.get("duration").and_then(|v| v.as_u64()).unwrap_or(5);
        args.extend_from_slice(&["--duration".to_string(), duration.to_string()]);
        if node.get("audio").and_then(|v| v.as_bool()).unwrap_or(false) {
            args.push("--audio".to_string());
        }
        if node.get("offPeak").and_then(|v| v.as_bool()).unwrap_or(false) {
            args.push("--off-peak".to_string());
        }
        let timeout = node.get("timeout").and_then(|v| v.as_u64()).unwrap_or(600);
        args.extend_from_slice(&["--timeout".to_string(), timeout.to_string()]);
    } else {
        let timeout = node.get("timeout").and_then(|v| v.as_u64()).unwrap_or(300);
        args.extend_from_slice(&["--timeout".to_string(), timeout.to_string()]);
    }
    args.push("--json".to_string());
    Ok(args)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

pub async fn run_pixverse(
    app: AppHandle,
    window: Window,
    node: Value,
    deps: Vec<Value>,
    config: Value,
    run_id: String,
) -> Result<Value, String> {
    let bin_raw = config
        .get("binPaths")
        .and_then(|b| b.get("pixverse"))
        .and_then(|v| v.as_str())
        .unwrap_or("pixverse");
    let bin = find_bin(&expand_tilde(bin_raw));

    let args = resolve_pixverse_args(&node, &deps)?;
    // Subcommands that produce video output
    let video_subcmds = ["video", "transition", "reference", "motion-control", "extend", "upscale", "speech"];
    let mode = if args.iter().any(|a| video_subcmds.contains(&a.as_str())) { "video" } else { "image" };

    let _ = window.emit(&format!("progress:{run_id}"), 0.05f64);

    let output = Command::new(&bin)
        .env("PATH", npm_augmented_path())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("Failed to start pixverse: {e}. Is it installed? Run: npm install -g pixverse")
        })?
        .wait_with_output()
        .await
        .map_err(|e| e.to_string())?;

    let _ = window.emit(&format!("progress:{run_id}"), 0.9f64);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed = parse_json_output(&stdout);
    let raw_thumbs = collect_thumbs(parsed.as_ref(), mode);

    let pv_dir = runs_dir(&app)?.join("pixverse");
    std::fs::create_dir_all(&pv_dir).ok();
    let thumbs = resolve_asset_thumbs(&bin, raw_thumbs, mode, &pv_dir).await;

    let _ = window.emit(&format!("progress:{run_id}"), 1.0f64);

    Ok(serde_json::json!({
        "ok": true,
        "pixverse": parsed,
        "thumbs": thumbs,
    }))
}
