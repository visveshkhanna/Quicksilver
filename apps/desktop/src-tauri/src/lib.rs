//! The Tauri shell. It stays thin: each command forwards to `qs-service` or
//! `qs-store`, which hold the logic and the tests.

mod commands;
mod saved;

use std::sync::Arc;

use qs_store::{Channel, DataDir, Keychain, Store};
use tauri::Manager;

/// Builds and runs the app until its last window closes.
pub fn run() {
    tauri::Builder::default()
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
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::list_columns,
            saved::store_notices,
            saved::list_profiles,
            saved::create_profile,
            saved::update_profile,
            saved::delete_profile,
            saved::connect_profile,
            saved::refresh_catalog,
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
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Quicksilver failed to start: {err}");
            std::process::exit(1);
        });
}
