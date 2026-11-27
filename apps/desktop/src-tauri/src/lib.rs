//! The Tauri shell. It stays thin: each command forwards to `qs-service` or
//! `qs-store`, which hold the logic and the tests.

mod commands;
mod import;
mod saved;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use qs_store::{Channel, DataDir, Keychain, Store};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Set once the UI has agreed to quit, so the exit it asks for goes through.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// When the last close or quit was asked for, in milliseconds since the epoch.
static ASKED_MS: AtomicU64 = AtomicU64::new(0);

/// Whether to ask the UI before closing. A second request within three
/// seconds goes through regardless, so a UI that cannot answer never traps
/// the window open.
fn ask_first() -> bool {
    if QUITTING.load(Ordering::SeqCst) {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let before = ASKED_MS.swap(now, Ordering::SeqCst);
    now.saturating_sub(before) > 3_000
}

/// Quits the app. The UI calls this once it has saved what it holds and the
/// user has agreed to lose unsaved row changes.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Builds and runs the app until its last window closes.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(qs_service::Service::new())
        .setup(|app| {
            let channel = Channel::current();
            let dir = DataDir::for_channel(&app.path().app_data_dir()?, channel);
            let store = Store::open(dir, Box::new(Keychain::new(channel.keychain_service())))?;
            for notice in store.notices() {
                tracing::warn!("{notice:?}");
            }
            app.manage(Arc::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::connect,
            commands::disconnect,
            commands::run,
            commands::cancel_run,
            commands::fetch_page,
            commands::result_info,
            commands::close_result,
            commands::sort_result,
            commands::copy_rows,
            commands::edit_target,
            commands::preview_edits,
            commands::apply_edits,
            commands::filter_query,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::list_columns,
            commands::list_foreign_keys,
            commands::explain,
            commands::object_ddl,
            commands::statement_at,
            saved::store_notices,
            saved::list_profiles,
            saved::create_profile,
            saved::update_profile,
            saved::delete_profile,
            saved::connect_profile,
            saved::refresh_catalog,
            saved::index_database,
            saved::catalog,
            saved::history,
            saved::clear_history,
            saved::saved_queries,
            saved::save_query,
            saved::delete_query,
            saved::buffers,
            saved::save_buffer,
            saved::delete_buffer,
            saved::get_layout,
            saved::set_layout,
            saved::test_connection,
            saved::parse_url,
            import::dbeaver_scan,
            import::dbeaver_import,
            quit_app,
        ])
        // Closing the window or quitting (Cmd+Q) asks the UI first: it saves
        // tab text still waiting and asks before unsaved row changes are lost,
        // then calls `quit_app`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && ask_first()
            {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Quicksilver failed to start: {err}");
            std::process::exit(1);
        })
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
                && !app.webview_windows().is_empty()
                && ask_first()
            {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
            }
        });
}
