//! The Tauri shell. It stays thin: each command forwards to `qs-service` or
//! `qs-store`, which hold the logic and the tests.

mod commands;
mod import;
mod saved;

use std::sync::Arc;

use qs_store::{Channel, DataDir, Keychain, Store};
use tauri::Manager;

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
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Quicksilver failed to start: {err}");
            std::process::exit(1);
        });
}
