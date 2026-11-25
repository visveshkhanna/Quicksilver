//! Commands the UI can invoke.

/// The app's name, version and known engines.
#[tauri::command]
pub fn app_info() -> qs_service::AppInfo {
    qs_service::app_info()
}
