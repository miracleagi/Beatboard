// Beatboard-managed tool runtimes.
//
// Resolution order is deliberately consistent for every caller:
//   explicit user override -> Beatboard-managed/bundled runtime -> system PATH.
// ffmpeg is shipped beside the Beatboard executable. PixVerse is installed into
// the app-data directory so it can be updated without replacing Beatboard.app.

use crate::utils::{expand_tilde, find_bin, npm_augmented_path};
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;
use tokio::process::Command;

const NODE_VERSION: &str = "24.18.0";
const PIXVERSE_VERSION: &str = "1.2.10";

#[cfg(target_arch = "aarch64")]
const NODE_ARCHIVE: &str = "node-v24.18.0-darwin-arm64.tar.gz";
#[cfg(target_arch = "aarch64")]
const NODE_SHA256: &str = "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1";

#[cfg(target_arch = "x86_64")]
const NODE_ARCHIVE: &str = "node-v24.18.0-darwin-x64.tar.gz";
#[cfg(target_arch = "x86_64")]
const NODE_SHA256: &str = "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080";

#[derive(Clone, Debug)]
pub struct RuntimeCommand {
    pub program: String,
    pub prefix_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub source: String,
}

impl RuntimeCommand {
    pub fn new(program: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            prefix_args: Vec::new(),
            env: Vec::new(),
            source: source.into(),
        }
    }

    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = Command::new(&self.program);
        command
            .env("PATH", npm_augmented_path())
            .envs(self.env.iter().cloned())
            .args(&self.prefix_args)
            .args(args);
        command
    }

    fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.prefix_args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Serialize)]
pub struct ToolStatus {
    available: bool,
    source: String,
    command: String,
    version: String,
}

#[derive(Serialize)]
pub struct RuntimeStatus {
    ffmpeg: ToolStatus,
    pixverse: ToolStatus,
    pixverse_managed_version: String,
    node_managed_version: String,
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|path| path.join("runtime"))
        .ok_or_else(|| "Cannot resolve Beatboard app-data directory".to_string())
}

fn configured_override(config: &Value, key: &str) -> Option<String> {
    let value = config
        .get("binPaths")
        .and_then(|paths| paths.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() || value == key {
        None
    } else {
        Some(find_bin(&expand_tilde(value)))
    }
}

fn bundled_binary(name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    #[cfg(target_arch = "aarch64")]
    candidates.push(
        manifest
            .join("binaries")
            .join(format!("{name}-aarch64-apple-darwin")),
    );
    #[cfg(target_arch = "x86_64")]
    candidates.push(
        manifest
            .join("binaries")
            .join(format!("{name}-x86_64-apple-darwin")),
    );

    candidates.into_iter().find(|path| path.is_file())
}

fn managed_node_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(format!("node-v{NODE_VERSION}")))
}

fn managed_pixverse_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(format!("pixverse-{PIXVERSE_VERSION}")))
}

fn managed_pixverse_command(app: &AppHandle) -> Option<RuntimeCommand> {
    let node = managed_node_dir(app).ok()?.join("bin/node");
    let entry = managed_pixverse_dir(app)
        .ok()?
        .join("node_modules/pixverse/dist/index.js");
    if !node.is_file() || !entry.is_file() {
        return None;
    }
    Some(RuntimeCommand {
        program: node.to_string_lossy().into_owned(),
        prefix_args: vec![entry.to_string_lossy().into_owned()],
        env: vec![(
            "HOME".to_string(),
            runtime_root(app)
                .ok()?
                .join("home")
                .to_string_lossy()
                .into_owned(),
        )],
        source: "managed".to_string(),
    })
}

pub fn resolve_ffmpeg(_app: &AppHandle, config: &Value) -> RuntimeCommand {
    if let Some(program) = configured_override(config, "ffmpeg") {
        return RuntimeCommand::new(program, "custom");
    }
    if let Some(program) = bundled_binary("ffmpeg") {
        return RuntimeCommand::new(program.to_string_lossy(), "bundled");
    }
    RuntimeCommand::new(find_bin("ffmpeg"), "system")
}

pub fn resolve_pixverse(app: &AppHandle, config: &Value) -> RuntimeCommand {
    if let Some(program) = configured_override(config, "pixverse") {
        return RuntimeCommand::new(program, "custom");
    }
    if let Some(command) = managed_pixverse_command(app) {
        return command;
    }
    RuntimeCommand::new(find_bin("pixverse"), "system")
}

async fn inspect_tool(command: RuntimeCommand, args: &[&str]) -> ToolStatus {
    let display = command.display();
    match command
        .command(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            ToolStatus {
                available: true,
                source: command.source,
                command: display,
                version: stdout
                    .lines()
                    .next()
                    .unwrap_or_else(|| stderr.lines().next().unwrap_or("ready"))
                    .to_string(),
            }
        }
        Ok(output) => ToolStatus {
            available: false,
            source: command.source,
            command: display,
            version: String::from_utf8_lossy(&output.stderr)
                .lines()
                .next()
                .unwrap_or("unavailable")
                .to_string(),
        },
        Err(error) => ToolStatus {
            available: false,
            source: command.source,
            command: display,
            version: error.to_string(),
        },
    }
}

#[tauri::command]
pub async fn runtime_status(app: AppHandle, config: Value) -> Result<RuntimeStatus, String> {
    let ffmpeg = inspect_tool(resolve_ffmpeg(&app, &config), &["-version"]).await;
    let pixverse = inspect_tool(resolve_pixverse(&app, &config), &["--version"]).await;
    Ok(RuntimeStatus {
        ffmpeg,
        pixverse,
        pixverse_managed_version: PIXVERSE_VERSION.to_string(),
        node_managed_version: NODE_VERSION.to_string(),
    })
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Node.js archive checksum mismatch: expected {expected}, got {actual}"
        ))
    }
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir(&src, &dest)?;
        } else {
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn pixverse_package_template(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path_resolver()
        .resource_dir()
        .map(|path| path.join("runtime/pixverse-package"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/pixverse-package");
    [packaged, Some(development)]
        .into_iter()
        .flatten()
        .find(|path| path.join("package-lock.json").is_file())
        .ok_or_else(|| "Beatboard PixVerse package manifest is missing".to_string())
}

#[tauri::command]
pub async fn install_pixverse_runtime(app: AppHandle, force: bool) -> Result<Value, String> {
    if !force && managed_pixverse_command(&app).is_some() {
        return Ok(serde_json::json!({ "ok": true, "already_installed": true }));
    }

    let root = runtime_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let node_dir = managed_node_dir(&app)?;

    if !node_dir.join("bin/node").is_file() {
        let url = format!("https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}");
        let archive_bytes = reqwest::get(&url)
            .await
            .map_err(|e| format!("Failed to download managed Node.js: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Failed to download managed Node.js: {e}"))?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;
        verify_sha256(&archive_bytes, NODE_SHA256)?;

        let extract_dir = root.join(".node-installing");
        remove_if_exists(&extract_dir)?;
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
        let decoder = GzDecoder::new(archive_bytes.as_ref());
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&extract_dir)
            .map_err(|e| format!("Cannot extract Node.js: {e}"))?;
        let extracted = extract_dir.join(NODE_ARCHIVE.trim_end_matches(".tar.gz"));
        remove_if_exists(&node_dir)?;
        std::fs::rename(&extracted, &node_dir)
            .map_err(|e| format!("Cannot install Node.js: {e}"))?;
        remove_if_exists(&extract_dir)?;
    }

    let template = pixverse_package_template(&app)?;
    let destination = managed_pixverse_dir(&app)?;
    let staging = root.join(".pixverse-installing");
    remove_if_exists(&staging)?;
    copy_dir(&template, &staging)?;

    let node = node_dir.join("bin/node");
    let npm_cli = node_dir.join("lib/node_modules/npm/bin/npm-cli.js");
    let npm_cache = root.join("npm-cache");
    let output = Command::new(&node)
        .arg(&npm_cli)
        .args([
            "ci",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(&staging)
        .env("npm_config_cache", &npm_cache)
        .env(
            "PATH",
            format!(
                "{}:{}",
                node_dir.join("bin").display(),
                npm_augmented_path()
            ),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to start managed npm: {e}"))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        remove_if_exists(&staging)?;
        return Err(format!("Failed to install PixVerse runtime: {error}"));
    }

    remove_if_exists(&destination)?;
    std::fs::rename(&staging, &destination)
        .map_err(|e| format!("Cannot activate PixVerse runtime: {e}"))?;
    Ok(serde_json::json!({
        "ok": true,
        "pixverse_version": PIXVERSE_VERSION,
        "node_version": NODE_VERSION,
    }))
}

#[tauri::command]
pub async fn pixverse_auth_login(app: AppHandle, config: Value) -> Result<Value, String> {
    let command = resolve_pixverse(&app, &config);
    let output = command
        .command(["auth", "login"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to start PixVerse login: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(serde_json::json!({
        "ok": true,
        "message": String::from_utf8_lossy(&output.stdout).trim(),
    }))
}
