// fal.ai provider: runs models through fal's queue API.
//
// Protocol (per fal's official client, github.com/fal-ai/fal-js):
//   POST https://queue.fal.run/{endpoint}             → { request_id, status_url, response_url, cancel_url }
//   GET  {status_url}                                  → { status: IN_QUEUE | IN_PROGRESS | COMPLETED, … }
//   GET  {response_url}                                → model output JSON, or an error status once COMPLETED
//   PUT  {cancel_url}                                  → cancel a queued / running request
//   POST https://rest.fal.ai/storage/upload/initiate   → { upload_url, file_url }, then PUT the bytes to upload_url
// All calls send `Authorization: Key <key>`.
//
// Which endpoint a model uses (text-only vs. with a reference image), how
// Beatboard params map to its input fields, and where its output lives are
// data in src/providers/fal.json (`endpoints`).

use super::{
    catalog, secrets, BoxFuture, MediaRef, Provider, ProviderError, RunCtx, TaskOutput, TaskRequest,
};
use crate::storage::runs_dir;
use crate::thumbs::Thumb;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const QUEUE_BASE: &str = "https://queue.fal.run";
const REST_BASE: &str = "https://rest.fal.ai";
/// fal's client switches to multipart uploads above this size.
const MAX_SINGLE_UPLOAD: u64 = 90 * 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_STATUS_ERRORS: u32 = 5;

// ─── Request planning (pure) ────────────────────────────────────────────────

/// What to send: the endpoint, the JSON body without its image inputs, and
/// the images to upload into `image_field`.
#[derive(Debug)]
pub struct Plan {
    pub endpoint: String,
    pub body: Map<String, Value>,
    pub image_field: Option<String>,
    pub images: Vec<MediaRef>,
    /// `images` (array of { url }) or `video` ({ url }).
    pub output: String,
    pub model: String,
}

fn invalid(msg: impl Into<String>) -> ProviderError {
    ProviderError::InvalidParams(msg.into())
}

fn model_label(model: &str) -> String {
    catalog::manifest("fal")
        .and_then(|m| m["models"][model].as_str())
        .unwrap_or(model)
        .to_string()
}

/// Input slot carrying reference images for each capability.
fn image_slot(capability: &str) -> &'static str {
    match capability {
        "video.generate" => "image",
        _ => "images",
    }
}

fn text(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}

/// Convert one Beatboard param into a fal input value per its field spec.
fn field_value(key: &str, value: &Value, field: &Value) -> Result<Value, ProviderError> {
    if let Some(map) = field.get("map").and_then(|m| m.as_object()) {
        return map.get(&text(value)).cloned().ok_or_else(|| {
            invalid(format!(
                "`{key}` = {} is not supported by this model",
                text(value)
            ))
        });
    }
    if let Some(format) = field.get("format").and_then(|f| f.as_str()) {
        return Ok(Value::String(format.replace("{}", &text(value))));
    }
    Ok(value.clone())
}

pub fn plan(req: &TaskRequest) -> Result<Plan, ProviderError> {
    let model = req
        .model
        .clone()
        .ok_or_else(|| invalid("choose a fal.ai model"))?;
    let spec = catalog::manifest("fal")
        .and_then(|m| m["endpoints"].get(&model))
        .ok_or_else(|| invalid(format!("fal.ai has no model `{model}`")))?;

    let images: Vec<MediaRef> = req
        .inputs
        .get(image_slot(&req.capability))
        .into_iter()
        .flatten()
        .filter(|r| !r.path.is_empty() || r.cloud_ids.contains_key("fal"))
        .cloned()
        .collect();
    let variant = if images.is_empty() { "text" } else { "image" };
    let endpoint = spec[variant].as_str().ok_or_else(|| {
        invalid(format!(
            "{} can't use a reference image — disconnect it or pick another model",
            model_label(&model)
        ))
    })?;
    if req.prompt.trim().is_empty() {
        return Err(invalid(format!("{} needs a prompt", model_label(&model))));
    }

    let mut body = Map::new();
    body.insert("prompt".into(), Value::String(req.prompt.clone()));
    for (key, value) in req.params.iter().chain(req.provider_params.iter()) {
        if key.starts_with('_') || value.is_null() {
            continue;
        }
        let field = spec["fields"].get(key).ok_or_else(|| {
            invalid(format!(
                "fal.ai manifest has no field for `{key}` on {model}"
            ))
        })?;
        if field
            .get("only")
            .and_then(|o| o.as_str())
            .is_some_and(|only| only != variant)
        {
            continue; // e.g. aspect ratio follows the source image in image-to-video
        }
        let to = field["to"].as_str().unwrap_or(key);
        body.insert(to.to_string(), field_value(key, value, field)?);
    }

    Ok(Plan {
        endpoint: endpoint.to_string(),
        body,
        image_field: (variant == "image").then(|| {
            spec["image_field"]
                .as_str()
                .unwrap_or("image_url")
                .to_string()
        }),
        images,
        output: spec["output"].as_str().unwrap_or("images").to_string(),
        model,
    })
}

/// The request body with uploaded image URLs filled in. Fields ending in
/// `_urls` take every image; others take the first.
pub fn body_with_images(plan: &Plan, urls: &[String]) -> Map<String, Value> {
    let mut body = plan.body.clone();
    if let (Some(field), Some(first)) = (&plan.image_field, urls.first()) {
        let value = if field.ends_with("_urls") {
            json!(urls)
        } else {
            json!(first)
        };
        body.insert(field.clone(), value);
    }
    body
}

/// Media URLs (and content types) in a model's output.
pub fn output_media(output: &Value, kind: &str) -> Vec<(String, Option<String>)> {
    let item = |v: &Value| {
        let url = v.get("url")?.as_str()?.to_string();
        Some((
            url,
            v.get("content_type")
                .and_then(|c| c.as_str())
                .map(String::from),
        ))
    };
    match kind {
        "video" => output.get("video").and_then(item).into_iter().collect(),
        _ => output
            .get("images")
            .and_then(|i| i.as_array())
            .into_iter()
            .flatten()
            .filter_map(item)
            .collect(),
    }
}

// ─── HTTP client ────────────────────────────────────────────────────────────

/// Readable message for a failed fal call, including 422 field errors.
fn api_error(status: u16, body: &str) -> String {
    if status == 401 || status == 403 {
        return format!(
            "fal.ai rejected the API key (HTTP {status}) — update it in Config → Providers"
        );
    }
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let detail = match parsed.get("detail") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|d| {
                let loc: Vec<String> = d["loc"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(text)
                    .filter(|l| l != "body")
                    .collect();
                let msg = d["msg"].as_str().unwrap_or("invalid");
                if loc.is_empty() {
                    msg.to_string()
                } else {
                    format!("{}: {msg}", loc.join("."))
                }
            })
            .collect::<Vec<_>>()
            .join("; "),
        Some(Value::String(s)) => s.clone(),
        _ => parsed
            .get("message")
            .or_else(|| parsed.get("error"))
            .and_then(|m| m.as_str())
            .map(String::from)
            .unwrap_or_else(|| body.chars().take(300).collect()),
    };
    format!("fal.ai error (HTTP {status}): {detail}")
}

#[derive(Clone)]
pub struct FalClient {
    http: reqwest::Client,
    key: String,
    queue_base: String,
    rest_base: String,
    poll_interval: Duration,
}

/// Sends `PUT cancel_url` if dropped while armed — i.e. when the run is
/// cancelled (its future dropped) before the request finished.
struct CancelOnDrop {
    client: FalClient,
    url: Option<String>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(url) = self.url.take() {
            let client = self.client.clone();
            tauri::async_runtime::spawn(async move {
                let _ = client
                    .http
                    .put(&url)
                    .header("Authorization", client.auth())
                    .send()
                    .await;
            });
        }
    }
}

fn mime_for(path: &Path) -> &'static str {
    crate::media_mime(path)
}

fn extension_for(url: &str, content_type: Option<&str>, kind: &str) -> String {
    let from_url = url
        .split('?')
        .next()
        .and_then(|u| u.rsplit('/').next())
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_lowercase())
        .filter(|ext| ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()));
    let from_type = content_type.and_then(|t| t.split('/').nth(1)).map(|t| {
        t.split(';')
            .next()
            .unwrap_or(t)
            .replace("jpeg", "jpg")
            .replace("quicktime", "mov")
    });
    from_url.or(from_type).unwrap_or_else(|| {
        if kind == "video" {
            "mp4".into()
        } else {
            "png".into()
        }
    })
}

impl FalClient {
    pub fn new(key: String) -> Self {
        Self::with_bases(key, QUEUE_BASE.into(), REST_BASE.into())
    }

    pub fn with_bases(key: String, queue_base: String, rest_base: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            http,
            key,
            queue_base,
            rest_base,
            poll_interval: POLL_INTERVAL,
        }
    }

    fn auth(&self) -> String {
        format!("Key {}", self.key)
    }

    async fn json(&self, req: reqwest::RequestBuilder) -> Result<Value, String> {
        let res = req
            .header("Authorization", self.auth())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("fal.ai request failed: {e}"))?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !(200..300).contains(&status) {
            return Err(api_error(status, &body));
        }
        serde_json::from_str(&body).map_err(|e| format!("fal.ai returned invalid JSON: {e}"))
    }

    /// A URL fal can fetch for this media: remote URLs pass through, local
    /// files are uploaded to fal storage.
    pub async fn media_url(&self, media: &MediaRef) -> Result<String, String> {
        if let Some(url) = media.cloud_ids.get("fal") {
            return Ok(url.clone());
        }
        let path = &media.path;
        if path.starts_with("https://") || path.starts_with("http://") {
            return Ok(path.clone());
        }
        let file = PathBuf::from(crate::utils::expand_tilde(path));
        let size = tokio::fs::metadata(&file)
            .await
            .map_err(|e| format!("cannot read {path}: {e}"))?
            .len();
        if size > MAX_SINGLE_UPLOAD {
            return Err(format!(
                "{path} is {} MB; uploads to fal.ai are limited to 90 MB here",
                size / (1024 * 1024)
            ));
        }
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|e| format!("cannot read {path}: {e}"))?;
        let content_type = mime_for(&file);
        let file_name = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload")
            .to_string();
        let initiated = self
            .json(
                self.http
                    .post(format!(
                        "{}/storage/upload/initiate?storage_type=fal-cdn-v3",
                        self.rest_base
                    ))
                    .json(&json!({ "content_type": content_type, "file_name": file_name })),
            )
            .await?;
        let upload_url = initiated["upload_url"]
            .as_str()
            .ok_or("fal.ai upload: no upload_url")?;
        let file_url = initiated["file_url"]
            .as_str()
            .ok_or("fal.ai upload: no file_url")?;
        let res = self
            .http
            .put(upload_url)
            .header("Content-Type", content_type)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("fal.ai upload failed: {e}"))?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            return Err(api_error(status, &res.text().await.unwrap_or_default()));
        }
        Ok(file_url.to_string())
    }

    /// Upload inputs and submit the request to the queue.
    pub async fn submit(&self, plan: &Plan, progress: impl Fn(f64)) -> Result<Job, String> {
        progress(0.02);
        let mut urls = Vec::new();
        for media in &plan.images {
            urls.push(self.media_url(media).await?);
        }
        let body = body_with_images(plan, &urls);

        progress(0.05);
        let submitted = self
            .json(
                self.http
                    .post(format!("{}/{}", self.queue_base, plan.endpoint))
                    .json(&body),
            )
            .await?;
        let request_id = submitted["request_id"]
            .as_str()
            .ok_or("fal.ai: no request_id")?
            .to_string();
        // Build fallbacks from the app id (owner/alias) as fal's client does.
        let app: Vec<&str> = plan.endpoint.split('/').take(2).collect();
        let base = format!(
            "{}/{}/requests/{request_id}",
            self.queue_base,
            app.join("/")
        );
        let url = |key: &str, fallback: String| {
            submitted[key]
                .as_str()
                .map(String::from)
                .unwrap_or(fallback)
        };
        Ok(Job {
            status_url: url("status_url", format!("{base}/status")),
            response_url: url("response_url", base.clone()),
            cancel_url: url("cancel_url", format!("{base}/cancel")),
            request_id,
            output: plan.output.clone(),
            model: plan.model.clone(),
        })
    }

    /// Poll a submitted request until it finishes, then download its media
    /// into `dir`. Dropping this future (Stop) cancels the request on fal.
    pub async fn wait(
        &self,
        job: &Job,
        dir: &Path,
        progress: impl Fn(f64),
    ) -> Result<(Value, Vec<Thumb>), String> {
        let mut guard = CancelOnDrop {
            client: self.clone(),
            url: Some(job.cancel_url.clone()),
        };

        let started = Instant::now();
        let mut running_since: Option<Instant> = None;
        let mut errors = 0;
        loop {
            if started.elapsed() > RUN_TIMEOUT {
                return Err("fal.ai request timed out after 30 minutes".into());
            }
            match self.json(self.http.get(&job.status_url)).await {
                Ok(status) => {
                    errors = 0;
                    match status["status"].as_str() {
                        Some("COMPLETED") => break,
                        Some("IN_PROGRESS") => {
                            let since = *running_since.get_or_insert_with(Instant::now);
                            // Ease towards 0.85; fal reports no percentage.
                            let t = since.elapsed().as_secs_f64();
                            progress(0.2 + 0.65 * (1.0 - (-t / 60.0).exp()));
                        }
                        _ => progress(0.1),
                    }
                }
                // A 4xx (bad key, unknown request) will not fix itself.
                Err(e) if e.contains("(HTTP 4") => return Err(e),
                Err(e) => {
                    errors += 1;
                    if errors >= MAX_STATUS_ERRORS {
                        return Err(e);
                    }
                }
            }
            tokio::time::sleep(self.poll_interval).await;
        }

        // COMPLETED also covers failures: the result call reports them.
        let output = self.json(self.http.get(&job.response_url)).await;
        guard.url = None; // finished: nothing to cancel any more
        let output = output?;
        progress(0.9);

        let media = output_media(&output, &job.output);
        if media.is_empty() {
            return Err(format!(
                "{} returned no {}",
                model_label(&job.model),
                job.output
            ));
        }
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
        let kind = if job.output == "video" {
            "video"
        } else {
            "image"
        };
        let mut thumbs = Vec::new();
        for (i, (url, content_type)) in media.iter().enumerate() {
            let ext = extension_for(url, content_type.as_deref(), kind);
            let path = dir.join(format!("{}-{i}.{ext}", job.request_id));
            let res = self
                .http
                .get(url)
                .send()
                .await
                .map_err(|e| format!("download failed: {e}"))?;
            if !res.status().is_success() {
                return Err(format!(
                    "download of {url} failed: HTTP {}",
                    res.status().as_u16()
                ));
            }
            let bytes = res
                .bytes()
                .await
                .map_err(|e| format!("download failed: {e}"))?;
            tokio::fs::write(&path, &bytes)
                .await
                .map_err(|e| e.to_string())?;
            thumbs.push(Thumb {
                seed: url.clone(),
                label: model_label(&job.model),
                thumb_type: kind.to_string(),
                chosen: i == 0,
                url: Some(url.clone()),
                path: Some(path.to_string_lossy().into_owned()),
                id: None,
            });
        }
        progress(1.0);
        Ok((output, thumbs))
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

/// A submitted fal request — everything needed to pick it up again.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Job {
    pub request_id: String,
    pub status_url: String,
    pub response_url: String,
    pub cancel_url: String,
    /// `images` or `video`.
    pub output: String,
    pub model: String,
}

// ─── Provider ───────────────────────────────────────────────────────────────

pub struct FalProvider;

impl Provider for FalProvider {
    fn id(&self) -> &'static str {
        "fal"
    }

    fn run<'a>(
        &'a self,
        req: TaskRequest,
        ctx: &'a RunCtx,
    ) -> BoxFuture<'a, Result<TaskOutput, ProviderError>> {
        Box::pin(async move {
            let plan = plan(&req)?;
            let key = secrets::get("fal")
                .map_err(ProviderError::Remote)?
                .ok_or_else(|| {
                    invalid("Add your fal.ai API key in Config → Providers to run this node")
                })?;
            let dir = runs_dir(&ctx.app)
                .map_err(ProviderError::Remote)?
                .join("fal");
            let (raw, thumbs) = FalClient::new(key)
                .run(
                    &plan,
                    &dir,
                    |p| ctx.progress(p),
                    |job| ctx.job(serde_json::to_value(job).unwrap_or_default()),
                )
                .await
                .map_err(ProviderError::Remote)?;
            // fal's result carries no price; the account's usage page has it.
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
                .map_err(|e| invalid(format!("not a fal.ai job: {e}")))?;
            let key = secrets::get("fal")
                .map_err(ProviderError::Remote)?
                .ok_or_else(|| {
                    invalid("Add your fal.ai API key in Config → Providers to resume this node")
                })?;
            let dir = runs_dir(&ctx.app)
                .map_err(ProviderError::Remote)?
                .join("fal");
            let (raw, thumbs) = FalClient::new(key)
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
        let plan = plan(req)?;
        let urls: Vec<String> = plan.images.iter().map(|m| m.path.clone()).collect();
        let body = body_with_images(&plan, &urls);
        let mut lines = vec![format!("POST {QUEUE_BASE}/{}", plan.endpoint)];
        lines.extend(body.iter().map(|(k, v)| format!("{k}: {v}")));
        Ok(lines)
    }
}

#[cfg(test)]
mod tests;
