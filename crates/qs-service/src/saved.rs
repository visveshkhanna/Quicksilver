//! Where sessions meet what is saved: connecting with a saved profile,
//! recording runs in history, and filling the catalog cache that the
//! `Mod+K` switcher searches.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use qs_core::{ConnectionConfig, Error, Result};
use qs_store::{Auth, CatalogObject, NewHistoryEntry, Store, now_ms};

use crate::{RunEvent, Service, SessionId};

/// The settings to connect with profile `id`. A `password` given here wins
/// (the user just typed it); otherwise the profile's [`Auth`] decides.
pub async fn connection_config(
    store: &Store,
    id: &str,
    password: Option<String>,
) -> Result<ConnectionConfig> {
    let profile = store.profile(id)?;
    let password = match (password, &profile.fields.auth) {
        (Some(password), _) => Some(password),
        (None, Auth::NoPassword) => None,
        (None, Auth::Keychain) => {
            Some(
                store
                    .saved_password(id)?
                    .ok_or_else(|| Error::PasswordNeeded {
                        message: format!("no password is saved for \"{}\"", profile.fields.name),
                    })?,
            )
        }
        (None, Auth::Command { program, args }) => Some(
            qs_net::password_command::run(program, args, qs_net::password_command::DEFAULT_TIMEOUT)
                .await?,
        ),
    };
    Ok(profile.fields.to_config(password))
}

/// Watches one run's events and adds it to history when it ends.
pub struct HistoryRecorder {
    store: Arc<Store>,
    started: Instant,
    pending: Mutex<Option<(NewHistoryEntry, i64)>>,
}

impl HistoryRecorder {
    /// A recorder for `sql`, run against `profile_id` in `database`.
    pub fn new(
        store: Arc<Store>,
        profile_id: Option<String>,
        database: Option<String>,
        sql: String,
    ) -> HistoryRecorder {
        HistoryRecorder {
            store,
            started: Instant::now(),
            pending: Mutex::new(Some((
                NewHistoryEntry {
                    profile_id,
                    database,
                    sql,
                    started_ms: now_ms(),
                    elapsed_ms: None,
                    rows: None,
                    error: None,
                },
                0,
            ))),
        }
    }

    /// Notes `event`; on the run's last event, writes the history entry.
    /// A history write that fails is logged, never reported as the run's
    /// failure.
    pub fn observe(&self, event: &RunEvent) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some((_, rows)) = pending.as_mut() else {
            return;
        };
        match event {
            RunEvent::StatementFinished { outcome, .. } => {
                let count = outcome.rows_affected.unwrap_or(outcome.rows_returned);
                *rows = rows.saturating_add(i64::try_from(count).unwrap_or(i64::MAX));
            }
            RunEvent::Finished { .. } | RunEvent::Failed { .. } => {
                let Some((mut entry, rows)) = pending.take() else {
                    return;
                };
                entry.elapsed_ms = i64::try_from(self.started.elapsed().as_millis()).ok();
                entry.rows = Some(rows);
                if let RunEvent::Failed { error, .. } = event {
                    entry.error = Some(error.to_string());
                }
                if let Err(err) = self.store.state().add_history(&entry) {
                    tracing::warn!("a run could not be added to history: {err}");
                }
            }
            _ => {}
        }
    }
}

/// Reads the database list of `session` into the catalog cache for
/// `profile_id`, and, when `database` is given, the schemas and objects of
/// that database (the one the session is connected to).
pub async fn refresh_catalog(
    service: &Service,
    store: &Store,
    session: SessionId,
    profile_id: &str,
    database: Option<&str>,
) -> Result<()> {
    let mut databases = service.databases(session).await?;
    // The connected database is always listed: SQLite has no list (the file
    // is the database), and a server may hide databases the user cannot
    // see. Without it, its objects would be dropped from the cache.
    if let Some(database) = database
        && !databases.iter().any(|d| d == database)
    {
        databases.push(database.to_owned());
    }
    store
        .state()
        .replace_databases(profile_id, &databases, now_ms())?;
    let Some(database) = database else {
        return Ok(());
    };
    let schemas = service.schemas(session).await?;
    let mut objects = Vec::new();
    for schema in &schemas {
        for object in service.objects(session, schema).await? {
            objects.push(CatalogObject {
                schema: schema.clone(),
                name: object.name,
                kind: kind_name(&object.kind),
            });
        }
    }
    store
        .state()
        .replace_objects(profile_id, database, &schemas, &objects, now_ms())
}

/// The kind as the UI spells it (`table`, `materializedView`, ...).
fn kind_name(kind: &crate::ObjectKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(name)) => name,
        _ => format!("{kind:?}"),
    }
}

#[cfg(test)]
mod tests {
    use qs_core::Engine;
    use qs_drivers::{CancellationToken, ExecuteOptions};
    use qs_store::{DataDir, HistoryQuery, MemorySecrets, PasswordChange, ProfileFields};

    use super::*;

    fn store() -> (tempfile::TempDir, Arc<Store>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(DataDir::at(dir.path()), Box::new(MemorySecrets::new()))
            .expect("store opens");
        (dir, Arc::new(store))
    }

    fn sqlite_profile(store: &Store, dir: &tempfile::TempDir, auth: Auth) -> String {
        let mut fields =
            ProfileFields::from_config("local", &qs_core::ConnectionConfig::new(Engine::Sqlite));
        fields.path = Some(dir.path().join("app.db"));
        fields.options.insert("create".into(), "true".into());
        fields.auth = auth;
        store
            .create_profile(fields, PasswordChange::Keep)
            .expect("profile saves")
            .id
    }

    #[tokio::test]
    async fn passwords_come_from_the_override_the_keychain_or_a_command() {
        let (dir, store) = store();
        let id = sqlite_profile(&store, &dir, Auth::Keychain);

        let missing = connection_config(&store, &id, None).await;
        assert!(
            matches!(missing, Err(Error::PasswordNeeded { .. })),
            "{missing:?}"
        );

        let typed = connection_config(&store, &id, Some("typed".into())).await;
        assert_eq!(typed.expect("config").password.as_deref(), Some("typed"));

        let mut fields = store.profile(&id).expect("profile").fields;
        store
            .update_profile(
                &id,
                fields.clone(),
                PasswordChange::Set {
                    password: String::new(),
                },
            )
            .expect("saves");
        let saved = connection_config(&store, &id, None).await.expect("config");
        assert_eq!(saved.password.as_deref(), Some(""));

        fields.auth = Auth::NoPassword;
        store
            .update_profile(&id, fields.clone(), PasswordChange::Keep)
            .expect("saves");
        let none = connection_config(&store, &id, None).await.expect("config");
        assert_eq!(none.password, None);

        if cfg!(unix) {
            fields.auth = Auth::Command {
                program: "printf".into(),
                args: vec!["token-%s\\n".into(), "42".into()],
            };
            store
                .update_profile(&id, fields, PasswordChange::Keep)
                .expect("saves");
            let token = connection_config(&store, &id, None).await.expect("config");
            assert_eq!(token.password.as_deref(), Some("token-42"));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_are_recorded_in_history_with_their_outcome() {
        let (dir, store) = store();
        let id = sqlite_profile(&store, &dir, Auth::NoPassword);
        let service = Service::new();
        let config = connection_config(&store, &id, None).await.expect("config");
        let session = service.connect(&config).await.expect("connects");

        for script in [
            "CREATE TABLE t (a INT); INSERT INTO t VALUES (1), (2); SELECT * FROM t",
            "SELECT * FROM missing",
        ] {
            let recorder = HistoryRecorder::new(
                store.clone(),
                Some(id.clone()),
                Some("main".into()),
                script.into(),
            );
            service
                .run(
                    session.id,
                    script,
                    ExecuteOptions { row_cap: None },
                    &CancellationToken::new(),
                    move |event| recorder.observe(&event),
                )
                .await
                .expect("runs");
        }

        let history = store
            .state()
            .history(&HistoryQuery::default())
            .expect("history");
        assert_eq!(history.len(), 2);
        assert!(
            history[0]
                .error
                .as_deref()
                .is_some_and(|e| e.contains("missing")),
            "{history:?}"
        );
        assert_eq!(history[1].error, None);
        // 0 for CREATE, 2 inserted, 2 selected.
        assert_eq!(history[1].rows, Some(4));
        assert_eq!(history[1].profile_id.as_deref(), Some(id.as_str()));
        assert!(history[1].elapsed_ms.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_catalog_cache_is_filled_from_a_session() {
        let (dir, store) = store();
        let id = sqlite_profile(&store, &dir, Auth::NoPassword);
        let service = Service::new();
        let config = connection_config(&store, &id, None).await.expect("config");
        let session = service.connect(&config).await.expect("connects");
        service
            .run(
                session.id,
                "CREATE TABLE orders (id INTEGER PRIMARY KEY); CREATE VIEW recent AS SELECT * FROM orders",
                ExecuteOptions { row_cap: None },
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .expect("runs");

        refresh_catalog(&service, &store, session.id, &id, Some("main"))
            .await
            .expect("refreshes");
        let catalog = store.state().catalog(Some(&id)).expect("catalog");
        let names: Vec<_> = catalog
            .iter()
            .map(|e| format!("{}:{}", e.kind, e.name.as_deref().unwrap_or(&e.database)))
            .collect();
        assert!(names.contains(&"database:main".to_owned()), "{names:?}");
        assert!(names.contains(&"table:orders".to_owned()), "{names:?}");
        assert!(names.contains(&"view:recent".to_owned()), "{names:?}");
    }
}
