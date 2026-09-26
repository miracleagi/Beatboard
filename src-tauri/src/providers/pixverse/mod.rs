// PixVerse provider: runs generation through the Beatboard-managed PixVerse CLI.

pub mod args;
pub mod legacy;

use super::{BoxFuture, Provider, ProviderError, RunCtx, TaskOutput, TaskRequest};
use crate::runtime::resolve_pixverse;
use crate::storage::runs_dir;
use crate::thumbs::{
    collect_thumbs, infer_media_kind, parse_json_output, resolve_asset_thumbs, Thumb,
};
use serde_json::{json, Value};
use std::process::Stdio;
use tauri::AppHandle;

/// Key under `provider_params` holding an argv template that could not be
/// migrated to typed params; resolved with the legacy placeholder rules.
const RAW_ARGS: &str = "_raw_args";
/// Internal: the fully resolved argv for a raw-args node.
const RESOLVED_ARGS: &str = "_resolved_args";

pub struct PixVerseProvider;

impl Provider for PixVerseProvider {
    fn id(&self) -> &'static str {
        "pixverse"
    }

    fn build_request(&self, node: &Value, deps: &[Value]) -> Result<TaskRequest, ProviderError> {
        let mut req = super::inputs::task_request(node, deps)?;
        if let Some(raw) = req.provider_params.get(RAW_ARGS).cloned() {
            // Placeholders in a raw template resolve against deps by media
            // type, exactly as for the `cli` node it was migrated from.
            let legacy_node = json!({
                "kind": "cli",
                "cli": { "args": raw },
                "prompt": node.get("prompt").cloned().unwrap_or(Value::Null),
                "motionPrompt": node.get("motionPrompt").cloned().unwrap_or(Value::Null),
            });
            let resolved = legacy::resolve_pixverse_args(&legacy_node, deps)
                .map_err(ProviderError::InvalidParams)?;
            req.provider_params
                .insert(RESOLVED_ARGS.to_string(), json!(resolved));
        }
        Ok(req)
    }

    fn run<'a>(
        &'a self,
        req: TaskRequest,
        ctx: &'a RunCtx,
    ) -> BoxFuture<'a, Result<TaskOutput, ProviderError>> {
        Box::pin(async move {
            let args = match req.provider_params.get(RESOLVED_ARGS) {
                Some(resolved) => serde_json::from_value::<Vec<String>>(resolved.clone())
                    .map_err(|e| ProviderError::InvalidParams(e.to_string()))?,
                None => args::build_args(&req)?,
            };
            let (raw, thumbs) = exec(&ctx.app, &ctx.config, &args, |p| ctx.progress(p))
                .await
                .map_err(ProviderError::Remote)?;
            Ok(TaskOutput { thumbs, raw })
        })
    }
}

/// Run one `pixverse` invocation and collect its media into local files.
/// Returns the parsed JSON response and the resulting thumbs.
pub async fn exec(
    app: &AppHandle,
    config: &Value,
    args: &[String],
    progress: impl Fn(f64),
) -> Result<(Value, Vec<Thumb>), String> {
    let runtime = resolve_pixverse(app, config);
    let subcommand = args.get(1).map(String::as_str).unwrap_or("image");
    let default_mode = match subcommand {
        "voice" | "music" => "audio",
        "image" => "image",
        _ => "video",
    };

    progress(0.05);

    let output = runtime
        .command(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start PixVerse: {e}. Install the managed runtime from Beatboard Config."
            )
        })?
        .wait_with_output()
        .await
        .map_err(|e| e.to_string())?;

    progress(0.9);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed = parse_json_output(&stdout);
    // Templates can produce either an image or a video. Prefer the actual
    // response metadata/URL extension so Beatboard downloads and labels it using
    // the matching PixVerse asset type.
    let mode = if subcommand == "template" {
        infer_media_kind(parsed.as_ref()).unwrap_or(default_mode)
    } else {
        default_mode
    };
    let raw_thumbs = collect_thumbs(parsed.as_ref(), mode);

    let pv_dir = runs_dir(app)?.join("pixverse");
    std::fs::create_dir_all(&pv_dir).ok();
    let thumbs = resolve_asset_thumbs(&runtime, raw_thumbs, mode, &pv_dir).await;

    progress(1.0);
    Ok((parsed.unwrap_or(Value::Null), thumbs))
}

/// Execute a legacy `kind: "cli"` PixVerse node.
pub async fn run_legacy(node: Value, deps: Vec<Value>, ctx: RunCtx) -> Result<Value, String> {
    let args = legacy::resolve_pixverse_args(&node, &deps)?;
    let (parsed, thumbs) = exec(&ctx.app, &ctx.config, &args, |p| ctx.progress(p)).await?;
    Ok(json!({
        "ok": true,
        "pixverse": parsed,
        "thumbs": thumbs,
    }))
}

#[cfg(test)]
mod golden;
