// Provider API keys.
//
// Keys live in the macOS Keychain (service `com.beatboard.app`, account
// `provider:<id>`), never in project state or exported files, and are never
// handed back to the webview — the UI only learns whether a key is set.
// Other platforms (development and tests) use an in-process store instead.

use super::catalog;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SERVICE: &str = "com.beatboard.app";

fn account(provider: &str) -> String {
    format!("provider:{provider}")
}

/// Only providers whose manifest declares `"auth": "api-key"` take a key.
fn check_provider(provider: &str) -> Result<(), String> {
    match catalog::manifest(provider) {
        Some(m) if m["auth"] == "api-key" => Ok(()),
        Some(_) => Err(format!("{provider} does not use an API key")),
        None => Err(format!("unknown provider `{provider}`")),
    }
}

trait Store: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Keychain;

impl Store for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Keychain read failed: {e}")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|e| format!("Keychain write failed: {e}"))
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain delete failed: {e}")),
        }
    }
}

#[derive(Default)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
struct Memory(Mutex<HashMap<String, String>>);

impl Store for Memory {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

fn store() -> &'static dyn Store {
    #[cfg(target_os = "macos")]
    {
        static KEYCHAIN: Keychain = Keychain;
        &KEYCHAIN
    }
    #[cfg(not(target_os = "macos"))]
    {
        static MEMORY: std::sync::OnceLock<Memory> = std::sync::OnceLock::new();
        MEMORY.get_or_init(Memory::default)
    }
}

/// The stored key for a provider, if any.
pub fn get(provider: &str) -> Result<Option<String>, String> {
    check_provider(provider)?;
    store().get(&account(provider))
}

pub fn set(provider: &str, secret: &str) -> Result<(), String> {
    check_provider(provider)?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("the API key is empty".into());
    }
    store().set(&account(provider), secret)
}

pub fn clear(provider: &str) -> Result<(), String> {
    check_provider(provider)?;
    store().clear(&account(provider))
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn provider_secret_status(provider: String) -> Result<bool, String> {
    Ok(get(&provider)?.is_some())
}

#[tauri::command]
pub fn set_provider_secret(provider: String, secret: String) -> Result<(), String> {
    set(&provider, &secret)
}

#[tauri::command]
pub fn clear_provider_secret(provider: String) -> Result<(), String> {
    clear(&provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_clear_round_trip_and_trims() {
        set("fal", "  key-123 \n").unwrap();
        assert_eq!(get("fal").unwrap().as_deref(), Some("key-123"));
        assert!(provider_secret_status("fal".into()).unwrap());
        clear("fal").unwrap();
        assert_eq!(get("fal").unwrap(), None);
        clear("fal").unwrap(); // clearing twice is fine
    }

    #[test]
    fn rejects_providers_without_api_keys_and_empty_keys() {
        assert!(set("pixverse", "x").is_err());
        assert!(set("nope", "x").is_err());
        assert!(set("fal", "   ").is_err());
    }
}
