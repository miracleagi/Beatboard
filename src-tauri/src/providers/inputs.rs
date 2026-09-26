// Provider-neutral input resolution: turns a task node plus its upstream deps
// into a `TaskRequest` whose media inputs are grouped by named slot.
//
// A dep is routed to the slot of the input port its edge lands on
// (`node.ports[edge.to.port].slot`); within a slot, refs are ordered by port
// index, then by edge order. Each dep contributes one `MediaRef` built from the
// first thumb matching the slot's media kind — run results are preferred over
// thumbs cached on the source node, exactly as the legacy PixVerse resolver did.

use super::{MediaRef, ProviderError, TaskRequest};
use crate::utils::percent_decode;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

// ─── Prompt ──────────────────────────────────────────────────────────────────

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
        if p.is_empty() {
            None
        } else {
            Some(p.to_string())
        }
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

// ─── Thumb helpers ───────────────────────────────────────────────────────────

fn non_empty_str<'a>(thumb: &'a Value, key: &str) -> Option<&'a str> {
    thumb
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// Extract a single media path (or remote URL) from a thumb object.
pub fn thumb_path(thumb: &Value) -> String {
    for key in ["path", "local_path", "localPath"] {
        if let Some(p) = non_empty_str(thumb, key) {
            return p.to_string();
        }
    }
    if let Some(u) = non_empty_str(thumb, "url") {
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

pub fn thumb_matches_kind(thumb: &Value, kind: &str) -> bool {
    if thumb.get("type").and_then(|v| v.as_str()) == Some(kind) {
        return true;
    }
    let path = thumb_path(thumb).to_lowercase();
    let path = path.split('?').next().unwrap_or(&path);
    let exts: &[&str] = match kind {
        "image" => &[".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"],
        "video" => &[".mp4", ".mov", ".webm", ".m4v"],
        "audio" => &[".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"],
        _ => &[],
    };
    exts.iter().any(|ext| path.ends_with(ext))
}

/// Destination port index of a dep's edge (999 when missing, as before).
pub fn dep_port(dep: &Value) -> u64 {
    dep.get("edge")
        .and_then(|e| e.get("to"))
        .and_then(|t| t.get("port"))
        .and_then(|p| p.as_u64())
        .unwrap_or(999)
}

/// Thumb lists of a dep in lookup order: run result first, then node cache.
pub fn dep_thumb_lists(dep: &Value) -> impl Iterator<Item = &Vec<Value>> {
    [
        dep.get("result").and_then(|r| r.get("thumbs")),
        dep.get("from").and_then(|f| f.get("thumbs")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|t| t.as_array())
}

/// Cloud ids carried by a thumb, keyed by provider. Thumbs written before
/// provider namespacing carry a bare `id`, which was always a PixVerse id.
fn thumb_cloud_ids(thumb: &Value) -> BTreeMap<String, String> {
    let mut ids = BTreeMap::new();
    if let Some(refs) = thumb.get("refs").and_then(|r| r.as_object()) {
        for (provider, id) in refs {
            if let Some(id) = id.as_str().filter(|s| !s.is_empty()) {
                ids.insert(provider.clone(), id.to_string());
            }
        }
    }
    if let Some(id) = non_empty_str(thumb, "id") {
        ids.entry("pixverse".to_string())
            .or_insert_with(|| id.to_string());
    }
    ids
}

/// Build the media ref a dep contributes for a slot of the given kind.
///
/// * `path`: first thumb of that kind with a path, from the first thumb list
///   that has one.
/// * `cloud_ids`: from the first thumb list holding a thumb of that kind with
///   a path or an id — the first such thumb carrying ids wins.
pub fn dep_media_ref(dep: &Value, kind: &str) -> Option<MediaRef> {
    let path = dep_thumb_lists(dep)
        .find_map(|thumbs| {
            thumbs
                .iter()
                .filter(|t| thumb_matches_kind(t, kind))
                .map(thumb_path)
                .find(|p| !p.is_empty())
        })
        .unwrap_or_default();

    let cloud_ids = dep_thumb_lists(dep)
        .find_map(|thumbs| {
            let matching: Vec<&Value> = thumbs
                .iter()
                .filter(|t| thumb_matches_kind(t, kind))
                .collect();
            if let Some(ids) = matching
                .iter()
                .map(|t| thumb_cloud_ids(t))
                .find(|ids| !ids.is_empty())
            {
                return Some(ids);
            }
            matching
                .iter()
                .any(|t| !thumb_path(t).is_empty())
                .then(BTreeMap::new)
        })
        .unwrap_or_default();

    if path.is_empty() && cloud_ids.is_empty() {
        return None;
    }
    Some(MediaRef {
        kind: kind.to_string(),
        path,
        cloud_ids,
    })
}

// ─── Task request ────────────────────────────────────────────────────────────

fn object_field(node: &Value, key: &str) -> Map<String, Value> {
    node.get(key)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

/// Resolve a `kind: "task"` node and its deps into a provider-neutral request.
pub fn task_request(node: &Value, deps: &[Value]) -> Result<TaskRequest, ProviderError> {
    let capability = node
        .get("capability")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ProviderError::InvalidParams("task node has no capability".into()))?
        .to_string();

    let ports = node
        .get("ports")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let slot_of = |port: u64| -> Option<(String, String)> {
        let port = ports.get(usize::try_from(port).ok()?)?;
        if port.get("side").and_then(|s| s.as_str()) != Some("left") {
            return None;
        }
        let slot = port.get("slot")?.as_str()?.to_string();
        let kind = port.get("kind")?.as_str()?.to_string();
        Some((slot, kind))
    };

    let mut slot_ports: BTreeMap<String, usize> = BTreeMap::new();
    for port in &ports {
        if port.get("side").and_then(|s| s.as_str()) != Some("left") {
            continue;
        }
        if let Some(slot) = port.get("slot").and_then(|s| s.as_str()) {
            *slot_ports.entry(slot.to_string()).or_default() += 1;
        }
    }

    let mut ordered: Vec<&Value> = deps.iter().collect();
    ordered.sort_by_key(|dep| dep_port(dep)); // stable: edge order within a port
    let mut inputs: BTreeMap<String, Vec<MediaRef>> = BTreeMap::new();
    for dep in ordered {
        let Some((slot, kind)) = slot_of(dep_port(dep)) else {
            continue;
        };
        if kind == "text" {
            continue; // text inputs feed the prompt, resolved below
        }
        if let Some(media) = dep_media_ref(dep, &kind) {
            inputs.entry(slot).or_default().push(media);
        }
    }

    Ok(TaskRequest {
        capability,
        model: node
            .get("model")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from),
        prompt: first_prompt(node, deps),
        inputs,
        slot_ports,
        params: object_field(node, "params"),
        provider_params: object_field(node, "provider_params"),
    })
}

#[cfg(test)]
mod tests {
    use super::task_request;
    use serde_json::json;

    #[test]
    fn routes_deps_to_slots_by_port_and_prefers_result_thumbs() {
        let node = json!({
            "id": "n1", "kind": "task", "capability": "video.modify", "model": "v5.5",
            "ports": [
                { "kind": "video", "side": "left", "slot": "video" },
                { "kind": "image", "side": "left", "slot": "images" },
                { "kind": "image", "side": "left", "slot": "images" },
                { "kind": "text", "side": "left", "slot": "prompt" },
                { "kind": "video", "side": "right" }
            ],
            "params": { "resolution": "720p" }
        });
        let deps = vec![
            json!({ "edge": { "to": { "port": 2 } }, "from": { "kind": "asset" },
                    "result": { "thumbs": [{ "type": "image", "path": "/b.png" }] } }),
            json!({ "edge": { "to": { "port": 1 } }, "from": { "kind": "asset",
                    "thumbs": [{ "type": "image", "path": "/stale.png" }] },
                    "result": { "thumbs": [{ "type": "image", "path": "/a.png" }] } }),
            json!({ "edge": { "to": { "port": 0 } }, "from": { "kind": "cli" },
                    "result": { "thumbs": [{ "type": "video", "path": "/v.mp4", "id": "pv-1" }] } }),
            json!({ "edge": { "to": { "port": 3 } }, "from": { "kind": "prompt", "prompt": "make it rain" } }),
        ];
        let req = task_request(&node, &deps).unwrap();
        assert_eq!(req.capability, "video.modify");
        assert_eq!(req.model.as_deref(), Some("v5.5"));
        assert_eq!(req.prompt, "make it rain");
        let images: Vec<&str> = req.inputs["images"]
            .iter()
            .map(|m| m.path.as_str())
            .collect();
        assert_eq!(images, ["/a.png", "/b.png"]);
        assert_eq!(req.inputs["video"][0].cloud_ids["pixverse"], "pv-1");
        assert_eq!(req.slot_ports["images"], 2);
        assert_eq!(req.params["resolution"], "720p");
    }

    #[test]
    fn namespaced_refs_win_over_bare_id() {
        let node = json!({ "kind": "task", "capability": "video.upscale",
            "ports": [{ "kind": "video", "side": "left", "slot": "video" }] });
        let deps = vec![
            json!({ "edge": { "to": { "port": 0 } }, "result": { "thumbs": [
            { "type": "video", "path": "/v.mp4", "id": "legacy", "refs": { "pixverse": "pv-2", "fal": "req-9" } }
        ] } }),
        ];
        let req = task_request(&node, &deps).unwrap();
        let ids = &req.inputs["video"][0].cloud_ids;
        assert_eq!(ids["pixverse"], "pv-2");
        assert_eq!(ids["fal"], "req-9");
    }

    #[test]
    fn missing_capability_is_invalid() {
        assert!(task_request(&json!({ "kind": "task" }), &[]).is_err());
    }
}
