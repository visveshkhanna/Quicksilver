//! Commands for what Quicksilver keeps between runs: profiles, history,
//! saved queries, tab buffers, layout and the catalog cache. Each forwards
//! to `qs-store` or `qs_service::saved`.

use std::sync::Arc;

use qs_core::{Engine, Error};
use qs_service::{Service, SessionId, SessionInfo, saved};
use qs_store::{
    Buffer, CatalogEntry, HistoryEntry, HistoryQuery, Notice, PasswordChange, Profile,
    ProfileFields, SavedQuery, Store, now_ms,
};
use tauri::State;

type Result<T> = std::result::Result<T, Error>;

/// What happened while opening the store (a file moved aside, say), for the
/// UI to show once.
#[tauri::command]
pub async fn store_notices(store: State<'_, Arc<Store>>) -> Result<Vec<Notice>> {
    Ok(store.notices().to_vec())
}

/// Every saved connection.
#[tauri::command]
pub async fn list_profiles(store: State<'_, Arc<Store>>) -> Result<Vec<Profile>> {
    Ok(store.profiles())
}

/// Saves a new connection.
#[tauri::command]
pub async fn create_profile(
    store: State<'_, Arc<Store>>,
    fields: ProfileFields,
    password: Option<PasswordChange>,
) -> Result<Profile> {
    store.create_profile(fields, password.unwrap_or_default())
}

/// Changes a saved connection.
#[tauri::command]
pub async fn update_profile(
    store: State<'_, Arc<Store>>,
    id: String,
    fields: ProfileFields,
    password: Option<PasswordChange>,
) -> Result<Profile> {
    store.update_profile(&id, fields, password.unwrap_or_default())
}

/// Deletes a saved connection and its saved password.
#[tauri::command]
pub async fn delete_profile(store: State<'_, Arc<Store>>, id: String) -> Result<()> {
    store.delete_profile(&id)
}

/// Opens a session for a saved connection. `password`, when given, is used
/// instead of the saved one (and is not saved). The catalog cache for the
/// `Mod+K` switcher is refreshed in the background afterwards.
#[tauri::command]
pub async fn connect_profile(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    id: String,
    password: Option<String>,
) -> Result<SessionInfo> {
    let config = saved::connection_config(&store, &id, password).await?;
    let info = service.connect(&config).await?;
    let database = config
        .database
        .clone()
        .or_else(|| (config.engine == Engine::Sqlite).then(|| "main".to_owned()));
    let (service, store) = (service.inner().clone(), Arc::clone(&store));
    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            saved::refresh_catalog(&service, &store, info.id, &id, database.as_deref()).await
        {
            tracing::warn!("the catalog cache could not be refreshed: {err}");
        }
    });
    Ok(info)
}

/// Reads a session's databases (and, with `database`, that database's
/// schemas and objects) into the catalog cache.
#[tauri::command]
pub async fn refresh_catalog(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    session: SessionId,
    profile_id: String,
    database: Option<String>,
) -> Result<()> {
    saved::refresh_catalog(&service, &store, session, &profile_id, database.as_deref()).await
}

/// The cached names, for one connection or all of them.
#[tauri::command]
pub async fn catalog(
    store: State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<Vec<CatalogEntry>> {
    store.state().catalog(profile_id.as_deref())
}

/// History, newest first.
#[tauri::command]
pub async fn history(
    store: State<'_, Arc<Store>>,
    query: Option<HistoryQuery>,
) -> Result<Vec<HistoryEntry>> {
    store.state().history(&query.unwrap_or_default())
}

/// Forgets history, for one connection or all of it.
#[tauri::command]
pub async fn clear_history(store: State<'_, Arc<Store>>, profile_id: Option<String>) -> Result<()> {
    store.state().clear_history(profile_id.as_deref())
}

/// Saved queries, for one connection (plus those for any) or all.
#[tauri::command]
pub async fn saved_queries(
    store: State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<Vec<SavedQuery>> {
    store.state().saved_queries(profile_id.as_deref())
}

/// Saves a query; with `id`, replaces that one.
#[tauri::command]
pub async fn save_query(
    store: State<'_, Arc<Store>>,
    id: Option<String>,
    name: String,
    profile_id: Option<String>,
    sql: String,
) -> Result<SavedQuery> {
    store
        .state()
        .save_query(id.as_deref(), &name, profile_id.as_deref(), &sql, now_ms())
}

/// Deletes a saved query.
#[tauri::command]
pub async fn delete_query(store: State<'_, Arc<Store>>, id: String) -> Result<()> {
    store.state().delete_query(&id)
}

/// Every saved tab.
#[tauri::command]
pub async fn buffers(store: State<'_, Arc<Store>>) -> Result<Vec<Buffer>> {
    store.state().buffers()
}

/// Saves a tab's contents.
#[tauri::command]
pub async fn save_buffer(store: State<'_, Arc<Store>>, buffer: Buffer) -> Result<()> {
    store.state().save_buffer(&buffer, now_ms())
}

/// Forgets a closed tab.
#[tauri::command]
pub async fn delete_buffer(store: State<'_, Arc<Store>>, id: String) -> Result<()> {
    store.state().delete_buffer(&id)
}

/// A saved layout value.
#[tauri::command]
pub async fn get_layout(
    store: State<'_, Arc<Store>>,
    key: String,
) -> Result<Option<serde_json::Value>> {
    store.state().layout(&key)
}

/// Saves a layout value.
#[tauri::command]
pub async fn set_layout(
    store: State<'_, Arc<Store>>,
    key: String,
    value: serde_json::Value,
) -> Result<()> {
    store.state().set_layout(&key, &value)
}
