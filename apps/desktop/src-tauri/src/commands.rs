//! Commands the UI can invoke. Each one forwards to `qs-service`; none holds
//! logic of its own.
//!
//! Every command is `async`, so it runs on Tauri's tokio runtime rather than
//! the main thread: the service spawns tasks and the SQLite driver blocks a
//! worker, and neither may happen on the thread that draws the window.

use std::sync::Arc;

use qs_core::{ConnectionConfig, Error};
use qs_service::saved::HistoryRecorder;
use qs_service::{
    AppInfo, ColumnInfo, DbObject, ExecuteOptions, ResultId, ResultInfo, RunEvent, RunId, Service,
    SessionId, SessionInfo,
};
use qs_store::Store;
use tauri::State;
use tauri::ipc::{Channel, Response};

type Result<T> = std::result::Result<T, Error>;

/// The app's name, version and known engines.
#[tauri::command]
pub fn app_info() -> AppInfo {
    qs_service::app_info()
}

/// Opens a session from a connection URL. A `password` given separately
/// replaces any in the URL, so it never has to be typed into one.
#[tauri::command]
pub async fn connect(
    service: State<'_, Service>,
    url: String,
    password: Option<String>,
) -> Result<SessionInfo> {
    let mut config = ConnectionConfig::from_url(&url)?;
    if password.is_some() {
        config.password = password;
    }
    service.connect(&config).await
}

/// Closes a session.
#[tauri::command]
pub async fn disconnect(service: State<'_, Service>, session: SessionId) -> Result<()> {
    service.disconnect(session);
    Ok(())
}

/// Starts running a script and returns its id. Events arrive on `on_event`.
/// The run is added to history, under `profile_id` and `database` when the
/// tab has them.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    session: SessionId,
    script: String,
    row_cap: Option<u64>,
    profile_id: Option<String>,
    database: Option<String>,
    on_event: Channel<RunEvent>,
) -> Result<RunId> {
    let history = HistoryRecorder::new(Arc::clone(&store), profile_id, database, script.clone());
    service.start_run(session, script, ExecuteOptions { row_cap }, move |event| {
        history.observe(&event);
        if let Err(err) = on_event.send(event) {
            tracing::warn!("a run event could not be delivered: {err}");
        }
    })
}

/// Cancels a run.
#[tauri::command]
pub async fn cancel_run(service: State<'_, Service>, run: RunId) -> Result<()> {
    service.cancel(run);
    Ok(())
}

/// A page of rows, as raw bytes the UI decodes (`src/ipc/page.ts`).
#[tauri::command]
pub async fn fetch_page(
    service: State<'_, Service>,
    result: ResultId,
    offset: u64,
    count: u32,
) -> Result<Response> {
    service.page(result, offset, count).map(Response::new)
}

/// A result's columns, row count and size.
#[tauri::command]
pub async fn result_info(service: State<'_, Service>, result: ResultId) -> Result<ResultInfo> {
    service.result_info(result)
}

/// Frees a result.
#[tauri::command]
pub async fn close_result(service: State<'_, Service>, result: ResultId) -> Result<()> {
    service.close_result(result);
    Ok(())
}

/// The databases on a session's server.
#[tauri::command]
pub async fn list_databases(
    service: State<'_, Service>,
    session: SessionId,
) -> Result<Vec<String>> {
    service.databases(session).await
}

/// The schemas in a session's database.
#[tauri::command]
pub async fn list_schemas(service: State<'_, Service>, session: SessionId) -> Result<Vec<String>> {
    service.schemas(session).await
}

/// The objects in a schema.
#[tauri::command]
pub async fn list_objects(
    service: State<'_, Service>,
    session: SessionId,
    schema: String,
) -> Result<Vec<DbObject>> {
    service.objects(session, &schema).await
}

/// The columns of a table or view.
#[tauri::command]
pub async fn list_columns(
    service: State<'_, Service>,
    session: SessionId,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    service.columns(session, &schema, &table).await
}
