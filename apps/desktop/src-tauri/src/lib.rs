//! The Tauri shell. It stays thin: each command forwards to `qs-service`,
//! which holds the logic and the tests.

mod commands;

/// Builds and runs the app until its last window closes.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Quicksilver failed to start: {err}");
            std::process::exit(1);
        });
}
