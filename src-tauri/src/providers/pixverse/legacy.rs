// Legacy PixVerse argv resolution for `kind: "cli"` nodes: substitutes
// `{prompt}`, `{images}`, `{video_id}`, … placeholders in a raw argv template.
// Task nodes that could not be migrated to typed params keep their template in
// `provider_params._raw_args` and are resolved here too.

use crate::providers::inputs::{first_prompt, thumb_matches_kind, thumb_path};
use serde_json::Value;

// ─── Media extraction ────────────────────────────────────────────────────────

/// Return the first image URL or path from any upstream dep's thumbs.
pub fn first_image_input(deps: &[Value]) -> String {
    all_inputs_of_type(deps, "image")
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// Return all media paths from deps whose thumbs have the given type,
/// sorted by destination port index. Used for {images}, {videos}, and {audios}.
fn all_inputs_of_type(deps: &[Value], kind: &str) -> Vec<String> {
    let mut entries: Vec<(u64, String)> = Vec::new();
    for dep in deps {
        let port_idx = dep
            .get("edge")
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
                    if thumb_matches_kind(thumb, kind) {
                        let p = thumb_path(thumb);
                        if !p.is_empty() {
                            entries.push((port_idx, p));
                            found = true;
                            break;
                        }
                    }
                }
                if found {
                    break;
                }
            }
        }
    }
    entries.sort_by_key(|(p, _)| *p);
    entries.into_iter().map(|(_, path)| path).collect()
}

fn first_video_input(deps: &[Value]) -> String {
    all_inputs_of_type(deps, "video")
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// Return the PixVerse cloud video/asset ID from the first upstream dep result.
/// This is the `id` field stored on a Thumb — set from video_id / asset_id / id
/// in the API JSON response. Used for `--video` in extend/upscale/modify.
/// Falls back to the local file path so the flag is never completely empty.
fn first_video_id(deps: &[Value]) -> String {
    let mut ordered: Vec<&Value> = deps.iter().collect();
    ordered.sort_by_key(|dep| {
        dep.get("edge")
            .and_then(|e| e.get("to"))
            .and_then(|t| t.get("port"))
            .and_then(|p| p.as_u64())
            .unwrap_or(999)
    });
    for dep in ordered {
        // Prefer result thumbs over node thumbs (result is from the actual run)
        for thumbs_ptr in [
            dep.get("result").and_then(|r| r.get("thumbs")),
            dep.get("from").and_then(|f| f.get("thumbs")),
        ] {
            if let Some(thumbs) = thumbs_ptr.and_then(|t| t.as_array()) {
                for thumb in thumbs {
                    if !thumb_matches_kind(thumb, "video") {
                        continue;
                    }
                    // Prefer the cloud ID field
                    if let Some(id) = thumb
                        .get("id")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return id.to_string();
                    }
                }
                // No cloud ID found in this dep; fall back to local path
                for thumb in thumbs {
                    if !thumb_matches_kind(thumb, "video") {
                        continue;
                    }
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
        let port_idx = dep
            .get("edge")
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
                if entries
                    .last()
                    .map(|(pi, _)| *pi == port_idx)
                    .unwrap_or(false)
                {
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
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let prompt = first_prompt(node, deps);
    let image = first_image_input(deps);
    let video_id = first_video_id(deps);
    let sorted = sorted_media_inputs(deps);
    let from_input = sorted.first().cloned().unwrap_or_default();
    let to_input = sorted.get(1).cloned().unwrap_or_default();
    let video_input = first_video_input(deps);
    // Multi-value tokens: expand to one arg per connected dep of that type
    let all_images = all_inputs_of_type(deps, "image");
    let all_videos = all_inputs_of_type(deps, "video");
    let all_audios = all_inputs_of_type(deps, "audio");

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
                if out
                    .last()
                    .map(|s: &String| s.starts_with("--"))
                    .unwrap_or(false)
                {
                    out.pop();
                }
            } else {
                out.extend(all_images.clone());
            }
            continue;
        }
        if arg == "{videos}" {
            if all_videos.is_empty() {
                if out
                    .last()
                    .map(|s: &String| s.starts_with("--"))
                    .unwrap_or(false)
                {
                    out.pop();
                }
            } else {
                out.extend(all_videos.clone());
            }
            continue;
        }
        if arg == "{audios}" {
            if all_audios.is_empty() {
                if out
                    .last()
                    .map(|s: &String| s.starts_with("--"))
                    .unwrap_or(false)
                {
                    out.pop();
                }
            } else {
                out.extend(all_audios.clone());
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
            if out
                .last()
                .map(|s: &String| s.starts_with("--"))
                .unwrap_or(false)
            {
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
        .unwrap_or(if mode == "video" {
            "v6"
        } else {
            "gpt-image-2.0"
        });
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
        if node
            .get("offPeak")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
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

#[cfg(test)]
mod tests {
    use super::resolve_pixverse_args;
    use serde_json::{json, Value};

    fn media_dep(port: u64, kind: &str, path: &str, id: &str) -> Value {
        json!({
            "edge": { "to": { "port": port } },
            "from": { "kind": "asset" },
            "result": { "thumbs": [{ "type": kind, "path": path, "id": id }] }
        })
    }

    fn prompt_dep(port: u64, prompt: &str) -> Value {
        json!({
            "edge": { "to": { "port": port } },
            "from": { "kind": "prompt", "prompt": prompt }
        })
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let index = args.iter().position(|arg| arg == flag).unwrap();
        &args[index + 1]
    }

    #[test]
    fn resolves_reference_images_videos_and_audio() {
        let node = json!({
            "kind": "cli",
            "cli": { "args": [
                "create", "reference",
                "--images", "{images}",
                "--videos", "{videos}",
                "--audios", "{audios}",
                "--prompt", "{prompt}",
                "--json"
            ] }
        });
        let deps = vec![
            media_dep(1, "image", "/tmp/ref.png", "img-1"),
            media_dep(2, "video", "/tmp/ref.mp4", "vid-1"),
            media_dep(3, "audio", "/tmp/ref.mp3", "aud-1"),
            prompt_dep(4, "@image1 follows @audio1"),
        ];

        let args = resolve_pixverse_args(&node, &deps).unwrap();
        assert_eq!(value_after(&args, "--images"), "/tmp/ref.png");
        assert_eq!(value_after(&args, "--videos"), "/tmp/ref.mp4");
        assert_eq!(value_after(&args, "--audios"), "/tmp/ref.mp3");
        assert_eq!(value_after(&args, "--prompt"), "@image1 follows @audio1");
    }

    #[test]
    fn modify_uses_video_cloud_id_not_reference_image_id() {
        let node = json!({
            "kind": "cli",
            "cli": { "args": [
                "create", "modify", "--video", "{video_id}",
                "--images", "{images}", "--prompt", "{prompt}", "--json"
            ] }
        });
        let deps = vec![
            media_dep(1, "image", "/tmp/ref.png", "image-cloud-id"),
            media_dep(0, "video", "/tmp/source.mp4", "video-cloud-id"),
            prompt_dep(2, "change the background"),
        ];

        let args = resolve_pixverse_args(&node, &deps).unwrap();
        assert_eq!(value_after(&args, "--video"), "video-cloud-id");
        assert_eq!(value_after(&args, "--images"), "/tmp/ref.png");
    }

    #[test]
    fn voice_resolves_text_from_prompt_node() {
        let node = json!({
            "kind": "cli",
            "cli": { "args": ["create", "voice", "--text", "{prompt}", "--json"] }
        });
        let args = resolve_pixverse_args(&node, &[prompt_dep(0, "Hello from Beatboard")]).unwrap();
        assert_eq!(value_after(&args, "--text"), "Hello from Beatboard");
    }
}
