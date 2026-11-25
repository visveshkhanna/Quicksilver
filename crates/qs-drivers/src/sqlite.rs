//! SQLite, a local file opened in-process.
//!
//! rusqlite is blocking, so every call runs inside `block_in_place` on the
//! caller's tokio worker. That needs the multi-threaded runtime, which the app
//! and the tests use. Cancellation interrupts the running statement from
//! another task through SQLite's interrupt handle.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use qs_core::{Column, ColumnSource, ConnectionConfig, Error, Result, TypeTag};
use qs_sql::{Dialect, split};
use rusqlite::types::ValueRef;
use rusqlite::{ErrorCode, InterruptHandle, OpenFlags};

use crate::{
    CancellationToken, CapCounter, ColumnInfo, DbObject, ExecuteOptions, ForeignKey, ObjectKind,
    Plan, PlanNode, ResultSink, RowView, Span, StatementOutcome, render,
};

/// An open SQLite database.
pub struct SqliteConnection {
    conn: Arc<Mutex<rusqlite::Connection>>,
    interrupt: Arc<InterruptHandle>,
}

impl SqliteConnection {
    /// Opens the file named by `config.path`, or an in-memory database for
    /// `:memory:`.
    ///
    /// A missing file is an error rather than silently created, unless the
    /// `create=true` option is given. `mode=ro` opens it read-only.
    pub fn open(config: &ConnectionConfig) -> Result<Self> {
        let path = config
            .path
            .as_deref()
            .ok_or_else(|| Error::config("an SQLite connection needs a file"))?;
        let option = |key: &str| config.options.get(key).map(String::as_str);
        let read_only = config.read_only || option("mode") == Some("ro");
        let create = option("create") == Some("true");

        let conn = if path == Path::new(":memory:") {
            rusqlite::Connection::open_in_memory()
        } else {
            if !create && !path.exists() {
                return Err(Error::connect(format!("{} does not exist", path.display())));
            }
            let mut flags = OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
            flags |= if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
            };
            rusqlite::Connection::open_with_flags(path, flags)
        }
        .map_err(|err| Error::connect(format!("cannot open {}: {err}", path.display())))?;

        Ok(SqliteConnection {
            interrupt: Arc::new(conn.get_interrupt_handle()),
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, rusqlite::Connection>> {
        self.conn
            .lock()
            .map_err(|_| Error::internal("the SQLite connection was poisoned by an earlier panic"))
    }

    pub(crate) async fn execute(
        &self,
        script: &str,
        options: ExecuteOptions,
        sink: &mut dyn ResultSink,
        cancel: &CancellationToken,
    ) -> Result<()> {
        // Interrupt the statement in flight when the user cancels. The watcher
        // stops with the script, so a late cancel cannot reach a later one.
        let finished = CancellationToken::new();
        let watcher = {
            let (cancel, finished, interrupt) =
                (cancel.clone(), finished.clone(), self.interrupt.clone());
            tokio::spawn(async move {
                tokio::select! {
                    () = cancel.cancelled() => interrupt.interrupt(),
                    () = finished.cancelled() => {}
                }
            })
        };
        let result =
            tokio::task::block_in_place(|| self.execute_blocking(script, options, sink, cancel));
        finished.cancel();
        let _ = watcher.await;
        result
    }

    fn execute_blocking(
        &self,
        script: &str,
        options: ExecuteOptions,
        sink: &mut dyn ResultSink,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let conn = self.lock()?;
        for (index, statement) in split(script, Dialect::Sqlite).into_iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            sink.statement_started(
                index,
                Span {
                    start: statement.start,
                    end: statement.end,
                },
            );
            let started = Instant::now();
            let mut stmt = conn.prepare(statement.text).map_err(map_err)?;

            if stmt.column_count() == 0 {
                // total_changes, unlike changes, is not left over from an
                // earlier statement when this one is DDL.
                let before = conn.total_changes();
                stmt.raw_execute().map_err(map_err)?;
                sink.statement_finished(StatementOutcome {
                    rows_returned: 0,
                    rows_affected: Some(conn.total_changes().saturating_sub(before)),
                    capped: false,
                    elapsed: started.elapsed(),
                });
                continue;
            }

            sink.columns(describe(&stmt));
            let width = stmt.column_count();
            let mut rows = stmt.raw_query();
            let mut counter = CapCounter::new(options);
            let mut capped = false;
            let mut buffer = OwnedRow::with_width(width);
            while let Some(row) = rows.next().map_err(map_err)? {
                if !counter.admit() {
                    capped = true;
                    break;
                }
                buffer.clear();
                for i in 0..width {
                    buffer.push(row.get_ref(i).map_err(map_err)?);
                }
                sink.row(&buffer);
            }
            sink.statement_finished(StatementOutcome {
                rows_returned: counter.delivered(),
                rows_affected: None,
                capped,
                elapsed: started.elapsed(),
            });
        }
        Ok(())
    }

    pub(crate) async fn schemas(&self) -> Result<Vec<String>> {
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            let mut stmt = conn
                .prepare("SELECT name FROM pragma_database_list ORDER BY seq")
                .map_err(map_err)?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            Ok(names)
        })
    }

    pub(crate) async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            let mut stmt = conn
                .prepare(
                    "SELECT name, type FROM pragma_table_list \
                     WHERE schema = ?1 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                     AND type IN ('table', 'view', 'virtual') ORDER BY name",
                )
                .map_err(map_err)?;
            let objects = stmt
                .query_map([schema], |row| {
                    let kind = match row.get_ref(1)?.as_str()? {
                        "view" => ObjectKind::View,
                        _ => ObjectKind::Table,
                    };
                    Ok(DbObject {
                        name: row.get(0)?,
                        kind,
                    })
                })
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            Ok(objects)
        })
    }

    pub(crate) async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            // `hidden` 1 is a virtual table's hidden column; 2 and 3 are
            // generated columns, which are real columns of the table.
            let mut stmt = conn
                .prepare(
                    "SELECT name, type, \"notnull\", dflt_value, pk \
                     FROM pragma_table_xinfo(?1, ?2) WHERE hidden <> 1 ORDER BY cid",
                )
                .map_err(map_err)?;
            let columns = stmt
                .query_map([table, schema], |row| {
                    let pk: i64 = row.get(4)?;
                    Ok(ColumnInfo {
                        name: row.get(0)?,
                        db_type: row.get(1)?,
                        nullable: row.get::<_, i64>(2)? == 0,
                        default: row.get(3)?,
                        primary_key_position: u32::try_from(pk).ok().filter(|&p| p > 0),
                    })
                })
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            Ok(columns)
        })
    }
}

impl SqliteConnection {
    pub(crate) async fn foreign_keys(&self, schema: &str) -> Result<Vec<ForeignKey>> {
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            // `to` is NULL when a key refers to the parent's primary key
            // without naming its columns.
            let mut stmt = conn
                .prepare(
                    "SELECT t.name, k.id, k.\"table\", k.\"from\", k.\"to\" \
                     FROM pragma_table_list t, pragma_foreign_key_list(t.name, t.schema) k \
                     WHERE t.schema = ?1 AND t.type = 'table' ORDER BY t.name, k.id, k.seq",
                )
                .map_err(map_err)?;
            let rows = stmt
                .query_map([schema], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            let mut keys: Vec<(String, i64, ForeignKey, bool)> = Vec::new();
            for (table, id, parent, from, to) in rows {
                let same = keys
                    .last()
                    .is_some_and(|(t, i, _, _)| *t == table && *i == id);
                if !same {
                    keys.push((
                        table.clone(),
                        id,
                        ForeignKey {
                            name: None,
                            schema: schema.to_owned(),
                            table,
                            columns: Vec::new(),
                            ref_schema: schema.to_owned(),
                            ref_table: parent,
                            ref_columns: Vec::new(),
                        },
                        false,
                    ));
                }
                let (_, _, key, implicit) = keys.last_mut().expect("just pushed");
                key.columns.push(from);
                match to {
                    Some(to) => key.ref_columns.push(to),
                    None => *implicit = true,
                }
            }
            let mut out = Vec::with_capacity(keys.len());
            for (_, _, mut key, implicit) in keys {
                if implicit {
                    let mut pk = conn
                        .prepare(
                            "SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk",
                        )
                        .map_err(map_err)?;
                    key.ref_columns = pk
                        .query_map([&key.ref_table, &key.ref_schema], |row| row.get(0))
                        .map_err(map_err)?
                        .collect::<rusqlite::Result<Vec<String>>>()
                        .map_err(map_err)?;
                }
                out.push(key);
            }
            Ok(out)
        })
    }

    pub(crate) async fn explain(&self, statement: &str) -> Result<Plan> {
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            // `prepare` compiles only the first statement, so nothing after
            // it can run.
            let mut stmt = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {statement}"))
                .map_err(map_err)?;
            let steps = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            let raw = steps
                .iter()
                .map(|(id, parent, detail)| format!("{id}\t{parent}\t{detail}"))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Plan {
                roots: sqlite_plan_children(&steps, 0),
                raw,
            })
        })
    }

    pub(crate) async fn ddl(&self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        if !matches!(kind, ObjectKind::Table | ObjectKind::View) {
            return Err(Error::unsupported("SQLite has only tables and views"));
        }
        tokio::task::block_in_place(|| {
            let conn = self.lock()?;
            // The schema name cannot be a parameter here, so it is quoted.
            let master = format!("\"{}\".sqlite_master", schema.replace('"', "\"\""));
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT sql FROM {master} WHERE sql IS NOT NULL AND (name = ?1 OR tbl_name = ?1) \
                     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
                ))
                .map_err(map_err)?;
            let parts = stmt
                .query_map([name], |row| row.get::<_, String>(0))
                .map_err(map_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_err)?;
            if parts.is_empty() {
                return Err(Error::query(format!("{schema}.{name} was not found")));
            }
            Ok(parts.iter().map(|p| format!("{p};\n")).collect())
        })
    }
}

/// The plan steps whose parent is `parent`, each with its own children.
fn sqlite_plan_children(steps: &[(i64, i64, String)], parent: i64) -> Vec<PlanNode> {
    steps
        .iter()
        .filter(|(id, p, _)| *p == parent && *id != parent)
        .map(|(id, _, detail)| PlanNode {
            label: detail.clone(),
            cost: None,
            rows: None,
            details: Vec::new(),
            children: sqlite_plan_children(steps, *id),
        })
        .collect()
}

fn describe(stmt: &rusqlite::Statement<'_>) -> Vec<Column> {
    let declared: Vec<Option<String>> = stmt
        .columns()
        .map(|c| c.decl_type().map(str::to_owned))
        .collect();
    stmt.columns_with_metadata()
        .zip(declared)
        .map(|(meta, decl)| {
            let source = match (meta.table_name(), meta.origin_name()) {
                (Some(table), Some(column)) => Some(ColumnSource::Named {
                    schema: meta.database_name().map(str::to_owned),
                    table: table.to_owned(),
                    column: column.to_owned(),
                }),
                _ => None,
            };
            Column {
                name: meta.name().to_owned(),
                type_tag: decl.as_deref().map_or(TypeTag::Other, tag_for_decltype),
                db_type: decl.unwrap_or_default(),
                source,
            }
        })
        .collect()
}

/// The tag for a declared column type. Names Quicksilver recognises come
/// first; the rest follow SQLite's own affinity rules.
fn tag_for_decltype(decl: &str) -> TypeTag {
    let upper = decl.to_ascii_uppercase();
    let has = |needle: &str| upper.contains(needle);
    if has("BOOL") {
        TypeTag::Bool
    } else if has("DATETIME") || has("TIMESTAMP") {
        TypeTag::Timestamp
    } else if has("DATE") {
        TypeTag::Date
    } else if has("TIME") {
        TypeTag::Time
    } else if has("JSON") {
        TypeTag::Json
    } else if has("UUID") {
        TypeTag::Uuid
    } else if has("INT") {
        TypeTag::Integer
    } else if has("CHAR") || has("CLOB") || has("TEXT") {
        TypeTag::Text
    } else if has("BLOB") {
        TypeTag::Bytes
    } else if has("REAL") || has("FLOA") || has("DOUB") {
        TypeTag::Float
    } else {
        TypeTag::Decimal
    }
}

/// A row rendered into one reused buffer, so reading a million rows does not
/// allocate a string per cell.
struct OwnedRow {
    text: String,
    cells: Vec<Option<(usize, usize)>>,
}

impl OwnedRow {
    fn with_width(width: usize) -> Self {
        OwnedRow {
            text: String::new(),
            cells: Vec::with_capacity(width),
        }
    }

    fn clear(&mut self) {
        self.text.clear();
        self.cells.clear();
    }

    fn push(&mut self, value: ValueRef<'_>) {
        let start = self.text.len();
        match value {
            ValueRef::Null => {
                self.cells.push(None);
                return;
            }
            ValueRef::Integer(i) => self.text.push_str(&i.to_string()),
            ValueRef::Real(f) => self.text.push_str(&render::float(f)),
            ValueRef::Text(bytes) => self.text.push_str(&String::from_utf8_lossy(bytes)),
            ValueRef::Blob(bytes) => self.text.push_str(&render::hex_bytes(bytes)),
        }
        self.cells.push(Some((start, self.text.len())));
    }
}

impl RowView for OwnedRow {
    fn len(&self) -> usize {
        self.cells.len()
    }

    fn get(&self, index: usize) -> Option<&str> {
        self.cells
            .get(index)
            .copied()
            .flatten()
            .map(|(start, end)| &self.text[start..end])
    }
}

fn map_err(err: rusqlite::Error) -> Error {
    match &err {
        rusqlite::Error::SqliteFailure(failure, message) => {
            if failure.code == ErrorCode::OperationInterrupted {
                return Error::Cancelled;
            }
            Error::Query {
                message: message.clone().unwrap_or_else(|| failure.to_string()),
                code: Some(failure.extended_code.to_string()),
                position: None,
                detail: None,
            }
        }
        rusqlite::Error::SqlInputError {
            error,
            msg,
            sql,
            offset,
        } => Error::Query {
            message: msg.clone(),
            code: Some(error.extended_code.to_string()),
            position: char_position(sql, *offset),
            detail: None,
        },
        _ => Error::query(err.to_string()),
    }
}

/// SQLite reports a byte offset; the UI, like Postgres, counts 1-based
/// characters.
fn char_position(sql: &str, byte_offset: i32) -> Option<u32> {
    let offset = usize::try_from(byte_offset).ok()?;
    let prefix = sql.get(..offset)?;
    u32::try_from(prefix.chars().count() + 1).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_types_map_to_tags() {
        assert_eq!(tag_for_decltype("INTEGER"), TypeTag::Integer);
        assert_eq!(tag_for_decltype("bigint"), TypeTag::Integer);
        assert_eq!(tag_for_decltype("VARCHAR(20)"), TypeTag::Text);
        assert_eq!(tag_for_decltype("BLOB"), TypeTag::Bytes);
        assert_eq!(tag_for_decltype("DOUBLE PRECISION"), TypeTag::Float);
        assert_eq!(tag_for_decltype("DECIMAL(10,2)"), TypeTag::Decimal);
        assert_eq!(tag_for_decltype("BOOLEAN"), TypeTag::Bool);
        assert_eq!(tag_for_decltype("DATETIME"), TypeTag::Timestamp);
        assert_eq!(tag_for_decltype("DATE"), TypeTag::Date);
        assert_eq!(tag_for_decltype("JSON"), TypeTag::Json);
    }

    #[test]
    fn byte_offsets_become_character_positions() {
        assert_eq!(char_position("SELECT é FROM", 10), Some(10));
        assert_eq!(char_position("abc", 0), Some(1));
        assert_eq!(char_position("abc", -1), None);
        assert_eq!(char_position("é", 1), None, "not on a character boundary");
    }

    #[test]
    fn owned_rows_hold_nulls_and_text() {
        let mut row = OwnedRow::with_width(3);
        row.push(ValueRef::Integer(-7));
        row.push(ValueRef::Null);
        row.push(ValueRef::Text("é".as_bytes()));
        assert_eq!(
            (row.get(0), row.get(1), row.get(2), row.get(3)),
            (Some("-7"), None, Some("é"), None)
        );
        row.clear();
        assert!(row.is_empty());
    }
}
