// ComfyUI provider: runs the user's own ComfyUI workflow on a ComfyUI server
// (by default the local one at http://127.0.0.1:8188). Nothing is billed.
//
// A `comfyui.workflow` node carries `workflow`: the graph in ComfyUI's API
// format (Workflow → Export (API)) plus `bindings` saying which node input
// takes the prompt, the negative prompt and the seed, which Load* nodes take
// the node's connected media, and which node's output is the result. The
// Inspector suggests bindings on import (src/comfyui-workflow.jsx); anything
// left unbound keeps the workflow's own value.
//
// Protocol (ComfyUI server.py):
//   POST /upload/image   multipart image=<file>, overwrite=true → { name, subfolder, type }
//   POST /prompt         { prompt, client_id }                → { prompt_id, number, node_errors }
//   GET  /history/{id}                                          → {} until finished, then { id: { status, outputs } }
//   GET  /queue                                                 → { queue_running: [[n, id, …]], queue_pending: […] }
//   GET  /view?filename=&subfolder=&type=                       → file bytes
//   POST /queue { delete: [id] }, POST /interrupt { prompt_id }  → cancel

use super::{
    inputs, BoxFuture, MediaRef, Provider, ProviderError, RunCtx, TaskOutput, TaskRequest,
};
use crate::storage::runs_dir;
use crate::thumbs::Thumb;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const DEFAULT_SERVER: &str = "http://127.0.0.1:8188";
const CLIENT_ID: &str = "beatboard";
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Polls in a row that find the prompt neither queued nor in history before
/// we conclude the server lost it (e.g. it was restarted).
const MAX_MISSING_POLLS: u32 = 3;
const MAX_POLL_ERRORS: u32 = 5;

// ─── Workflow ───────────────────────────────────────────────────────────────

/// One node input, e.g. `{ node: "6", input: "text" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub node: String,
    pub input: String,
}

/// A Load* node input fed by one of the Beatboard node's input ports. The
/// port's slot is `in@<node>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaBinding {
    pub node: String,
    pub input: String,
    /// image | video | audio
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Bindings {
    #[serde(default)]
    pub prompt: Option<Target>,
    #[serde(default)]
    pub negative: Option<Target>,
    #[serde(default)]
    pub seed: Vec<Target>,
    #[serde(default)]
    pub inputs: Vec<MediaBinding>,
    /// Node whose outputs are the result; None collects every saved output.
    #[serde(default)]
    pub output: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Workflow {
    #[serde(default)]
    pub name: String,
    pub graph: Map<String, Value>,
    #[serde(default)]
    pub bindings: Bindings,
}

pub fn input_slot(node: &str) -> String {
    format!("in@{node}")
}

fn invalid(msg: impl Into<String>) -> ProviderError {
    ProviderError::InvalidParams(msg.into())
}

fn class_type<'a>(graph: &'a Map<String, Value>, node: &str) -> &'a str {
    graph
        .get(node)
        .and_then(|n| n["class_type"].as_str())
        .unwrap_or("?")
}

/// Check a workflow is in API format and its bindings point at real inputs.
pub fn check_workflow(wf: &Workflow) -> Result<(), ProviderError> {
    if wf.graph.is_empty() {
        return Err(invalid("the imported ComfyUI workflow is empty"));
    }
    for (id, node) in &wf.graph {
        if !node["class_type"].is_string() || !node["inputs"].is_object() {
            return Err(invalid(format!(
                "node #{id} is not in ComfyUI's API format — in ComfyUI use Workflow → Export (API) and import that file"
            )));
        }
    }
    let b = &wf.bindings;
    let targets = b
        .prompt
        .iter()
        .map(|t| ("prompt", t))
        .chain(b.negative.iter().map(|t| ("negative prompt", t)))
        .chain(b.seed.iter().map(|t| ("seed", t)));
    let media = b.inputs.iter().map(|m| {
        (
            "input",
            Target {
                node: m.node.clone(),
                input: m.input.clone(),
            },
        )
    });
    for (role, t) in targets.map(|(r, t)| (r, t.clone())).chain(media) {
        let Some(node) = wf.graph.get(&t.node) else {
            return Err(invalid(format!(
                "the {role} is bound to node #{} which is not in the workflow",
                t.node
            )));
        };
        match node["inputs"].get(&t.input) {
            None => {
                return Err(invalid(format!(
                    "the {role} is bound to #{} {}.{} which does not exist",
                    t.node,
                    node["class_type"].as_str().unwrap_or("?"),
                    t.input
                )))
            }
            // An array is a link to another node's output: overwriting it
            // would cut the graph.
            Some(Value::Array(_)) => {
                return Err(invalid(format!(
                "the {role} is bound to #{} {}.{}, which is wired to another node in the workflow",
                t.node,
                node["class_type"].as_str().unwrap_or("?"),
                t.input
            )))
            }
            Some(_) => {}
        }
    }
    if let Some(out) = &b.output {
        if !wf.graph.contains_key(out) {
            return Err(invalid(format!(
                "the output is bound to node #{out} which is not in the workflow"
            )));
        }
    }
    Ok(())
}

// ─── Request planning (pure) ────────────────────────────────────────────────

/// What to submit: the workflow with prompt / negative prompt filled in, the
/// media to upload into bound inputs, and one seed per prompt to queue.
#[derive(Debug)]
pub struct Plan {
    pub name: String,
    pub graph: Map<String, Value>,
    pub uploads: Vec<(Target, MediaRef)>,
    /// One entry per prompt to queue (`count`); None = keep the workflow's seed.
    pub seeds: Vec<Option<u64>>,
    pub bindings: Bindings,
}

fn int_param(req: &TaskRequest, key: &str) -> Result<Option<u64>, ProviderError> {
    match req.params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
            .map(Some)
            .ok_or_else(|| invalid(format!("`{key}` must be a whole number"))),
    }
}

/// A random seed in JavaScript's safe-integer range, so the UI can show it.
pub fn random_seed() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    h.finish() & ((1 << 53) - 1)
}

fn set_input(graph: &mut Map<String, Value>, t: &Target, value: Value) {
    if let Some(inputs) = graph
        .get_mut(&t.node)
        .and_then(|n| n.get_mut("inputs"))
        .and_then(|i| i.as_object_mut())
    {
        inputs.insert(t.input.clone(), value);
    }
}

pub fn plan(req: &TaskRequest, mut random: impl FnMut() -> u64) -> Result<Plan, ProviderError> {
    let raw = req
        .provider_params
        .get("_workflow")
        .filter(|w| !w.is_null())
        .ok_or_else(|| {
            invalid("import a ComfyUI workflow (Workflow → Export (API)) in the Inspector first")
        })?;
    let wf: Workflow = serde_json::from_value(raw.clone())
        .map_err(|e| invalid(format!("the imported ComfyUI workflow is malformed: {e}")))?;
    check_workflow(&wf)?;
    let b = &wf.bindings;
    let mut graph = wf.graph.clone();

    if !req.prompt.trim().is_empty() {
        let t = b.prompt.as_ref().ok_or_else(|| {
            invalid("this workflow has no prompt input — mark one in the Inspector, or disconnect the prompt")
        })?;
        set_input(&mut graph, t, Value::String(req.prompt.clone()));
    }
    match req.provider_params.get("negative_prompt") {
        Some(Value::String(neg)) if !neg.is_empty() => {
            let t = b.negative.as_ref().ok_or_else(|| {
                invalid("this workflow has no negative prompt input — mark one in the Inspector or clear the field")
            })?;
            set_input(&mut graph, t, Value::String(neg.clone()));
        }
        _ => {}
    }

    let mut uploads = Vec::new();
    for m in &b.inputs {
        let Some(media) = req.inputs.get(&input_slot(&m.node)).and_then(|v| v.first()) else {
            continue; // unconnected: the workflow's own file stays
        };
        if media.path.is_empty() {
            return Err(invalid(format!(
                "the {} connected to #{} {} only exists in another provider's cloud — ComfyUI needs a file",
                media.kind,
                m.node,
                class_type(&graph, &m.node)
            )));
        }
        uploads.push((
            Target {
                node: m.node.clone(),
                input: m.input.clone(),
            },
            media.clone(),
        ));
    }

    let seed = int_param(req, "seed")?;
    let count = int_param(req, "count")?.unwrap_or(1).max(1);
    if b.seed.is_empty() && (seed.is_some() || count > 1) {
        return Err(invalid(
            "this workflow has no seed input marked — mark one in the Inspector to set the seed or generate more than one",
        ));
    }
    let seeds = (0..count)
        .map(|i| match (b.seed.is_empty(), seed) {
            (true, _) => None,
            (false, Some(s)) => Some(s + i),
            (false, None) => Some(random()),
        })
        .collect();

    Ok(Plan {
        name: if wf.name.is_empty() {
            "ComfyUI".into()
        } else {
            wf.name.clone()
        },
        graph,
        uploads,
        seeds,
        bindings: wf.bindings.clone(),
    })
}

/// The graph to POST for one queued prompt: uploaded file names in the bound
/// inputs and this prompt's seed in every seed input.
pub fn prompt_graph(plan: &Plan, uploaded: &[String], seed: Option<u64>) -> Map<String, Value> {
    let mut graph = plan.graph.clone();
    for ((t, _), name) in plan.uploads.iter().zip(uploaded) {
        set_input(&mut graph, t, Value::String(name.clone()));
    }
    if let Some(seed) = seed {
        for t in &plan.bindings.seed {
            set_input(&mut graph, t, json!(seed));
        }
    }
    graph
}

// ─── Reading results (pure) ─────────────────────────────────────────────────

/// A file a finished prompt produced.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputFile {
    pub filename: String,
    pub subfolder: String,
    pub folder: String,
}

/// Outcome of a finished history entry: its output files, or why it failed.
pub fn outcome(entry: &Value, output: Option<&str>) -> Result<Vec<OutputFile>, String> {
    let status = &entry["status"];
    let messages = status["messages"].as_array().cloned().unwrap_or_default();
    let message = |kind: &str| messages.iter().find(|m| m[0] == kind).map(|m| m[1].clone());
    if status["status_str"] == "error" {
        if let Some(e) = message("execution_error") {
            return Err(format!(
                "ComfyUI failed in #{} {}: {}",
                inputs_text(&e["node_id"]),
                e["node_type"].as_str().unwrap_or("?"),
                e["exception_message"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .trim()
            ));
        }
        if message("execution_interrupted").is_some() {
            return Err("the ComfyUI run was interrupted".into());
        }
        return Err("ComfyUI reported an error running this workflow".into());
    }

    let outputs = entry["outputs"].as_object().cloned().unwrap_or_default();
    let files_of = |node_out: &Value| -> Vec<OutputFile> {
        node_out
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(_, v)| v.as_array())
            .flatten()
            .filter_map(|f| {
                Some(OutputFile {
                    filename: f["filename"].as_str()?.to_string(),
                    subfolder: f["subfolder"].as_str().unwrap_or("").to_string(),
                    folder: f["type"].as_str().unwrap_or("output").to_string(),
                })
            })
            .collect()
    };
    let files: Vec<OutputFile> = match output {
        Some(node) => outputs.get(node).map(files_of).unwrap_or_default(),
        None => {
            // Prefer saved files over temporary previews.
            let mut ids: Vec<&String> = outputs.keys().collect();
            ids.sort_by_key(|id| (id.parse::<u64>().unwrap_or(u64::MAX), (*id).clone()));
            let all: Vec<OutputFile> = ids.iter().flat_map(|id| files_of(&outputs[*id])).collect();
            let saved: Vec<OutputFile> = all
                .iter()
                .filter(|f| f.folder == "output")
                .cloned()
                .collect();
            if saved.is_empty() {
                all
            } else {
                saved
            }
        }
    };
    if files.is_empty() {
        let which = output
            .map(|n| format!("output node #{n}"))
            .unwrap_or_else(|| "the workflow".into());
        return Err(format!(
            "{which} produced no files — if nothing changed since the last run ComfyUI may have reused its cache; change the seed (or leave it empty for a random one)"
        ));
    }
    Ok(files)
}

fn inputs_text(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}

fn media_kind(filename: &str) -> &'static str {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "webm" | "mov" | "mkv" | "m4v" | "avi" => "video",
        "mp3" | "wav" | "flac" | "ogg" | "opus" | "m4a" | "aac" => "audio",
        _ => "image",
    }
}

/// Minimal query-component encoding for /view parameters.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn view_url(base: &str, f: &OutputFile) -> String {
    format!(
        "{base}/view?filename={}&subfolder={}&type={}",
        encode(&f.filename),
        encode(&f.subfolder),
        encode(&f.folder)
    )
}

/// Readable message for a rejected /prompt, including per-node errors.
pub fn prompt_error(status: u16, body: &str) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut parts = Vec::new();
    if let Some(e) = parsed["error"].as_object() {
        let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("");
        let details = e.get("details").and_then(|d| d.as_str()).unwrap_or("");
        let line = [msg, details]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(": ");
        if !line.is_empty() {
            parts.push(line);
        }
    } else if let Some(e) = parsed["error"].as_str() {
        parts.push(e.to_string());
    }
    for (id, node) in parsed["node_errors"].as_object().into_iter().flatten() {
        let class = node["class_type"].as_str().unwrap_or("?");
        for err in node["errors"].as_array().into_iter().flatten() {
            let msg = err["message"].as_str().unwrap_or("invalid");
            let details = err["details"].as_str().unwrap_or("");
            parts.push(if details.is_empty() {
                format!("#{id} {class}: {msg}")
            } else {
                format!("#{id} {class}: {msg} ({details})")
            });
        }
    }
    if parts.is_empty() {
        parts.push(body.chars().take(300).collect());
    }
    format!(
        "ComfyUI rejected the workflow (HTTP {status}): {}",
        parts.join("; ")
    )
}

/// The server address from the app config, or the default local one.
pub fn server_url(config: &Value) -> Result<String, ProviderError> {
    let url = config["comfyuiUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SERVER)
        .trim_end_matches('/')
        .to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(invalid(format!(
            "ComfyUI server address must start with http:// or https:// (got `{url}`) — fix it in Config → Providers"
        )));
    }
    Ok(url)
}

// ─── HTTP client ────────────────────────────────────────────────────────────

/// A submitted run — everything needed to collect it again after a restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub server: String,
    pub prompt_ids: Vec<String>,
    pub seeds: Vec<Option<u64>>,
    pub output: Option<String>,
    pub name: String,
}

#[derive(Clone)]
pub struct ComfyClient {
    http: reqwest::Client,
    base: String,
    poll_interval: Duration,
}

/// Removes queued prompts and interrupts a running one of ours if dropped
/// while armed — i.e. when the run is stopped before it finished.
struct CancelOnDrop {
    client: ComfyClient,
    ids: Vec<String>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.ids.is_empty() {
            return;
        }
        let client = self.client.clone();
        let ids = std::mem::take(&mut self.ids);
        tauri::async_runtime::spawn(async move { client.cancel(&ids).await });
    }
}

impl ComfyClient {
    pub fn new(base: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base,
            poll_interval: POLL_INTERVAL,
        }
    }

    fn unreachable(&self, e: reqwest::Error) -> String {
        if e.is_connect() {
            format!(
                "can't reach ComfyUI at {} — start ComfyUI, or set its address in Config → Providers",
                self.base
            )
        } else {
            format!("ComfyUI request failed: {e}")
        }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<(u16, String), String> {
        let res = req.send().await.map_err(|e| self.unreachable(e))?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    }

    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let (status, body) = self
            .send(self.http.get(format!("{}{path}", self.base)))
            .await?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "ComfyUI error (HTTP {status}) on {path}: {}",
                body.chars().take(300).collect::<String>()
            ));
        }
        serde_json::from_str(&body).map_err(|e| format!("ComfyUI returned invalid JSON: {e}"))
    }

    async fn media_bytes(&self, media: &MediaRef) -> Result<(Vec<u8>, String), String> {
        let path = &media.path;
        if path.starts_with("https://") || path.starts_with("http://") {
            let res = self
                .http
                .get(path)
                .send()
                .await
                .map_err(|e| format!("download of {path} failed: {e}"))?;
            if !res.status().is_success() {
                return Err(format!(
                    "download of {path} failed: HTTP {}",
                    res.status().as_u16()
                ));
            }
            let ext = path
                .split('?')
                .next()
                .and_then(|p| p.rsplit_once('.'))
                .map(|(_, e)| e.to_lowercase())
                .filter(|e| e.len() <= 5)
                .unwrap_or_else(|| "png".into());
            let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
            return Ok((bytes, ext));
        }
        let file = PathBuf::from(crate::utils::expand_tilde(path));
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|e| format!("cannot read {path}: {e}"))?;
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        Ok((bytes, ext))
    }

    /// Copy one input file into ComfyUI's input folder. Named by content hash,
    /// so the same file is stored once however often it is used.
    pub async fn upload(&self, media: &MediaRef) -> Result<String, String> {
        let (bytes, ext) = self.media_bytes(media).await?;
        let digest = Sha256::digest(&bytes);
        let hash: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        let filename = format!("beatboard-{hash}.{ext}");
        let boundary = format!("----beatboard{hash}");
        let mime = crate::media_mime(Path::new(&filename));
        let mut body = Vec::with_capacity(bytes.len() + 512);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&bytes);
        body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n"
            )
            .as_bytes(),
        );
        let (status, text) = self
            .send(
                self.http
                    .post(format!("{}/upload/image", self.base))
                    .header(
                        "Content-Type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(body),
            )
            .await?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "ComfyUI upload failed (HTTP {status}): {}",
                text.chars().take(300).collect::<String>()
            ));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| format!("ComfyUI upload returned invalid JSON: {e}"))?;
        let name = v["name"].as_str().ok_or("ComfyUI upload: no file name")?;
        Ok(match v["subfolder"].as_str().filter(|s| !s.is_empty()) {
            Some(sub) => format!("{sub}/{name}"),
            None => name.to_string(),
        })
    }

    /// Upload inputs and queue one prompt per seed.
    pub async fn submit(&self, plan: &Plan, progress: impl Fn(f64)) -> Result<Job, String> {
        progress(0.02);
        let mut uploaded = Vec::new();
        for (_, media) in &plan.uploads {
            uploaded.push(self.upload(media).await?);
        }
        progress(0.05);
        let mut guard = CancelOnDrop {
            client: self.clone(),
            ids: Vec::new(),
        };
        for seed in &plan.seeds {
            let graph = prompt_graph(plan, &uploaded, *seed);
            let (status, body) = self
                .send(
                    self.http
                        .post(format!("{}/prompt", self.base))
                        .json(&json!({ "prompt": graph, "client_id": CLIENT_ID })),
                )
                .await?;
            if !(200..300).contains(&status) {
                return Err(prompt_error(status, &body));
            }
            let v: Value = serde_json::from_str(&body)
                .map_err(|e| format!("ComfyUI returned invalid JSON: {e}"))?;
            let id = v["prompt_id"]
                .as_str()
                .ok_or("ComfyUI: no prompt_id")?
                .to_string();
            guard.ids.push(id);
        }
        Ok(Job {
            server: self.base.clone(),
            prompt_ids: std::mem::take(&mut guard.ids),
            seeds: plan.seeds.clone(),
            output: plan.bindings.output.clone(),
            name: plan.name.clone(),
        })
    }

    /// Remove queued prompts; interrupt whichever of them is running. Only
    /// interrupts when one of ours is running, so other people's work on a
    /// shared server is left alone.
    pub async fn cancel(&self, ids: &[String]) {
        let _ = self
            .http
            .post(format!("{}/queue", self.base))
            .json(&json!({ "delete": ids }))
            .send()
            .await;
        let Ok(queue) = self.get_json("/queue").await else {
            return;
        };
        let running: Vec<String> = queue["queue_running"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e[1].as_str().map(String::from))
            .collect();
        for id in ids.iter().filter(|id| running.contains(id)) {
            let _ = self
                .http
                .post(format!("{}/interrupt", self.base))
                .json(&json!({ "prompt_id": id }))
                .send()
                .await;
        }
    }

    /// Where a prompt is: finished (its history entry), or still queued.
    async fn poll(&self, id: &str) -> Result<Poll, String> {
        let history = self.get_json(&format!("/history/{id}")).await?;
        if let Some(entry) = history.get(id) {
            return Ok(Poll::Done(entry.clone()));
        }
        let queue = self.get_json("/queue").await?;
        let has = |key: &str| {
            queue[key]
                .as_array()
                .into_iter()
                .flatten()
                .any(|e| e[1] == id)
        };
        Ok(if has("queue_running") {
            Poll::Running
        } else if has("queue_pending") {
            Poll::Queued
        } else {
            Poll::Missing
        })
    }

    async fn download(&self, f: &OutputFile, dest: &Path) -> Result<(), String> {
        let url = view_url(&self.base, f);
        let res = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        if !res.status().is_success() {
            return Err(format!(
                "downloading {} from ComfyUI failed: HTTP {}",
                f.filename,
                res.status().as_u16()
            ));
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        tokio::fs::write(dest, &bytes)
            .await
            .map_err(|e| e.to_string())
    }

    /// Wait for every prompt of a job, then download their files into `dir`.
    /// Dropping this future (Stop) removes / interrupts the job's prompts.
    pub async fn wait(
        &self,
        job: &Job,
        dir: &Path,
        progress: impl Fn(f64),
    ) -> Result<(Value, Vec<Thumb>), String> {
        let mut guard = CancelOnDrop {
            client: self.clone(),
            ids: job.prompt_ids.clone(),
        };
        let total = job.prompt_ids.len().max(1) as f64;
        let mut finished = Vec::new();
        for (i, id) in job.prompt_ids.iter().enumerate() {
            let started = Instant::now();
            let mut running_since: Option<Instant> = None;
            let (mut missing, mut errors) = (0, 0);
            let entry = loop {
                if started.elapsed() > PROMPT_TIMEOUT {
                    return Err("ComfyUI run timed out after 60 minutes".into());
                }
                let frac = match self.poll(id).await {
                    Ok(Poll::Done(entry)) => break entry,
                    Ok(Poll::Missing) => {
                        missing += 1;
                        if missing >= MAX_MISSING_POLLS {
                            return Err(format!(
                                "ComfyUI at {} no longer has this run — was it restarted? Run the node again",
                                self.base
                            ));
                        }
                        0.0
                    }
                    Ok(Poll::Queued) => {
                        missing = 0;
                        0.0
                    }
                    Ok(Poll::Running) => {
                        missing = 0;
                        let since = *running_since.get_or_insert_with(Instant::now);
                        // Ease towards 0.9; per-step progress needs the websocket.
                        let t = since.elapsed().as_secs_f64();
                        0.9 * (1.0 - (-t / 30.0).exp())
                    }
                    Err(e) => {
                        errors += 1;
                        if errors >= MAX_POLL_ERRORS {
                            return Err(e);
                        }
                        0.0
                    }
                };
                progress(0.05 + 0.85 * (i as f64 + frac) / total);
                tokio::time::sleep(self.poll_interval).await;
            };
            guard.ids.retain(|x| x != id);
            finished.push(entry);
        }
        guard.ids.clear();

        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
        let mut thumbs = Vec::new();
        for (i, (id, entry)) in job.prompt_ids.iter().zip(&finished).enumerate() {
            let files = outcome(entry, job.output.as_deref())?;
            let seed = job.seeds.get(i).copied().flatten();
            for (j, f) in files.iter().enumerate() {
                let ext = f
                    .filename
                    .rsplit_once('.')
                    .map(|(_, e)| e.to_lowercase())
                    .unwrap_or_else(|| "png".into());
                let path = dir.join(format!("{id}-{j}.{ext}"));
                self.download(f, &path).await?;
                thumbs.push(Thumb {
                    seed: format!("{id}-{j}"),
                    label: match seed {
                        Some(s) => format!("{} · seed {s}", job.name),
                        None => job.name.clone(),
                    },
                    thumb_type: media_kind(&f.filename).to_string(),
                    chosen: thumbs.is_empty(),
                    url: None,
                    path: Some(path.to_string_lossy().into_owned()),
                    id: None,
                });
            }
        }
        progress(1.0);
        // Keep what's useful for debugging; the full history repeats the graph.
        let raw = json!({
            "server": job.server,
            "prompt_ids": job.prompt_ids,
            "seeds": job.seeds,
            "results": finished
                .iter()
                .map(|e| json!({ "status": e["status"], "outputs": e["outputs"] }))
                .collect::<Vec<_>>(),
        });
        Ok((raw, thumbs))
    }

    /// Submit, report the job (so it can be resumed after a restart), wait.
    pub async fn run(
        &self,
        plan: &Plan,
        dir: &Path,
        progress: impl Fn(f64),
        on_submitted: impl FnOnce(&Job),
    ) -> Result<(Value, Vec<Thumb>), String> {
        let job = self.submit(plan, &progress).await?;
        on_submitted(&job);
        self.wait(&job, dir, progress).await
    }
}

/// `/system_stats` of a server — the Config panel's connection test.
pub async fn system_stats(base: String) -> Result<Value, String> {
    ComfyClient::new(base).get_json("/system_stats").await
}

enum Poll {
    Done(Value),
    Running,
    Queued,
    Missing,
}

// ─── Provider ───────────────────────────────────────────────────────────────

pub struct ComfyUIProvider;

impl Provider for ComfyUIProvider {
    fn id(&self) -> &'static str {
        "comfyui"
    }

    /// The workflow lives on the node, outside params; pass it along as an
    /// internal provider param.
    fn build_request(&self, node: &Value, deps: &[Value]) -> Result<TaskRequest, ProviderError> {
        let mut req = inputs::task_request(node, deps)?;
        if let Some(wf) = node.get("workflow").filter(|w| !w.is_null()) {
            req.provider_params.insert("_workflow".into(), wf.clone());
        }
        Ok(req)
    }

    fn run<'a>(
        &'a self,
        req: TaskRequest,
        ctx: &'a RunCtx,
    ) -> BoxFuture<'a, Result<TaskOutput, ProviderError>> {
        Box::pin(async move {
            let plan = plan(&req, random_seed)?;
            let base = server_url(&ctx.config)?;
            let dir = runs_dir(&ctx.app)
                .map_err(ProviderError::Remote)?
                .join("comfyui");
            let (raw, thumbs) = ComfyClient::new(base)
                .run(
                    &plan,
                    &dir,
                    |p| ctx.progress(p),
                    |job| ctx.job(serde_json::to_value(job).unwrap_or_default()),
                )
                .await
                .map_err(ProviderError::Remote)?;
            Ok(TaskOutput {
                thumbs,
                raw,
                cost: None,
            })
        })
    }

    fn resume<'a>(
        &'a self,
        job: Value,
        ctx: &'a RunCtx,
    ) -> BoxFuture<'a, Result<TaskOutput, ProviderError>> {
        Box::pin(async move {
            let job: Job = serde_json::from_value(job)
                .map_err(|e| invalid(format!("not a ComfyUI job: {e}")))?;
            let dir = runs_dir(&ctx.app)
                .map_err(ProviderError::Remote)?
                .join("comfyui");
            let (raw, thumbs) = ComfyClient::new(job.server.clone())
                .wait(&job, &dir, |p| ctx.progress(p))
                .await
                .map_err(ProviderError::Remote)?;
            Ok(TaskOutput {
                thumbs,
                raw,
                cost: None,
            })
        })
    }

    fn preview(&self, req: &TaskRequest) -> Result<Vec<String>, ProviderError> {
        // A fixed stand-in seed: the preview must not change on every render.
        let plan = plan(req, || 0)?;
        let random = req.params.get("seed").is_none();
        let node = |id: &str| format!("#{id} {}", class_type(&plan.graph, id));
        let mut lines = vec![format!(
            "POST /prompt · {} ({} nodes)",
            plan.name,
            plan.graph.len()
        )];
        let b = &plan.bindings;
        for (t, role) in [(&b.prompt, "prompt"), (&b.negative, "negative prompt")] {
            if let Some(t) = t {
                let value = plan.graph[&t.node]["inputs"][&t.input]
                    .as_str()
                    .unwrap_or_default();
                lines.push(format!("{}.{} = {value}  ({role})", node(&t.node), t.input));
            }
        }
        for (t, media) in &plan.uploads {
            lines.push(format!(
                "{}.{} = upload {}",
                node(&t.node),
                t.input,
                media.path
            ));
        }
        for t in &b.seed {
            let value = if random {
                "random each run".to_string()
            } else {
                let seeds: Vec<String> = plan.seeds.iter().flatten().map(u64::to_string).collect();
                seeds.join(", ")
            };
            lines.push(format!("{}.{} = {value}", node(&t.node), t.input));
        }
        if plan.seeds.len() > 1 {
            lines.push(format!("queues {} prompts", plan.seeds.len()));
        }
        lines.push(match &b.output {
            Some(id) => format!("output: {}", node(id)),
            None => "output: every saved file".into(),
        });
        Ok(lines)
    }
}

#[cfg(test)]
mod tests;
