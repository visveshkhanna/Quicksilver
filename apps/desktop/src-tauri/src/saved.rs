//! Commands for what Quicksilver keeps between runs: profiles, history,
//! saved queries, tab buffers, layout and the catalog cache. Each forwards
//! to `qs-store` or `qs_service::saved`.

use std::sync::Arc;

use qs_core::{ConnectionConfig, Error};
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

/// Opens a session for a saved connection, in `database` when given.
/// `password`, when given, is used instead of the saved one (and is not
/// saved). The catalog cache for the `Mod+K` switcher is refreshed in the
/// background afterwards.
#[tauri::command]
pub async fn connect_profile(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    id: String,
    database: Option<String>,
    password: Option<String>,
) -> Result<SessionInfo> {
    let config = saved::connection_config(&store, &id, database, password).await?;
    // Read-write connections ask before a script changes the schema; read-only
    // ones are refused writes by the server; full ones run everything.
    let policy = qs_service::SessionPolicy {
        confirm_schema_changes: store.profile(&id)?.fields.mode == qs_store::Mode::ReadWrite,
    };
    let info = service.connect_with(&config, policy).await?;
    let database = info.database.clone();
    let (service, store, session) = (service.inner().clone(), Arc::clone(&store), info.id);
    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            saved::refresh_catalog(&service, &store, session, &id, database.as_deref()).await
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

/// Reads one database's schemas and objects into the catalog cache, so
/// `Mod+P` finds tables in databases that were never opened.
#[tauri::command]
pub async fn index_database(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    session: SessionId,
    profile_id: String,
    database: String,
) -> Result<()> {
    saved::index_database(&service, &store, session, &profile_id, &database).await
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

/// Connects with unsaved connection-form fields and disconnects, to check
/// them. `id` is the profile being edited, if any, so its saved password can
/// be used when none is typed.
#[tauri::command]
pub async fn test_connection(
    service: State<'_, Service>,
    store: State<'_, Arc<Store>>,
    fields: ProfileFields,
    id: Option<String>,
    password: Option<String>,
) -> Result<()> {
    let config = saved::config_for(&fields, id.as_deref().unwrap_or(""), &store, password).await?;
    service.test(&config).await
}

/// What a pasted connection URL says, for filling the connection form.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    fields: ProfileFields,
    /// The password in the URL, if it had one (blank counts).
    password: Option<String>,
}

/// Reads a connection URL into connection-form fields.
#[tauri::command]
pub async fn parse_url(url: String) -> Result<ParsedUrl> {
    let config = ConnectionConfig::from_url(url.trim())?;
    let name = config
        .database
        .clone()
        .or_else(|| config.host.clone())
        .or_else(|| {
            config
                .path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| config.engine.display_name().to_owned());
    Ok(ParsedUrl {
        fields: ProfileFields::from_config(name, &config),
        password: config.password,
    })
}
