// ffmpeg execution: collect video inputs, localize remote URLs, build concat filter, run.

use crate::runtime::resolve_ffmpeg;
use crate::storage::runs_dir;
use crate::utils::{expand_tilde, percent_decode};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Window};

// ─── Input collection ────────────────────────────────────────────────────────

/// Gather all video URLs/paths from upstream dep thumbs, deduped in order.
/// For each thumb we take at most ONE value: local `path` is preferred over
/// remote `url` so we don't emit two entries for the same video.
fn collect_video_inputs(deps: &[Value]) -> Vec<String> {
    let is_video_ext = |s: &str| {
        let low = s.split('?').next().unwrap_or(s).to_lowercase();
        low.ends_with(".mp4")
            || low.ends_with(".mov")
            || low.ends_with(".webm")
            || low.ends_with(".m4v")
    };

    let mut values: Vec<String> = Vec::new();
    for dep in deps {
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(arr) = thumbs_ptr.and_then(|t| t.as_array()) {
                for thumb in arr {
                    let is_vid = thumb.get("type").and_then(|t| t.as_str()) == Some("video");
                    // Pick ONE value per thumb: prefer local path, then url, then aliases.
                    // This avoids double-counting a thumb that has both path and url set.
                    let value = ["path", "url", "video_url", "videoUrl"]
                        .iter()
                        .find_map(|&key| {
                            thumb
                                .get(key)
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty() && (is_vid || is_video_ext(s)))
                        });
                    if let Some(s) = value {
                        values.push(s.to_string());
                    }
                }
            }
        }
    }

    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect()
}

// ─── Input localization ───────────────────────────────────────────────────────

fn project_ffmpeg_dir(app: &AppHandle, config: &Value) -> Result<PathBuf, String> {
    let output_dir = config
        .get("project")
        .and_then(|p| p.get("outputDir"))
        .and_then(|v| v.as_str())
        .or_else(|| config.get("projectOutputDir").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();

    if output_dir.is_empty() {
        return Ok(runs_dir(app)?.join("ffmpeg"));
    }

    let expanded = expand_tilde(output_dir);
    let root = PathBuf::from(expanded);
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Cannot resolve output directory: {e}"))?
            .join(root)
    };
    Ok(root.join("ffmpeg"))
}

/// Ensure `url` is a local file path, downloading it if it's an https:// URL.
/// Handles `asset://localhost/…` by stripping the scheme and percent-decoding.
async fn localize_input(
    url: &str,
    dir: &Path,
    prefix: &str,
    index: usize,
) -> Result<String, String> {
    // asset:// or atlasmedia:// → strip scheme and percent-decode to get local path
    if url.starts_with("asset://localhost") {
        let path = url.trim_start_matches("asset://localhost");
        return Ok(percent_decode(path));
    }
    if url.starts_with("atlasmedia://localhost") {
        let path = url.trim_start_matches("atlasmedia://localhost");
        return Ok(percent_decode(path));
    }
    // Already a local path
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(expand_tilde(url));
    }

    // Download remote URL
    let ext = {
        let p = url.split('?').next().unwrap_or("").to_lowercase();
        let e = p
            .rsplit('.')
            .next()
            .map(|s| format!(".{s}"))
            .unwrap_or_default();
        if [".mp4", ".mov", ".webm", ".m4v"].contains(&e.as_str()) {
            e
        } else {
            ".mp4".to_string()
        }
    };
    let out_path = dir.join(format!(
        "{prefix}-{}.{}",
        index + 1,
        ext.trim_start_matches('.')
    ));

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} downloading input", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&out_path, bytes).map_err(|e| e.to_string())?;
    out_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| "Invalid path".to_string())
}

// ─── Filter builder ───────────────────────────────────────────────────────────

/// Return `(width, height)` for the node's aspect ratio setting.
fn canvas_size(node: &Value) -> (u32, u32) {
    let ratio = node
        .get("aspectRatio")
        .or_else(|| node.get("size"))
        .and_then(|v| v.as_str())
        .unwrap_or("16:9");
    match ratio {
        "9:16" => (720, 1280),
        "1:1" => (1080, 1080),
        _ => (1280, 720),
    }
}

/// Build the concat command. VideoToolbox is preferred, with FFmpeg's LGPL
/// MPEG-4 encoder available as a software fallback when macOS cannot create a
/// hardware compression session (remote sessions and busy encoders can do so).
fn build_concat_args(
    node: &Value,
    inputs: &[String],
    out: &Path,
    videotoolbox: bool,
) -> Vec<String> {
    let (w, h) = canvas_size(node);
    let fps = 24u32;

    let mut filters: Vec<String> = inputs
        .iter()
        .enumerate()
        .map(|(i, _)| {
            format!(
                "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}]"
            )
        })
        .collect();

    let inputs_ref: String = (0..inputs.len()).map(|i| format!("[v{i}]")).collect();
    filters.push(format!("{inputs_ref}concat=n={}:v=1:a=0[v]", inputs.len()));

    let mut args = vec!["-y".to_string()];
    for input in inputs {
        args.extend_from_slice(&["-i".to_string(), input.clone()]);
    }
    args.extend_from_slice(&[
        "-filter_complex".to_string(),
        filters.join(";"),
        "-map".to_string(),
        "[v]".to_string(),
        "-an".to_string(),
    ]);
    if videotoolbox {
        args.extend_from_slice(&[
            "-c:v".to_string(),
            "h264_videotoolbox".to_string(),
            "-allow_sw".to_string(),
            "1".to_string(),
            "-q:v".to_string(),
            "65".to_string(),
        ]);
    } else {
        args.extend_from_slice(&[
            "-c:v".to_string(),
            "mpeg4".to_string(),
            "-q:v".to_string(),
            "3".to_string(),
        ]);
    }
    args.extend_from_slice(&[
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_str().unwrap_or("out.mp4").to_string(),
    ]);
    args
}

// ─── Runner ──────────────────────────────────────────────────────────────────

pub async fn run_ffmpeg(
    app: AppHandle,
    window: Window,
    node: Value,
    deps: Vec<Value>,
    config: Value,
    run_id: String,
) -> Result<Value, String> {
    let runtime = resolve_ffmpeg(&app, &config);

    let raw_inputs = collect_video_inputs(&deps);
    let node_id = node
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("ff")
        .to_string();

    if raw_inputs.len() < 2 {
        return Err("ffmpeg node needs at least two rendered video inputs. \
             Run upstream video nodes first."
            .to_string());
    }

    let _ = window.emit(&format!("progress:{run_id}"), 0.05f64);

    let ff_dir = project_ffmpeg_dir(&app, &config)?;
    let inputs_dir = ff_dir.join("inputs");
    std::fs::create_dir_all(&ff_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&inputs_dir).map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe_id: String = node_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let prefix = format!("{safe_id}-{ts}");

    // Download / localize each input
    let mut local_inputs = Vec::new();
    for (i, input) in raw_inputs.iter().enumerate() {
        let local = localize_input(input, &inputs_dir, &prefix, i).await?;
        let prog = 0.05 + 0.4 * (i + 1) as f64 / raw_inputs.len() as f64;
        let _ = window.emit(&format!("progress:{run_id}"), prog);
        local_inputs.push(local);
    }

    let out_path = ff_dir.join(format!("{prefix}.mp4"));
    let args = build_concat_args(&node, &local_inputs, &out_path, true);

    let _ = window.emit(&format!("progress:{run_id}"), 0.5f64);

    let mut output = runtime
        .command(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}. Reinstall Beatboard or choose a custom binary in Advanced settings."))?
        .wait_with_output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // VideoToolbox can be unavailable in remote/headless sessions or while
        // another process holds the encoder. Retry with FFmpeg's LGPL software
        // MPEG-4 encoder so composition remains functional.
        let fallback_args = build_concat_args(&node, &local_inputs, &out_path, false);
        output = runtime
            .command(&fallback_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start ffmpeg fallback: {e}"))?
            .wait_with_output()
            .await
            .map_err(|e| e.to_string())?;
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let last_line = stderr.lines().last().unwrap_or("unknown error");
        return Err(format!("ffmpeg failed: {last_line}"));
    }

    let out_str = out_path.to_str().unwrap_or("").to_string();
    let label = format!("compose · {} clips", raw_inputs.len());
    let seed = format!("ffmpeg-compose:{node_id}:{}", raw_inputs.join("|"));

    let _ = window.emit(&format!("progress:{run_id}"), 1.0f64);

    Ok(serde_json::json!({
        "ok": true,
        "thumbs": [{
            "seed": seed,
            "type": "video",
            "label": label,
            "chosen": true,
            "path": out_str,
            "sources": raw_inputs,
        }]
    }))
}
