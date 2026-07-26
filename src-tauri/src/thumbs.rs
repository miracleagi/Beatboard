// Thumb extraction: parse JSON output from PixVerse and collect media URLs/paths/IDs.

use crate::runtime::RuntimeCommand;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;

// ─── Data type ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thumb {
    pub seed: String,
    pub label: String,
    #[serde(rename = "type")]
    pub thumb_type: String,
    pub chosen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn is_remote_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:")
}

fn has_video_ext(s: &str) -> bool {
    let s = s.split('?').next().unwrap_or(s).to_lowercase();
    s.ends_with(".mp4") || s.ends_with(".mov") || s.ends_with(".webm") || s.ends_with(".m4v")
}

fn has_image_ext(s: &str) -> bool {
    let s = s.split('?').next().unwrap_or(s).to_lowercase();
    s.ends_with(".png")
        || s.ends_with(".jpg")
        || s.ends_with(".jpeg")
        || s.ends_with(".webp")
        || s.ends_with(".gif")
        || s.ends_with(".avif")
}

fn has_audio_ext(s: &str) -> bool {
    let s = s.split('?').next().unwrap_or(s).to_lowercase();
    s.ends_with(".mp3")
        || s.ends_with(".wav")
        || s.ends_with(".m4a")
        || s.ends_with(".aac")
        || s.ends_with(".ogg")
        || s.ends_with(".flac")
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

/// Try to parse `stdout` as JSON. Falls back to extracting the first `{…}` substring.
pub fn parse_json_output(stdout: &str) -> Option<Value> {
    let s = stdout.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str(s) {
        return Some(v);
    }
    if let (Some(start), Some(end)) = (s.find('{'), s.rfind('}')) {
        if let Ok(v) = serde_json::from_str(&s[start..=end]) {
            return Some(v);
        }
    }
    None
}

/// Infer a generated media kind from explicit response metadata, media URL
/// keys, or file extensions. PixVerse templates are polymorphic, so their
/// output cannot be classified from the create subcommand alone.
pub fn infer_media_kind(parsed: Option<&Value>) -> Option<&'static str> {
    fn from_string(value: &str) -> Option<&'static str> {
        let value = value.trim().to_lowercase();
        match value.as_str() {
            "audio" | "music" | "voice" => Some("audio"),
            "video" => Some("video"),
            "image" | "photo" => Some("image"),
            _ if has_audio_ext(&value) => Some("audio"),
            _ if has_video_ext(&value) => Some("video"),
            _ if has_image_ext(&value) => Some("image"),
            _ => None,
        }
    }

    fn update(best: &mut Option<(u8, &'static str)>, score: u8, kind: &'static str) {
        if best.is_none_or(|(current, _)| score > current) {
            *best = Some((score, kind));
        }
    }

    fn walk(value: &Value, best: &mut Option<(u8, &'static str)>) {
        match value {
            Value::String(value) => {
                if let Some(kind) = from_string(value) {
                    update(best, 1, kind);
                }
            }
            Value::Array(values) => values.iter().for_each(|value| walk(value, best)),
            Value::Object(map) => {
                for key in ["media_type", "mediaType", "asset_type", "assetType", "type"] {
                    if let Some(Value::String(value)) = map.get(key) {
                        if let Some(kind) = from_string(value) {
                            update(best, 4, kind);
                        }
                    }
                }
                for (kind, keys) in [
                    ("audio", &["audio_url", "audioUrl"][..]),
                    ("video", &["video_url", "videoUrl"][..]),
                    ("image", &["image_url", "imageUrl"][..]),
                ] {
                    if keys.iter().any(|key| {
                        map.get(*key)
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.trim().is_empty())
                    }) {
                        update(best, 3, kind);
                    }
                }
                map.values().for_each(|value| walk(value, best));
            }
            _ => {}
        }
    }

    let mut best = None;
    if let Some(parsed) = parsed {
        walk(parsed, &mut best);
    }
    best.map(|(_, kind)| kind)
}

// ─── Thumb collection ────────────────────────────────────────────────────────

/// Walk a parsed JSON value and collect media candidates.
/// Prefers url/path candidates; falls back to id-only if none found.
/// When a URL thumb is found, the first available ID from the same parse
/// is also stored so callers can use the cloud asset ID in downstream nodes.
pub fn collect_thumbs(parsed: Option<&Value>, mode: &str) -> Vec<Thumb> {
    let mut candidates: Vec<(String, String)> = Vec::new(); // (kind, value)
    let mut seen = HashSet::new();
    if let Some(v) = parsed {
        collect_candidates(v, mode, &mut candidates, &mut seen);
    }
    let preferred: Vec<_> = candidates
        .iter()
        .filter(|(k, _)| k == "url" || k == "path")
        .collect();
    let chosen = if !preferred.is_empty() {
        preferred
    } else {
        candidates.iter().filter(|(k, _)| k == "id").collect()
    };
    // Collect all IDs found so we can attach the first one to every URL thumb.
    // This ensures that after `create video`, the thumb carries both the CDN
    // URL *and* the numeric cloud asset ID needed by downstream operations.
    let first_id: Option<String> = candidates
        .iter()
        .find(|(k, _)| k == "id")
        .map(|(_, v)| v.clone());

    chosen
        .into_iter()
        .enumerate()
        .map(|(i, (kind, value))| Thumb {
            seed: value.clone(),
            label: mode.to_string(),
            thumb_type: mode.to_string(),
            chosen: i == 0,
            url: if kind == "url" {
                Some(value.clone())
            } else {
                None
            },
            path: if kind == "path" && !is_remote_url(value) {
                Some(value.clone())
            } else {
                None
            },
            // For id-kind thumbs, use their own value.
            // For url/path thumbs, attach the first cloud ID if one was found.
            id: if kind == "id" {
                Some(value.clone())
            } else {
                first_id.clone()
            },
        })
        .collect()
}

fn collect_candidates(
    v: &Value,
    mode: &str,
    out: &mut Vec<(String, String)>,
    seen: &mut HashSet<String>,
) {
    let is_video = mode == "video";
    let is_audio = mode == "audio";
    let url_keys: &[&str] = if is_audio {
        &[
            "audio_url",
            "audioUrl",
            "media_url",
            "mediaUrl",
            "download_url",
            "downloadUrl",
            "url",
            "src",
        ]
    } else if is_video {
        &[
            "video_url",
            "videoUrl",
            "media_url",
            "mediaUrl",
            "download_url",
            "downloadUrl",
            "url",
            "src",
        ]
    } else {
        &[
            "image_url",
            "imageUrl",
            "media_url",
            "mediaUrl",
            "download_url",
            "downloadUrl",
            "url",
            "src",
        ]
    };
    let path_keys: &[&str] = &[
        "path",
        "output",
        "file",
        "file_path",
        "filePath",
        "local_path",
        "localPath",
    ];
    let id_keys: &[&str] = if is_audio {
        &[
            "audio_id", "audioId", "asset_id", "assetId", "id", "task_id", "taskId",
        ]
    } else if is_video {
        &[
            "video_id", "videoId", "asset_id", "assetId", "id", "task_id", "taskId",
        ]
    } else {
        &[
            "image_id", "imageId", "asset_id", "assetId", "id", "task_id", "taskId",
        ]
    };
    let recurse: &[&str] = &[
        "videos", "images", "audios", "assets", "items", "outputs", "records", "thumbs", "result",
        "data", "pixverse",
    ];

    match v {
        Value::String(s) => {
            let s = s.trim();
            if !s.is_empty()
                && (is_remote_url(s)
                    || (is_video && has_video_ext(s))
                    || (is_audio && has_audio_ext(s))
                    || (!is_video && !is_audio && has_image_ext(s)))
            {
                let key = format!("url:{s}");
                if seen.insert(key) {
                    out.push(("url".to_string(), s.to_string()));
                }
            }
        }
        Value::Object(map) => {
            for &k in url_keys {
                if let Some(Value::String(s)) = map.get(k) {
                    let s = s.trim().to_string();
                    if !s.is_empty() && seen.insert(format!("url:{s}")) {
                        out.push(("url".to_string(), s));
                    }
                }
            }
            for &k in path_keys {
                if let Some(Value::String(s)) = map.get(k) {
                    let s = s.trim().to_string();
                    if !s.is_empty() && seen.insert(format!("path:{s}")) {
                        out.push(("path".to_string(), s));
                    }
                }
            }
            for &k in id_keys {
                match map.get(k) {
                    Some(Value::String(s)) => {
                        let s = s.trim().to_string();
                        if !s.is_empty() && seen.insert(format!("id:{s}")) {
                            out.push(("id".to_string(), s));
                        }
                    }
                    Some(Value::Number(n)) => {
                        let s = n.to_string();
                        if seen.insert(format!("id:{s}")) {
                            out.push(("id".to_string(), s));
                        }
                    }
                    _ => {}
                }
            }
            for &k in recurse {
                if let Some(child) = map.get(k) {
                    collect_candidates(child, mode, out, seen);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_candidates(item, mode, out, seen);
            }
        }
        _ => {}
    }
}

// ─── Asset download ───────────────────────────────────────────────────────────

/// Download a remote https:// URL to a local file under `dir`.
/// Returns the local file path on success.  Uses the URL's last path segment
/// as the filename so identical URLs are cached (not re-downloaded).
async fn download_remote_url(url: &str, dir: &Path, mode: &str) -> Result<String, String> {
    // Derive a safe filename from the URL's last path component
    let url_no_query = url.split('?').next().unwrap_or(url);
    let raw_name = url_no_query.rsplit('/').next().unwrap_or("media");
    let safe_name: String = raw_name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    let default_ext = match mode {
        "video" => ".mp4",
        "audio" => ".mp3",
        _ => ".jpg",
    };
    let filename = if safe_name.contains('.') {
        format!("{mode}-{safe_name}")
    } else {
        format!("{mode}-{safe_name}{default_ext}")
    };
    let out_path = dir.join(&filename);

    // Cache: if file already exists and is non-empty, reuse it
    if out_path.exists() && out_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return out_path
            .to_str()
            .map(String::from)
            .ok_or_else(|| "bad path".to_string());
    }

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} downloading {url}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
    out_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| "bad path".to_string())
}

/// For each thumb:
///   ① If it has a remote https:// URL but no local path → download to dir/ and set `path`.
///   ② If it has only an `id` (no url/path) → call `pixverse asset download` via CLI.
///   ③ Otherwise pass through unchanged.
pub async fn resolve_asset_thumbs(
    runtime: &RuntimeCommand,
    thumbs: Vec<Thumb>,
    mode: &str,
    dir: &Path,
) -> Vec<Thumb> {
    let mut out = Vec::new();
    for thumb in thumbs {
        // ① Remote URL with no local path → download for reliable local preview
        if thumb.path.is_none() {
            if let Some(url) = &thumb.url {
                if url.starts_with("http://") || url.starts_with("https://") {
                    match download_remote_url(url, dir, mode).await {
                        Ok(local_path) => {
                            out.push(Thumb {
                                path: Some(local_path),
                                ..thumb
                            });
                            continue;
                        }
                        Err(_) => {} // fall through: push original thumb below
                    }
                }
            }
        }

        // ② ID-only → download via CLI
        if thumb.url.is_none() && thumb.path.is_none() {
            if let Some(id) = thumb.id.as_ref().map(String::clone) {
                let result = runtime
                    .command([
                        "asset",
                        "download",
                        &id,
                        "--type",
                        mode,
                        "--dest",
                        dir.to_str().unwrap_or("."),
                        "--json",
                    ])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn();
                if let Ok(child) = result {
                    if let Ok(output) = child.wait_with_output().await {
                        if output.status.success() {
                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let downloaded =
                                collect_thumbs(parse_json_output(&stdout).as_ref(), mode);
                            if !downloaded.is_empty() {
                                out.extend(downloaded);
                                continue;
                            }
                        }
                    }
                }
            }
        }

        out.push(thumb);
    }
    // Reset chosen flags so index 0 is always chosen
    for (i, t) in out.iter_mut().enumerate() {
        t.chosen = i == 0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{collect_thumbs, infer_media_kind};
    use serde_json::json;

    #[test]
    fn collects_audio_url_and_cloud_id() {
        let parsed = json!({
            "result": {
                "audio_url": "https://cdn.example.test/voice.mp3",
                "audio_id": "audio-123"
            }
        });
        let thumbs = collect_thumbs(Some(&parsed), "audio");
        assert_eq!(thumbs.len(), 1);
        assert_eq!(thumbs[0].thumb_type, "audio");
        assert_eq!(
            thumbs[0].url.as_deref(),
            Some("https://cdn.example.test/voice.mp3")
        );
        assert_eq!(thumbs[0].id.as_deref(), Some("audio-123"));
    }

    #[test]
    fn infers_template_result_kind_over_input_extension() {
        let parsed = json!({
            "input": { "url": "https://cdn.example.test/reference.jpg" },
            "result": { "video_url": "https://cdn.example.test/effect.mp4" }
        });
        assert_eq!(infer_media_kind(Some(&parsed)), Some("video"));

        let parsed = json!({
            "result": { "asset_type": "image", "url": "https://cdn.example.test/effect" }
        });
        assert_eq!(infer_media_kind(Some(&parsed)), Some("image"));
    }
}
