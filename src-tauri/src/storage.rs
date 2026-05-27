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
        .map(|d| d.join("atlas.v1.json"))
        .ok_or_else(|| "Cannot resolve app data dir".to_string())
}

pub fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .map(|d| d.join(".atlas-runs"))
        .ok_or_else(|| "Cannot resolve app data dir".to_string())
}
