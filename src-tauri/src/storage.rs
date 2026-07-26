// Persistent storage: load/save the graph JSON to the app-data directory.

use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
pub async fn load_graph(app: AppHandle) -> Result<Option<String>, String> {
    let path = graph_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_graph(app: AppHandle, state: String) -> Result<(), String> {
    let path = graph_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, state).map_err(|e| e.to_string())
}

pub fn graph_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|d| d.join(GRAPH_FILE))
        .ok_or_else(|| "Cannot resolve app data dir".to_string())
}

pub fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|d| d.join(".beatboard-runs"))
        .ok_or_else(|| "Cannot resolve app data dir".to_string())
}

// ─── Migration from the pre-rename identity (Atlas → Beatboard) ──────────────

const GRAPH_FILE: &str = "beatboard.v1.json";
const LEGACY_APP_DIR: &str = "com.atlas.pipeline";
const LEGACY_GRAPH_FILE: &str = "atlas.v1.json";

/// Carry saved projects and the managed runtime across the bundle-identifier
/// rename (`com.atlas.pipeline` → `com.beatboard.app`).
///
/// Tauri derives `app_data_dir()` from the bundle identifier, so the renamed
/// app starts against a fresh, empty directory: projects would look lost and
/// the ~300 MB managed runtime would need re-downloading. Both are recovered
/// on first launch; each step is independent so a partial migration resumes.
///
/// Generated media is deliberately left alone. The graph stores absolute paths
/// into the old `.atlas-runs` directory, which stays readable (it lives under
/// $HOME, which the media protocol allows), so existing previews keep working
/// while new runs write to `.beatboard-runs`.
pub fn migrate_legacy_app_data(app: &AppHandle) {
    let Ok(target) = graph_path(app) else { return };
    let Some(data_dir) = target.parent().map(|p| p.to_path_buf()) else { return };
    let Some(legacy_dir) = data_dir.parent().map(|p| p.join(LEGACY_APP_DIR)) else { return };

    // ── Saved projects: copy, so the legacy install stays intact ──
    if !target.exists() {
        // Prefer a same-directory legacy file (identifier kept, file renamed).
        let sibling = data_dir.join(LEGACY_GRAPH_FILE);
        let source = if sibling.exists() { sibling } else { legacy_dir.join(LEGACY_GRAPH_FILE) };
        if source.exists() {
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                eprintln!("[migrate] cannot create {}: {e}", data_dir.display());
                return;
            }
            match std::fs::copy(&source, &target) {
                Ok(_) => println!("[migrate] imported saved projects from {}", source.display()),
                Err(e) => eprintln!("[migrate] could not import {}: {e}", source.display()),
            }
        }
    }

    // ── Managed runtime: move, since it is a rebuildable cache and large ──
    let runtime_target = data_dir.join("runtime");
    let runtime_source = legacy_dir.join("runtime");
    if !runtime_target.exists() && runtime_source.is_dir() {
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            eprintln!("[migrate] cannot create {}: {e}", data_dir.display());
            return;
        }
        match std::fs::rename(&runtime_source, &runtime_target) {
            Ok(_) => println!("[migrate] moved managed runtime from {}", runtime_source.display()),
            // Cross-volume or permission failure: leave it, the user can
            // reinstall the runtime from Config.
            Err(e) => eprintln!("[migrate] could not move managed runtime: {e}"),
        }
    }
}
