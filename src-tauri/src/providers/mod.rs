// Generation providers.
//
// A `kind: "task"` node names *what* to do (capability), *which* model, and
// *who* runs it (provider). This module resolves such a node into a
// provider-neutral `TaskRequest` and dispatches it to the matching `Provider`.
// See docs/design/multi-provider.md.

pub mod cancel;
pub mod catalog;
pub mod fal;
pub mod inputs;
pub mod pixverse;
pub mod secrets;

use crate::thumbs::Thumb;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use tauri::{AppHandle, Window};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One upstream media input, resolved to what providers can consume.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaRef {
    /// image | video | audio
    pub kind: String,
    /// Local path or remote URL; empty when only cloud ids are known.
    pub path: String,
    /// Provider id → that provider's cloud id for this media.
    pub cloud_ids: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct TaskRequest {
    pub capability: String,
    pub model: Option<String>,
    pub prompt: String,
    /// Slot name → connected media, ordered by input port.
    pub inputs: BTreeMap<String, Vec<MediaRef>>,
    /// Slot name → number of input ports the node declares for it.
    pub slot_ports: BTreeMap<String, usize>,
    pub params: Map<String, Value>,
    pub provider_params: Map<String, Value>,
}

pub struct TaskOutput {
    pub thumbs: Vec<Thumb>,
    /// Raw provider response, kept for debugging.
    pub raw: Value,
}

#[derive(Debug)]
pub enum ProviderError {
    InvalidParams(String),
    Remote(String),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderError::InvalidParams(m) | ProviderError::Remote(m) => f.write_str(m),
        }
    }
}

pub struct RunCtx {
    pub app: AppHandle,
    pub window: Window,
    pub config: Value,
    pub run_id: String,
}

impl RunCtx {
    pub fn progress(&self, value: f64) {
        let _ = self
            .window
            .emit(&format!("progress:{}", self.run_id), value);
    }
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;

    /// Turn a task node and its deps into a request. Providers override this
    /// only when they need node data beyond the neutral request.
    fn build_request(&self, node: &Value, deps: &[Value]) -> Result<TaskRequest, ProviderError> {
        inputs::task_request(node, deps)
    }

    fn run<'a>(
        &'a self,
        req: TaskRequest,
        ctx: &'a RunCtx,
    ) -> BoxFuture<'a, Result<TaskOutput, ProviderError>>;

    /// Human-readable form of what `run` would execute, for the Inspector.
    fn preview(&self, _req: &TaskRequest) -> Result<Vec<String>, ProviderError> {
        Err(ProviderError::InvalidParams("no preview available".into()))
    }
}

static PIXVERSE: pixverse::PixVerseProvider = pixverse::PixVerseProvider;
static FAL: fal::FalProvider = fal::FalProvider;

pub fn provider(id: &str) -> Option<&'static dyn Provider> {
    match id {
        "pixverse" => Some(&PIXVERSE),
        "fal" => Some(&FAL),
        _ => None,
    }
}

fn node_provider(node: &Value) -> Result<&'static dyn Provider, String> {
    let id = node.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    provider(id).ok_or_else(|| format!("Unknown provider: {id}"))
}

/// Execute a `kind: "task"` node.
pub async fn run_task(node: Value, deps: Vec<Value>, ctx: RunCtx) -> Result<Value, String> {
    let provider = node_provider(&node)?;
    let req = provider
        .build_request(&node, &deps)
        .map_err(|e| e.to_string())?;
    catalog::validate(provider.id(), &req).map_err(|e| e.to_string())?;
    let out = provider.run(req, &ctx).await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "provider": provider.id(),
        "thumbs": out.thumbs,
        "raw": out.raw,
    }))
}

/// What a task node would execute, with each input shown as `<port label>`.
pub fn preview_task(node: &Value) -> Result<Vec<String>, String> {
    let provider = node_provider(node)?;
    let mut req = inputs::task_request(node, &[]).map_err(|e| e.to_string())?;
    if let Some(raw) = req.provider_params.get("_raw_args") {
        return serde_json::from_value(raw.clone()).map_err(|e| e.to_string());
    }
    let ports = node.get("ports").and_then(|p| p.as_array());
    for port in ports.into_iter().flatten() {
        let (Some("left"), Some(slot), Some(kind)) = (
            port.get("side").and_then(|v| v.as_str()),
            port.get("slot").and_then(|v| v.as_str()),
            port.get("kind").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let label = port.get("label").and_then(|v| v.as_str()).unwrap_or(slot);
        if kind == "text" {
            if req.prompt.is_empty() {
                req.prompt = format!("<{label}>");
            }
        } else {
            req.inputs
                .entry(slot.to_string())
                .or_default()
                .push(MediaRef {
                    kind: kind.to_string(),
                    path: format!("<{label}>"),
                    cloud_ids: BTreeMap::new(),
                });
        }
    }
    catalog::validate(provider.id(), &req).map_err(|e| e.to_string())?;
    provider.preview(&req).map_err(|e| e.to_string())
}
