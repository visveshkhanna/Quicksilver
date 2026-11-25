//! Everything Quicksilver remembers between runs apart from profiles:
//! history, saved queries, editor buffers, layout and the catalog cache.
//!
//! It is one SQLite database. History is searched and the catalog cache is
//! large, which a JSON file would make slow, and SQLite's journal keeps the
//! file whole across crashes.

use std::path::Path;

use qs_core::{Error, Result};
use rusqlite::{Connection, ErrorCode, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::files::move_aside;
use crate::{Notice, Recovered};

/// The schema version this build writes (`PRAGMA user_version`).
pub const STATE_VERSION: i64 = 1;

/// How many history entries are kept; older ones are dropped.
pub const HISTORY_LIMIT: i64 = 10_000;

const SCHEMA_V1: &str = "
CREATE TABLE history (
    id          INTEGER PRIMARY KEY,
    profile_id  TEXT,
    database    TEXT,
    sql         TEXT NOT NULL,
    started_ms  INTEGER NOT NULL,
    elapsed_ms  INTEGER,
    rows        INTEGER,
    error       TEXT
);
CREATE INDEX history_by_profile ON history (profile_id, id);

CREATE TABLE saved_queries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    profile_id  TEXT,
    sql         TEXT NOT NULL,
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

CREATE TABLE buffers (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT,
    database    TEXT,
    title       TEXT NOT NULL,
    sql         TEXT NOT NULL,
    cursor      INTEGER NOT NULL,
    position    INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

CREATE TABLE layout (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- Names for the Mod+K switcher. An empty schema and name mean the row is a
-- database; an empty name means a schema.
CREATE TABLE catalog (
    profile_id    TEXT NOT NULL,
    database      TEXT NOT NULL,
    schema        TEXT NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    refreshed_ms  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, database, schema, name)
) WITHOUT ROWID;
";

/// One script that was run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Its id; larger is newer.
    pub id: i64,
    /// The profile it ran against, if it was a saved one.
    pub profile_id: Option<String>,
    /// The database it ran in.
    pub database: Option<String>,
    /// The script, exactly as run.
    pub sql: String,
    /// When it started, in Unix milliseconds.
    pub started_ms: i64,
    /// How long it took.
    pub elapsed_ms: Option<i64>,
    /// Rows returned or affected, summed over its statements.
    pub rows: Option<i64>,
    /// The error that stopped it, if one did.
    pub error: Option<String>,
}

/// A run to add to history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistoryEntry {
    /// See [`HistoryEntry::profile_id`].
    pub profile_id: Option<String>,
    /// See [`HistoryEntry::database`].
    pub database: Option<String>,
    /// See [`HistoryEntry::sql`].
    pub sql: String,
    /// See [`HistoryEntry::started_ms`].
    pub started_ms: i64,
    /// See [`HistoryEntry::elapsed_ms`].
    pub elapsed_ms: Option<i64>,
    /// See [`HistoryEntry::rows`].
    pub rows: Option<i64>,
    /// See [`HistoryEntry::error`].
    pub error: Option<String>,
}

/// Which history to list, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Only runs against this profile.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Only scripts containing this text (case-insensitive for ASCII).
    #[serde(default)]
    pub text: Option<String>,
    /// Only entries older than this id, for paging.
    #[serde(default)]
    pub before_id: Option<i64>,
    /// At most this many (default 100, at most 1000).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A query saved by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    /// Stable id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// The profile it belongs to; `None` for one usable anywhere.
    pub profile_id: Option<String>,
    /// The SQL.
    pub sql: String,
    /// When it was created, in Unix milliseconds.
    pub created_ms: i64,
    /// When it last changed, in Unix milliseconds.
    pub updated_ms: i64,
}

/// An editor tab's contents, kept so tabs reopen as they were left.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Buffer {
    /// The tab's id, chosen by the UI.
    pub id: String,
    /// The profile the tab is connected to.
    pub profile_id: Option<String>,
    /// The database the tab is using.
    pub database: Option<String>,
    /// The tab's title.
    pub title: String,
    /// The editor text.
    pub sql: String,
    /// The cursor's offset in `sql`.
    pub cursor: u32,
    /// The tab's position in the tab strip.
    pub position: u32,
    /// When it was last saved, in Unix milliseconds. Set by the store.
    #[serde(default)]
    pub updated_ms: i64,
}

/// One name in the catalog cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// The profile it was read from.
    pub profile_id: String,
    /// The database.
    pub database: String,
    /// The schema, for schemas and objects.
    pub schema: Option<String>,
    /// The object's name, for objects.
    pub name: Option<String>,
    /// `database`, `schema`, or the object's kind (`table`, `view`, ...).
    pub kind: String,
    /// When it was read, in Unix milliseconds.
    pub refreshed_ms: i64,
}

/// An object to put in the catalog cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogObject {
    /// Its schema.
    pub schema: String,
    /// Its name.
    pub name: String,
    /// Its kind (`table`, `view`, ...).
    pub kind: String,
}

/// The open state database.
pub struct State {
    conn: Connection,
}

impl State {
    /// Opens (or creates) the database at `path`. A damaged database is
    /// moved aside and replaced with an empty one. One written by a newer
    /// Quicksilver is left alone, and this run keeps its state in memory.
    pub fn open(path: &Path, now_ms: i64) -> Result<(State, Option<Notice>)> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| crate::files::io_error("create", parent, &err))?;
        }
        match Self::open_file(path) {
            Ok(state) => Ok((state, None)),
            Err(Failure::Newer(version)) => {
                tracing::warn!(
                    "{} has schema {version}, newer than this build",
                    path.display()
                );
                Ok((
                    State::in_memory()?,
                    Some(Notice::NewerFormat {
                        file: path.to_path_buf(),
                        version,
                    }),
                ))
            }
            Err(Failure::Damaged(reason)) => {
                let kept_as = move_aside(path, now_ms)?;
                for suffix in ["-wal", "-shm"] {
                    let mut side = path.as_os_str().to_os_string();
                    side.push(suffix);
                    let _ = std::fs::remove_file(side);
                }
                let state = Self::open_file(path).map_err(Failure::into_error)?;
                Ok((
                    state,
                    Some(Notice::Recovered(Recovered {
                        file: path.to_path_buf(),
                        kept_as,
                        reason,
                    })),
                ))
            }
            Err(Failure::Other(err)) => Err(err),
        }
    }

    /// A database that lives only as long as this value.
    pub fn in_memory() -> Result<State> {
        let conn = Connection::open_in_memory().map_err(sql_error)?;
        let state = State { conn };
        state.migrate().map_err(Failure::into_error)?;
        Ok(state)
    }

    fn open_file(path: &Path) -> std::result::Result<State, Failure> {
        let conn = Connection::open(path).map_err(Failure::from_sql)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(Failure::from_sql)?;
        // The first statement that reads the file is where a damaged header
        // shows up as SQLITE_NOTADB.
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(Failure::from_sql)?;
        if check != "ok" {
            return Err(Failure::Damaged(format!("integrity check failed: {check}")));
        }
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(Failure::from_sql)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(Failure::from_sql)?;
        let state = State { conn };
        state.migrate()?;
        Ok(state)
    }

    fn migrate(&self) -> std::result::Result<(), Failure> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(Failure::from_sql)?;
        if version > STATE_VERSION {
            return Err(Failure::Newer(version));
        }
        if version < 1 {
            self.conn
                .execute_batch(&format!(
                    "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
                ))
                .map_err(Failure::from_sql)?;
        }
        Ok(())
    }

    // History -------------------------------------------------------------

    /// Adds a run to history and returns its id. Only the newest
    /// [`HISTORY_LIMIT`] entries are kept.
    pub fn add_history(&self, entry: &NewHistoryEntry) -> Result<i64> {
        self.conn
            .execute(
                "INSERT INTO history (profile_id, database, sql, started_ms, elapsed_ms, rows, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    entry.profile_id,
                    entry.database,
                    entry.sql,
                    entry.started_ms,
                    entry.elapsed_ms,
                    entry.rows,
                    entry.error
                ],
            )
            .map_err(sql_error)?;
        let id = self.conn.last_insert_rowid();
        self.conn
            .execute("DELETE FROM history WHERE id <= ?1", [id - HISTORY_LIMIT])
            .map_err(sql_error)?;
        Ok(id)
    }

    /// History matching `query`, newest first.
    pub fn history(&self, query: &HistoryQuery) -> Result<Vec<HistoryEntry>> {
        let limit = query.limit.unwrap_or(100).clamp(1, 1000);
        let pattern = query.text.as_deref().map(like_pattern);
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT id, profile_id, database, sql, started_ms, elapsed_ms, rows, error
                 FROM history
                 WHERE (?1 IS NULL OR profile_id = ?1)
                   AND (?2 IS NULL OR sql LIKE ?2 ESCAPE '\\')
                   AND (?3 IS NULL OR id < ?3)
                 ORDER BY id DESC
                 LIMIT ?4",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map(
                params![query.profile_id, pattern, query.before_id, limit],
                |row| {
                    Ok(HistoryEntry {
                        id: row.get(0)?,
                        profile_id: row.get(1)?,
                        database: row.get(2)?,
                        sql: row.get(3)?,
                        started_ms: row.get(4)?,
                        elapsed_ms: row.get(5)?,
                        rows: row.get(6)?,
                        error: row.get(7)?,
                    })
                },
            )
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(sql_error)
    }

    /// Forgets history, for one profile or (with `None`) all of it.
    pub fn clear_history(&self, profile_id: Option<&str>) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM history WHERE ?1 IS NULL OR profile_id = ?1",
                [profile_id],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    // Saved queries -------------------------------------------------------

    /// Saves a query. With an `id` it replaces that query; without one it
    /// creates a new one. Returns what was saved.
    pub fn save_query(
        &self,
        id: Option<&str>,
        name: &str,
        profile_id: Option<&str>,
        sql: &str,
        now_ms: i64,
    ) -> Result<SavedQuery> {
        if name.trim().is_empty() {
            return Err(Error::config("a saved query needs a name"));
        }
        let id = id.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
        self.conn
            .execute(
                "INSERT INTO saved_queries (id, name, profile_id, sql, created_ms, updated_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (id) DO UPDATE SET
                     name = excluded.name, profile_id = excluded.profile_id,
                     sql = excluded.sql, updated_ms = excluded.updated_ms",
                params![id, name, profile_id, sql, now_ms],
            )
            .map_err(sql_error)?;
        self.saved_query(&id)?
            .ok_or_else(|| Error::internal("a saved query vanished while saving"))
    }

    /// The saved query with `id`.
    pub fn saved_query(&self, id: &str) -> Result<Option<SavedQuery>> {
        self.conn
            .query_row(
                "SELECT id, name, profile_id, sql, created_ms, updated_ms
                 FROM saved_queries WHERE id = ?1",
                [id],
                saved_query_row,
            )
            .optional()
            .map_err(sql_error)
    }

    /// Saved queries, by name. With a profile, those for it plus those for
    /// any profile.
    pub fn saved_queries(&self, profile_id: Option<&str>) -> Result<Vec<SavedQuery>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT id, name, profile_id, sql, created_ms, updated_ms
                 FROM saved_queries
                 WHERE ?1 IS NULL OR profile_id IS NULL OR profile_id = ?1
                 ORDER BY name COLLATE NOCASE, id",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([profile_id], saved_query_row)
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(sql_error)
    }

    /// Deletes a saved query.
    pub fn delete_query(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM saved_queries WHERE id = ?1", [id])
            .map_err(sql_error)?;
        Ok(())
    }

    // Buffers -------------------------------------------------------------

    /// Saves a tab's contents.
    pub fn save_buffer(&self, buffer: &Buffer, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO buffers (id, profile_id, database, title, sql, cursor, position, updated_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (id) DO UPDATE SET
                     profile_id = excluded.profile_id, database = excluded.database,
                     title = excluded.title, sql = excluded.sql, cursor = excluded.cursor,
                     position = excluded.position, updated_ms = excluded.updated_ms",
                params![
                    buffer.id,
                    buffer.profile_id,
                    buffer.database,
                    buffer.title,
                    buffer.sql,
                    buffer.cursor,
                    buffer.position,
                    now_ms
                ],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    /// Every saved tab, in tab-strip order.
    pub fn buffers(&self) -> Result<Vec<Buffer>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT id, profile_id, database, title, sql, cursor, position, updated_ms
                 FROM buffers ORDER BY position, id",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Buffer {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    database: row.get(2)?,
                    title: row.get(3)?,
                    sql: row.get(4)?,
                    cursor: row.get(5)?,
                    position: row.get(6)?,
                    updated_ms: row.get(7)?,
                })
            })
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(sql_error)
    }

    /// Forgets a closed tab.
    pub fn delete_buffer(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM buffers WHERE id = ?1", [id])
            .map_err(sql_error)?;
        Ok(())
    }

    // Layout --------------------------------------------------------------

    /// The layout value saved under `key` (panel sizes, open tree nodes...).
    pub fn layout(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let text: Option<String> = self
            .conn
            .query_row("SELECT value FROM layout WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(sql_error)?;
        // A value that no longer parses is treated as unset: layout is a
        // convenience, never worth failing over.
        Ok(text.and_then(|text| serde_json::from_str(&text).ok()))
    }

    /// Saves a layout value.
    pub fn set_layout(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO layout (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    // Catalog cache -------------------------------------------------------

    /// Replaces the cached database list for a profile. Cached objects of
    /// databases no longer listed are dropped too.
    pub fn replace_databases(
        &mut self,
        profile_id: &str,
        databases: &[String],
        now_ms: i64,
    ) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        tx.execute(
            "DELETE FROM catalog WHERE profile_id = ?1 AND schema = ''",
            [profile_id],
        )
        .map_err(sql_error)?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO catalog (profile_id, database, schema, name, kind, refreshed_ms)
                     VALUES (?1, ?2, '', '', 'database', ?3)",
                )
                .map_err(sql_error)?;
            for database in databases {
                insert
                    .execute(params![profile_id, database, now_ms])
                    .map_err(sql_error)?;
            }
        }
        tx.execute(
            "DELETE FROM catalog WHERE profile_id = ?1 AND schema <> ''
               AND database NOT IN (SELECT database FROM catalog WHERE profile_id = ?1 AND schema = '')",
            [profile_id],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }

    /// Replaces the cached schemas and objects of one database.
    pub fn replace_objects(
        &mut self,
        profile_id: &str,
        database: &str,
        schemas: &[String],
        objects: &[CatalogObject],
        now_ms: i64,
    ) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        tx.execute(
            "DELETE FROM catalog WHERE profile_id = ?1 AND database = ?2 AND schema <> ''",
            params![profile_id, database],
        )
        .map_err(sql_error)?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO catalog (profile_id, database, schema, name, kind, refreshed_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(sql_error)?;
            for schema in schemas.iter().filter(|s| !s.is_empty()) {
                insert
                    .execute(params![profile_id, database, schema, "", "schema", now_ms])
                    .map_err(sql_error)?;
            }
            for object in objects
                .iter()
                .filter(|o| !o.schema.is_empty() && !o.name.is_empty())
            {
                insert
                    .execute(params![
                        profile_id,
                        database,
                        object.schema,
                        object.name,
                        object.kind,
                        now_ms
                    ])
                    .map_err(sql_error)?;
            }
        }
        tx.commit().map_err(sql_error)
    }

    /// The cached names, for one profile or all of them, in a stable order.
    pub fn catalog(&self, profile_id: Option<&str>) -> Result<Vec<CatalogEntry>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT profile_id, database, schema, name, kind, refreshed_ms
                 FROM catalog WHERE ?1 IS NULL OR profile_id = ?1
                 ORDER BY profile_id, database, schema, name",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([profile_id], |row| {
                let schema: String = row.get(2)?;
                let name: String = row.get(3)?;
                Ok(CatalogEntry {
                    profile_id: row.get(0)?,
                    database: row.get(1)?,
                    schema: (!schema.is_empty()).then_some(schema),
                    name: (!name.is_empty()).then_some(name),
                    kind: row.get(4)?,
                    refreshed_ms: row.get(5)?,
                })
            })
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(sql_error)
    }

    /// Forgets what belongs to a deleted profile: its catalog cache, its
    /// saved queries and its tabs' connection (the tabs' text is kept).
    pub fn forget_profile(&mut self, profile_id: &str) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        tx.execute("DELETE FROM catalog WHERE profile_id = ?1", [profile_id])
            .map_err(sql_error)?;
        tx.execute(
            "DELETE FROM saved_queries WHERE profile_id = ?1",
            [profile_id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "UPDATE buffers SET profile_id = NULL, database = NULL WHERE profile_id = ?1",
            [profile_id],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }
}

fn saved_query_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedQuery> {
    Ok(SavedQuery {
        id: row.get(0)?,
        name: row.get(1)?,
        profile_id: row.get(2)?,
        sql: row.get(3)?,
        created_ms: row.get(4)?,
        updated_ms: row.get(5)?,
    })
}

/// A `LIKE` pattern matching `text` anywhere, with `%`, `_` and the escape
/// character itself taken literally.
fn like_pattern(text: &str) -> String {
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

fn sql_error(err: rusqlite::Error) -> Error {
    Error::storage(format!("the state database failed: {err}"))
}

enum Failure {
    Newer(i64),
    Damaged(String),
    Other(Error),
}

impl Failure {
    fn from_sql(err: rusqlite::Error) -> Failure {
        match err.sqlite_error_code() {
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => {
                Failure::Damaged(err.to_string())
            }
            _ => Failure::Other(sql_error(err)),
        }
    }

    fn into_error(self) -> Error {
        match self {
            Failure::Newer(version) => Error::storage(format!(
                "the state database has schema {version}, newer than this build"
            )),
            Failure::Damaged(reason) => {
                Error::storage(format!("the state database is damaged: {reason}"))
            }
            Failure::Other(err) => err,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
    }

    fn run(sql: &str, profile: Option<&str>, started_ms: i64) -> NewHistoryEntry {
        NewHistoryEntry {
            profile_id: profile.map(str::to_owned),
            database: Some("app".into()),
            sql: sql.into(),
            started_ms,
            elapsed_ms: Some(3),
            rows: Some(1),
            error: None,
        }
    }

    #[test]
    fn history_is_newest_first_filtered_and_paged() -> Result<()> {
        let state = State::in_memory()?;
        state.add_history(&run("select 1", Some("a"), 1))?;
        state.add_history(&run("select 100% off", Some("b"), 2))?;
        state.add_history(&run("SELECT name FROM users", Some("a"), 3))?;

        let all = state.history(&HistoryQuery::default())?;
        assert_eq!(
            all.iter().map(|e| e.started_ms).collect::<Vec<_>>(),
            [3, 2, 1]
        );

        let for_a = state.history(&HistoryQuery {
            profile_id: Some("a".into()),
            ..HistoryQuery::default()
        })?;
        assert_eq!(for_a.len(), 2);

        // Case-insensitive, and `%` is matched literally.
        let found = state.history(&HistoryQuery {
            text: Some("users".into()),
            ..HistoryQuery::default()
        })?;
        assert_eq!(found.len(), 1);
        let percent = state.history(&HistoryQuery {
            text: Some("0% o".into()),
            ..HistoryQuery::default()
        })?;
        assert_eq!(percent.len(), 1);
        let literal = state.history(&HistoryQuery {
            text: Some("%".into()),
            ..HistoryQuery::default()
        })?;
        assert_eq!(literal.len(), 1);

        let page = state.history(&HistoryQuery {
            before_id: Some(all[0].id),
            limit: Some(1),
            ..HistoryQuery::default()
        })?;
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].started_ms, 2);

        state.clear_history(Some("a"))?;
        assert_eq!(state.history(&HistoryQuery::default())?.len(), 1);
        Ok(())
    }

    #[test]
    fn history_keeps_only_the_newest_entries() -> Result<()> {
        let state = State::in_memory()?;
        for i in 0..(HISTORY_LIMIT + 5) {
            state.add_history(&run("select 1", None, i))?;
        }
        let count: i64 = state
            .conn
            .query_row("SELECT count(*) FROM history", [], |row| row.get(0))
            .map_err(sql_error)?;
        assert_eq!(count, HISTORY_LIMIT);
        let newest = state.history(&HistoryQuery {
            limit: Some(1),
            ..HistoryQuery::default()
        })?;
        assert_eq!(newest[0].started_ms, HISTORY_LIMIT + 4);
        Ok(())
    }

    #[test]
    fn saved_queries_create_update_list_and_delete() -> Result<()> {
        let state = State::in_memory()?;
        let a = state.save_query(None, "b report", Some("p1"), "select 1", 10)?;
        state.save_query(None, "A everywhere", None, "select 2", 11)?;
        state.save_query(None, "other", Some("p2"), "select 3", 12)?;
        let a2 = state.save_query(Some(&a.id), "b report", Some("p1"), "select 10", 20)?;
        assert_eq!(
            (a2.created_ms, a2.updated_ms, a2.sql.as_str()),
            (10, 20, "select 10")
        );

        let names: Vec<_> = state
            .saved_queries(Some("p1"))?
            .into_iter()
            .map(|q| q.name)
            .collect();
        assert_eq!(names, ["A everywhere", "b report"]);
        assert_eq!(state.saved_queries(None)?.len(), 3);
        assert!(state.save_query(None, " ", None, "x", 1).is_err());

        state.delete_query(&a.id)?;
        assert!(state.saved_query(&a.id)?.is_none());
        Ok(())
    }

    #[test]
    fn buffers_and_layout_round_trip() -> Result<()> {
        let state = State::in_memory()?;
        let mut tab = Buffer {
            id: "t1".into(),
            profile_id: Some("p".into()),
            database: Some("app".into()),
            title: "Query 1".into(),
            sql: "select 1;".into(),
            cursor: 8,
            position: 1,
            updated_ms: 0,
        };
        state.save_buffer(&tab, 5)?;
        tab.sql = "select 2;".into();
        state.save_buffer(&tab, 6)?;
        state.save_buffer(
            &Buffer {
                id: "t0".into(),
                position: 0,
                ..tab.clone()
            },
            7,
        )?;
        let tabs = state.buffers()?;
        assert_eq!(
            tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["t0", "t1"]
        );
        assert_eq!((tabs[1].sql.as_str(), tabs[1].updated_ms), ("select 2;", 6));
        state.delete_buffer("t0")?;
        assert_eq!(state.buffers()?.len(), 1);

        assert_eq!(state.layout("panels")?, None);
        let value = serde_json::json!({ "navigator": 22, "inspector": 18 });
        state.set_layout("panels", &value)?;
        assert_eq!(state.layout("panels")?, Some(value));
        Ok(())
    }

    #[test]
    fn the_catalog_cache_replaces_by_profile_and_database() -> Result<()> {
        let mut state = State::in_memory()?;
        state.replace_databases("p", &["app".into(), "old".into()], 1)?;
        state.replace_databases("q", &["other".into()], 1)?;
        state.replace_objects(
            "p",
            "old",
            &["public".into()],
            &[CatalogObject {
                schema: "public".into(),
                name: "gone".into(),
                kind: "table".into(),
            }],
            2,
        )?;
        state.replace_objects(
            "p",
            "app",
            &["public".into(), "sales".into()],
            &[CatalogObject {
                schema: "sales".into(),
                name: "orders".into(),
                kind: "table".into(),
            }],
            2,
        )?;
        assert_eq!(state.catalog(Some("p"))?.len(), 2 + 1 + 1 + 2 + 1);

        // "old" disappears from the server: its objects go with it.
        state.replace_databases("p", &["app".into()], 3)?;
        let p = state.catalog(Some("p"))?;
        assert!(p.iter().all(|e| e.database == "app"), "{p:?}");
        let orders = p
            .iter()
            .find(|e| e.name.as_deref() == Some("orders"))
            .ok_or_else(|| Error::internal("orders missing"))?;
        assert_eq!(
            (orders.schema.as_deref(), orders.kind.as_str()),
            (Some("sales"), "table")
        );
        let database = p
            .iter()
            .find(|e| e.kind == "database")
            .ok_or_else(|| Error::internal("database missing"))?;
        assert_eq!((database.schema.as_ref(), database.refreshed_ms), (None, 3));
        assert_eq!(state.catalog(None)?.len(), p.len() + 1);

        state.forget_profile("p")?;
        assert!(state.catalog(Some("p"))?.is_empty());
        assert_eq!(state.catalog(None)?.len(), 1);
        Ok(())
    }

    #[test]
    fn state_survives_reopening() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("state.db");
        {
            let (state, notice) = State::open(&path, 1)?;
            assert!(notice.is_none());
            state.add_history(&run("select 1", None, 1))?;
        }
        let (state, notice) = State::open(&path, 2)?;
        assert!(notice.is_none());
        assert_eq!(state.history(&HistoryQuery::default())?.len(), 1);
        Ok(())
    }

    #[test]
    fn a_damaged_database_is_moved_aside_and_replaced() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("state.db");
        let junk = vec![0x5a_u8; 8192];
        std::fs::write(&path, &junk).map_err(|e| Error::internal(e.to_string()))?;
        let (state, notice) = State::open(&path, 77)?;
        let Some(Notice::Recovered(recovered)) = notice else {
            return Err(Error::internal(format!(
                "expected recovery, got {notice:?}"
            )));
        };
        assert_eq!(recovered.kept_as, dir.path().join("state.db.corrupt-77"));
        assert_eq!(std::fs::read(&recovered.kept_as).ok(), Some(junk));
        state.add_history(&run("select 1", None, 1))?;
        Ok(())
    }

    #[test]
    fn a_newer_database_is_left_alone() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).map_err(sql_error)?;
            conn.execute_batch("CREATE TABLE future (x); PRAGMA user_version = 9;")
                .map_err(sql_error)?;
        }
        let (state, notice) = State::open(&path, 1)?;
        assert!(
            matches!(notice, Some(Notice::NewerFormat { version: 9, .. })),
            "{notice:?}"
        );
        state.add_history(&run("select 1", None, 1))?;
        let conn = Connection::open(&path).map_err(sql_error)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(sql_error)?;
        assert_eq!(version, 9);
        Ok(())
    }
}
