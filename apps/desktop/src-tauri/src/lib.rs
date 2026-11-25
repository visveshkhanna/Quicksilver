//! The Tauri shell. It stays thin: each command forwards to `qs-service`,
//! which holds the logic and the tests.

mod commands;

/// Builds and runs the app until its last window closes.
pub fn run() {
    tauri::Builder::default()
        .manage(qs_service::Service::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::connect,
            commands::disconnect,
            commands::run,
            commands::cancel_run,
            commands::fetch_page,
            commands::result_info,
            commands::close_result,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::list_columns,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Quicksilver failed to start: {err}");
            std::process::exit(1);
        });
}
