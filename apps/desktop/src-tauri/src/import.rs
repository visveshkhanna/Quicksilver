//! Commands for importing connections saved by other clients. Each forwards
//! to `qs-io`, which reads the files and saves profiles through `qs-store`.

use std::sync::Arc;

use qs_core::Error;
use qs_io::dbeaver;
use qs_store::Store;
use tauri::State;

type Result<T> = std::result::Result<T, Error>;

/// The connections saved in DBeaver on this machine, for the user to pick
/// from. It never includes a password.
#[tauri::command]
pub async fn dbeaver_scan(store: State<'_, Arc<Store>>) -> Result<dbeaver::Scan> {
    Ok(dbeaver::scan(
        &dbeaver::default_workspaces(),
        &store.profiles(),
    ))
}

/// Imports the DBeaver connections named by `keys` (from
/// [`dbeaver_scan`]), with their saved passwords when `passwords` is set.
/// The files are read again here, so passwords never pass through the UI.
#[tauri::command]
pub async fn dbeaver_import(
    store: State<'_, Arc<Store>>,
    keys: Vec<String>,
    passwords: bool,
) -> Result<dbeaver::Imported> {
    Ok(dbeaver::import(
        &store,
        &dbeaver::default_workspaces(),
        &keys,
        passwords,
    ))
}
