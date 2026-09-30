// Capability registry and provider manifests.
//
// Both live as JSON under src/providers/ so the webview, this crate and the
// fixture generator read the same files: the frontend fetches them, Rust
// embeds them at compile time.

use super::{ProviderError, TaskRequest};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

const CAPABILITIES_JSON: &str = include_str!("../../../src/providers/capabilities.json");
const PIXVERSE_JSON: &str = include_str!("../../../src/providers/pixverse.json");
const FAL_JSON: &str = include_str!("../../../src/providers/fal.json");
const COMFYUI_JSON: &str = include_str!("../../../src/providers/comfyui.json");

fn parsed(cell: &'static OnceLock<Value>, source: &str, name: &str) -> &'static Value {
    cell.get_or_init(|| {
        serde_json::from_str(source).unwrap_or_else(|e| panic!("invalid {name}: {e}"))
    })
}

pub fn capabilities() -> &'static Map<String, Value> {
    static CELL: OnceLock<Value> = OnceLock::new();
    parsed(&CELL, CAPABILITIES_JSON, "capabilities.json")
        .as_object()
        .expect("capabilities.json must be an object")
}

/// Provider manifests, in palette order (the first provider of a capability is
/// the default for new nodes).
pub fn manifests() -> &'static [Value] {
    static LIST: OnceLock<Vec<Value>> = OnceLock::new();
    LIST.get_or_init(|| {
        [
            ("pixverse.json", PIXVERSE_JSON),
            ("fal.json", FAL_JSON),
            ("comfyui.json", COMFYUI_JSON),
        ]
        .into_iter()
        .map(|(name, source)| {
            serde_json::from_str(source).unwrap_or_else(|e| panic!("invalid {name}: {e}"))
        })
        .collect()
    })
}

pub fn manifest(provider: &str) -> Option<&'static Value> {
    manifests().iter().find(|m| m["id"] == provider)
}

/// Resolve a capability name or one of its legacy aliases (`image`, `video`, …).
pub fn resolve_capability(name: &str) -> Option<&'static str> {
    capabilities().iter().find_map(|(id, cap)| {
        let alias = cap["aliases"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x == name));
        (id == name || alias).then_some(id.as_str())
    })
}

/// Parameter specs a provider accepts for a capability, with `param_defs`
/// merged under each entry's overrides. With a model, that model's
/// `model_params` entry is applied last: an object overrides fields (e.g. a
/// narrower `options` list), `null` removes the param.
pub fn param_specs(
    provider: &str,
    capability: &str,
    model: Option<&str>,
) -> Option<Vec<Map<String, Value>>> {
    let manifest = manifest(provider)?;
    let cap = manifest["capabilities"].get(capability)?;
    let defs = &manifest["param_defs"];
    let overrides = model
        .and_then(|m| cap["model_params"].get(m))
        .and_then(|o| o.as_object());
    Some(
        cap["params"]
            .as_array()
            .map(|params| {
                params
                    .iter()
                    .filter_map(|p| {
                        let key = p["key"].as_str()?;
                        let mut spec = defs[key].as_object().cloned().unwrap_or_default();
                        spec.extend(p.as_object()?.clone());
                        match overrides.and_then(|o| o.get(key)) {
                            Some(Value::Null) => return None,
                            Some(Value::Object(o)) => spec.extend(o.clone()),
                            _ => {}
                        }
                        Some(spec)
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// Reject parameters the provider does not declare for the capability (and
/// model), or values of the wrong shape. Keys starting with `_` are internal.
/// Manifests marked `strict` also reject models and enum values outside their
/// lists; PixVerse is lenient because older projects carry free-form values.
pub fn validate(provider: &str, req: &TaskRequest) -> Result<(), ProviderError> {
    let manifest = manifest(provider)
        .ok_or_else(|| ProviderError::InvalidParams(format!("unknown provider `{provider}`")))?;
    let strict = manifest["strict"] == true;
    let entry = &manifest["capabilities"][&req.capability];
    if strict {
        let models = entry["models"].as_array().cloned().unwrap_or_default();
        match &req.model {
            Some(m) if !models.iter().any(|x| x == m.as_str()) => {
                let valid: Vec<&str> = models.iter().filter_map(|x| x.as_str()).collect();
                return Err(ProviderError::InvalidParams(format!(
                    "{provider} has no model `{m}` for {} — valid: {}",
                    req.capability,
                    valid.join(", ")
                )));
            }
            None if !models.is_empty() => {
                return Err(ProviderError::InvalidParams(format!(
                    "choose a {provider} model for {}",
                    req.capability
                )));
            }
            _ => {}
        }
    }
    let specs = param_specs(provider, &req.capability, req.model.as_deref()).ok_or_else(|| {
        ProviderError::InvalidParams(format!("{provider} does not support `{}`", req.capability))
    })?;
    for (bucket, map) in [
        ("params", &req.params),
        ("provider_params", &req.provider_params),
    ] {
        for (key, value) in map {
            if key.starts_with('_') || value.is_null() {
                continue;
            }
            let Some(spec) = specs
                .iter()
                .find(|s| s["key"] == key.as_str() && s["bucket"] == bucket)
            else {
                let valid: Vec<&str> = specs
                    .iter()
                    .filter(|s| s["bucket"] == bucket)
                    .filter_map(|s| s["key"].as_str())
                    .collect();
                let model = req
                    .model
                    .as_deref()
                    .map(|m| format!(" with {m}"))
                    .unwrap_or_default();
                return Err(ProviderError::InvalidParams(format!(
                    "`{key}` is not a {provider} parameter for {}{model} — valid {bucket}: {}",
                    req.capability,
                    valid.join(", ")
                )));
            };
            let boolean = matches!(spec["type"].as_str(), Some("bool" | "tri"));
            let ok = if boolean {
                value.is_boolean()
            } else {
                value.is_string() || value.is_number()
            };
            if !ok {
                let expected = if boolean {
                    "true or false"
                } else {
                    "a string or number"
                };
                return Err(ProviderError::InvalidParams(format!(
                    "`{key}` must be {expected}"
                )));
            }
            if strict && matches!(spec["type"].as_str(), Some("int" | "number")) {
                let n = value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|v| v.parse().ok()));
                let Some(n) = n else {
                    return Err(ProviderError::InvalidParams(format!(
                        "`{key}` must be a number"
                    )));
                };
                let below = spec["min"].as_f64().is_some_and(|min| n < min);
                let above = spec["max"].as_f64().is_some_and(|max| n > max);
                if below || above {
                    return Err(ProviderError::InvalidParams(format!(
                        "`{key}` = {n} is out of range ({} – {})",
                        spec["min"], spec["max"]
                    )));
                }
            }
            if let (true, Some(options)) = (strict, spec.get("options").and_then(|o| o.as_array()))
            {
                // Compare as text so 5 and "5" match.
                let text = |v: &Value| {
                    v.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string())
                };
                if !options.iter().any(|o| text(o) == text(value)) {
                    let valid: Vec<String> = options.iter().map(text).collect();
                    return Err(ProviderError::InvalidParams(format!(
                        "`{key}` = {} is not supported by {} — choose one of: {}",
                        text(value),
                        req.model.as_deref().unwrap_or(provider),
                        valid.join(", ")
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Machine-readable catalog for agents (MCP `describe_capabilities`).
pub fn describe(capability: Option<&str>) -> Result<Value, String> {
    let wanted = match capability {
        Some(name) => {
            Some(resolve_capability(name).ok_or_else(|| format!("unknown capability `{name}`"))?)
        }
        None => None,
    };
    let mut out = Vec::new();
    for (id, cap) in capabilities() {
        if wanted.is_some_and(|w| w != id) {
            continue;
        }
        let providers: Vec<Value> = manifests()
            .iter()
            .filter_map(|m| {
                let provider = m["id"].as_str()?;
                let entry = &m["capabilities"][id];
                if entry.is_null() {
                    return None;
                }
                let params: Vec<Value> = param_specs(provider, id, None)?
                    .into_iter()
                    .map(|s| {
                        let mut p = Map::new();
                        for k in ["key", "type", "options", "default", "min", "max", "bucket"] {
                            if let Some(v) = s.get(k) {
                                p.insert(k.to_string(), v.clone());
                            }
                        }
                        Value::Object(p)
                    })
                    .collect();
                // Per-model narrowing: `null` = param not accepted by that model.
                let model_params = &entry["model_params"];
                Some(json!({
                    "provider": provider,
                    "auth": m["auth"],
                    "local": m["local"] == true,
                    "workflow": m["workflow"] == true,
                    "models": entry["models"],
                    "model_params": model_params,
                    "default_model": entry["initial"]["model"],
                    "params": params,
                    "notes": entry["help"],
                }))
            })
            .collect();
        let inputs: Vec<Value> = cap["ports"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| json!({ "port": p["label"], "kind": p["kind"], "slot": p["slot"] }))
            .collect();
        out.push(json!({
            "capability": id,
            "title": cap["title"],
            "aliases": cap["aliases"],
            "output": cap["output"],
            "inputs": inputs,
            "providers": providers,
        }));
    }
    Ok(json!({ "capabilities": out }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::TaskRequest;
    use std::collections::BTreeMap;

    fn request(capability: &str, params: Value, provider_params: Value) -> TaskRequest {
        TaskRequest {
            capability: capability.into(),
            model: None,
            prompt: String::new(),
            inputs: BTreeMap::new(),
            slot_ports: BTreeMap::new(),
            params: params.as_object().cloned().unwrap(),
            provider_params: provider_params.as_object().cloned().unwrap(),
        }
    }

    #[test]
    fn every_manifest_capability_is_registered_and_initial_values_validate() {
        for m in manifests() {
            let provider = m["id"].as_str().unwrap();
            for (id, entry) in m["capabilities"].as_object().unwrap() {
                assert!(
                    capabilities().contains_key(id),
                    "{provider}: unknown capability {id}"
                );
                let init = &entry["initial"];
                let mut req = request(id, init["params"].clone(), init["provider_params"].clone());
                req.model = init["model"].as_str().map(String::from);
                validate(provider, &req).unwrap_or_else(|e| panic!("{provider} {id}: {e}"));
                for spec in param_specs(provider, id, None).unwrap() {
                    assert!(
                        spec.contains_key("bucket"),
                        "{id}: {:?} has no param_def",
                        spec["key"]
                    );
                }
                // Per-model overrides may only narrow params the capability lists.
                let keys: Vec<&str> = entry["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|p| p["key"].as_str())
                    .collect();
                for (model, overrides) in entry["model_params"].as_object().into_iter().flatten() {
                    assert!(
                        entry["models"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|m| m == model.as_str()),
                        "{provider} {id}: model_params for unlisted model {model}"
                    );
                    for key in overrides.as_object().unwrap().keys() {
                        assert!(
                            keys.contains(&key.as_str()),
                            "{provider} {id} {model}: override for unknown param {key}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn aliases_resolve_to_capabilities() {
        assert_eq!(resolve_capability("image"), Some("image.generate"));
        assert_eq!(
            resolve_capability("motion_control"),
            Some("video.motion_control")
        );
        assert_eq!(resolve_capability("video.upscale"), Some("video.upscale"));
        assert_eq!(resolve_capability("nope"), None);
    }

    #[test]
    fn validate_rejects_unknown_keys_wrong_bucket_and_bad_types() {
        let ok = request(
            "video.generate",
            json!({ "seed": 3, "audio": false }),
            json!({ "off_peak": true }),
        );
        assert!(validate("pixverse", &ok).is_ok());
        let unknown = request("video.upscale", json!({ "seed": 3 }), json!({}));
        assert!(validate("pixverse", &unknown)
            .unwrap_err()
            .to_string()
            .contains("seed"));
        let bucket = request("video.generate", json!({ "off_peak": true }), json!({}));
        assert!(validate("pixverse", &bucket).is_err());
        let bool_type = request("video.generate", json!({}), json!({ "off_peak": "yes" }));
        assert!(validate("pixverse", &bool_type).is_err());
        let internal = request(
            "image.generate",
            json!({}),
            json!({ "_raw_args": ["create"] }),
        );
        assert!(validate("pixverse", &internal).is_ok());
        assert!(validate("pixverse", &request("nope", json!({}), json!({}))).is_err());
    }

    #[test]
    fn describe_lists_models_and_ports() {
        let all = describe(None).unwrap();
        assert_eq!(
            all["capabilities"].as_array().unwrap().len(),
            capabilities().len()
        );
        let one = describe(Some("voice")).unwrap();
        let cap = &one["capabilities"][0];
        assert_eq!(cap["capability"], "audio.speech");
        assert_eq!(cap["providers"][0]["default_model"], "speech-2.8-hd");
        assert!(describe(Some("nope")).is_err());
    }
}
