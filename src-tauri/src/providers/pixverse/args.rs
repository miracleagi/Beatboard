// TaskRequest → PixVerse CLI argv.
//
// Each capability maps to one `pixverse create <sub>` subcommand. Flags are
// emitted in the subcommand's canonical order (the order of Beatboard's
// palette templates, so untouched nodes produce the exact legacy argv), then
// any remaining parameters in a fixed global order, then `--json`.

use crate::providers::{ProviderError, TaskRequest};
use serde_json::Value;

#[derive(Clone, Copy)]
enum Input {
    /// First connected media path.
    Single(&'static str),
    /// Every connected media path (variadic flag).
    Multi(&'static str),
    /// `single` when the slot has one input port, else `multi`.
    ByPorts {
        single: &'static str,
        multi: &'static str,
    },
    /// PixVerse cloud id of the first connected media, else its path.
    CloudIdOrPath(&'static str),
}

#[derive(Clone, Copy)]
enum Arg {
    Prompt(&'static str),
    Input(&'static str, Input),
    Model,
    Param(&'static str),
    ProviderParam(&'static str),
}

use Arg::{Model, Param, Prompt, ProviderParam as PP};

struct Spec {
    capability: &'static str,
    sub: &'static str,
    order: &'static [Arg],
}

const SPECS: &[Spec] = &[
    Spec {
        capability: "image.generate",
        sub: "image",
        order: &[
            Prompt("--prompt"),
            Arg::Input(
                "images",
                Input::ByPorts {
                    single: "--image",
                    multi: "--images",
                },
            ),
            Model,
            Param("resolution"),
            Param("aspect_ratio"),
            Param("count"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.generate",
        sub: "video",
        order: &[
            Prompt("--prompt"),
            Arg::Input("image", Input::Single("--image")),
            Model,
            Param("duration_s"),
            Param("resolution"),
            Param("aspect_ratio"),
            Param("count"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.transition",
        sub: "transition",
        order: &[
            Arg::Input("frames", Input::Multi("--images")),
            Prompt("--prompt"),
            Model,
            Param("resolution"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.reference",
        sub: "reference",
        order: &[
            Arg::Input("images", Input::Multi("--images")),
            Arg::Input("videos", Input::Multi("--videos")),
            Arg::Input("audios", Input::Multi("--audios")),
            Prompt("--prompt"),
            Model,
            Param("resolution"),
            Param("aspect_ratio"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.motion_control",
        sub: "motion-control",
        order: &[
            Arg::Input("character", Input::Single("--image")),
            Arg::Input("motion", Input::Single("--video")),
            Model,
            Param("resolution"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.extend",
        sub: "extend",
        order: &[
            Arg::Input("video", Input::CloudIdOrPath("--video")),
            Prompt("--prompt"),
            Model,
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.upscale",
        sub: "upscale",
        order: &[
            Arg::Input("video", Input::CloudIdOrPath("--video")),
            Param("resolution"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "video.modify",
        sub: "modify",
        order: &[
            Arg::Input("video", Input::CloudIdOrPath("--video")),
            Arg::Input("images", Input::Multi("--images")),
            Prompt("--prompt"),
            PP("keyframe_time"),
            Model,
            Param("resolution"),
            Param("count"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "audio.speech",
        sub: "voice",
        order: &[
            Prompt("--text"),
            Model,
            PP("language"),
            PP("speed"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "audio.music",
        sub: "music",
        order: &[
            Prompt("--prompt"),
            Arg::Input("image", Input::Multi("--image")),
            Model,
            PP("instrumental"),
            Param("duration_s"),
            PP("timeout"),
        ],
    },
    Spec {
        capability: "provider.template",
        sub: "template",
        order: &[
            Arg::Input("images", Input::Multi("--image")),
            Arg::Input("video", Input::Single("--video")),
            Prompt("--prompt"),
            Param("resolution"),
            Param("count"),
            PP("timeout"),
        ],
    },
];

/// Common params emitted after the canonical order, in this order.
const PARAM_ORDER: &[&str] = &[
    "resolution",
    "aspect_ratio",
    "duration_s",
    "count",
    "seed",
    "audio",
];

/// PixVerse-specific params emitted after common ones, in this order.
/// Keys not listed here follow alphabetically.
const PROVIDER_PARAM_ORDER: &[&str] = &[
    "detail_level",
    "keyframe_time",
    "template_id",
    "lyrics",
    "voice_id",
    "provider_voice_id",
    "language",
    "stability",
    "similarity_boost",
    "style",
    "use_speaker_boost",
    "speed",
    "volume",
    "pitch",
    "emotion",
    "multi_shot",
    "instrumental",
    "auto_lyrics",
    "no_duration_auto",
    "off_peak",
    "idempotency_key",
    "client_request_id",
    "output",
    "no_wait",
    "timeout",
];

/// Boolean flags with an explicit `--no-` form: false emits `--no-<flag>`.
const TRI_STATE: &[&str] = &["audio", "multi_shot", "use_speaker_boost"];

fn param_flag(capability: &str, key: &str) -> String {
    match key {
        "resolution" => "--quality".into(),
        "duration_s" if capability == "audio.music" => "--duration-seconds".into(),
        "duration_s" => "--duration".into(),
        _ => format!("--{}", key.replace('_', "-")),
    }
}

fn scalar(key: &str, value: &Value) -> Result<String, ProviderError> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(ProviderError::InvalidParams(format!(
            "PixVerse parameter `{key}` must be a string or number"
        ))),
    }
}

fn push_param(
    out: &mut Vec<String>,
    capability: &str,
    key: &str,
    value: &Value,
) -> Result<(), ProviderError> {
    let flag = param_flag(capability, key);
    match value {
        Value::Null => {}
        Value::Bool(true) => out.push(flag),
        Value::Bool(false) if TRI_STATE.contains(&key) => {
            out.push(format!("--no-{}", key.replace('_', "-")))
        }
        Value::Bool(false) => {}
        other => {
            out.push(flag);
            out.push(scalar(key, other)?);
        }
    }
    Ok(())
}

fn push_input(out: &mut Vec<String>, req: &TaskRequest, slot: &str, input: Input) {
    let refs = req.inputs.get(slot).map(Vec::as_slice).unwrap_or(&[]);
    let paths = || {
        refs.iter()
            .map(|r| r.path.clone())
            .filter(|p| !p.is_empty())
    };
    let (flag, values): (&str, Vec<String>) = match input {
        Input::Single(flag) => (flag, paths().take(1).collect()),
        Input::Multi(flag) => (flag, paths().collect()),
        Input::ByPorts { single, multi } => {
            if req.slot_ports.get(slot).copied().unwrap_or(0) <= 1 {
                (single, paths().take(1).collect())
            } else {
                (multi, paths().collect())
            }
        }
        Input::CloudIdOrPath(flag) => (
            flag,
            refs.iter()
                .find_map(|r| {
                    r.cloud_ids
                        .get("pixverse")
                        .cloned()
                        .or_else(|| (!r.path.is_empty()).then(|| r.path.clone()))
                })
                .into_iter()
                .collect(),
        ),
    };
    if !values.is_empty() {
        out.push(flag.to_string());
        out.extend(values);
    }
}

pub fn build_args(req: &TaskRequest) -> Result<Vec<String>, ProviderError> {
    let spec = SPECS
        .iter()
        .find(|s| s.capability == req.capability)
        .ok_or_else(|| {
            ProviderError::InvalidParams(format!(
                "PixVerse does not support capability `{}`",
                req.capability
            ))
        })?;

    let mut out = vec!["create".to_string(), spec.sub.to_string()];
    let mut model_done = false;
    let mut params_done: Vec<&str> = Vec::new();
    let mut provider_done: Vec<&str> = Vec::new();

    for arg in spec.order {
        match *arg {
            Prompt(flag) => {
                if !req.prompt.is_empty() {
                    out.push(flag.to_string());
                    out.push(req.prompt.clone());
                }
            }
            Arg::Input(slot, input) => push_input(&mut out, req, slot, input),
            Model => {
                model_done = true;
                if let Some(model) = &req.model {
                    out.push("--model".into());
                    out.push(model.clone());
                }
            }
            Param(key) => {
                params_done.push(key);
                if let Some(v) = req.params.get(key) {
                    push_param(&mut out, &req.capability, key, v)?;
                }
            }
            PP(key) => {
                provider_done.push(key);
                if let Some(v) = req.provider_params.get(key) {
                    push_param(&mut out, &req.capability, key, v)?;
                }
            }
        }
    }

    if !model_done {
        if let Some(model) = &req.model {
            out.push("--model".into());
            out.push(model.clone());
        }
    }

    let ordered_rest = |map: &serde_json::Map<String, Value>, order: &[&str], done: &[&str]| {
        let mut keys: Vec<String> = order
            .iter()
            .filter(|k| map.contains_key(**k))
            .map(|k| k.to_string())
            .collect();
        let mut unknown: Vec<String> = map
            .keys()
            .filter(|k| !order.contains(&k.as_str()))
            .cloned()
            .collect();
        unknown.sort();
        keys.extend(unknown);
        keys.retain(|k| !done.contains(&k.as_str()) && !k.starts_with('_'));
        keys
    };

    for key in ordered_rest(&req.params, PARAM_ORDER, &params_done) {
        push_param(&mut out, &req.capability, &key, &req.params[&key])?;
    }
    for key in ordered_rest(&req.provider_params, PROVIDER_PARAM_ORDER, &provider_done) {
        push_param(&mut out, &req.capability, &key, &req.provider_params[&key])?;
    }

    out.push("--json".into());
    Ok(out)
}
