//! Database drivers.
//!
//! Each engine is one module behind a cargo feature. Dispatch is the closed
//! [`Connection`] enum, so driver types (rows, values, OIDs) never leave this
//! crate: what crosses out is rendered strings, [`Column`]s and
//! [`qs_core::Error`]s.
//!
//! A script runs one statement at a time, in order, each as its own
//! autocommit unit unless the script opens a transaction itself. Rows stream
//! into a [`ResultSink`] as they arrive and stop at the row cap; the user's
//! SQL is never changed to make that happen.

use std::time::Duration;

use qs_core::{Column, ConnectionConfig, Engine, Error, Result};
use serde::{Deserialize, Serialize};
pub use tokio_util::sync::CancellationToken;

#[cfg(feature = "postgres")]
mod postgres;
mod render;
#[cfg(feature = "sqlite")]
mod sqlite;

/// One row as the driver read it. Cells are rendered text, `None` for NULL.
pub trait RowView {
    /// The number of cells.
    fn len(&self) -> usize;
    /// Whether the row has no cells.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// The cell at `index`, or `None` for NULL.
    fn get(&self, index: usize) -> Option<&str>;
}

/// Where a script's results go, as they arrive.
///
/// The calls for each statement come in this order: `statement_started`, then
/// `columns` and any number of `row`s if it returns rows, then
/// `statement_finished`. A failing statement stops the script, and its error
/// is what [`Connection::execute`] returns.
pub trait ResultSink: Send {
    /// Statement `index` of the script, at `span` in it, is about to run.
    fn statement_started(&mut self, index: usize, span: Span);
    /// The statement returns rows with these columns.
    fn columns(&mut self, columns: Vec<Column>);
    /// One row of the current statement's result.
    fn row(&mut self, row: &dyn RowView);
    /// The current statement finished.
    fn statement_finished(&mut self, outcome: StatementOutcome);
}

/// Where a statement sits in the script, as byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct Span {
    /// Offset of the statement's first byte.
    pub start: usize,
    /// Offset just past its last byte.
    pub end: usize,
}

/// How one statement went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    /// Rows delivered to the sink.
    pub rows_returned: u64,
    /// Rows the server reports changing, for statements that return none.
    pub rows_affected: Option<u64>,
    /// Whether the result had more rows than the cap allowed. Only true when
    /// a row past the cap actually arrived.
    pub capped: bool,
    /// Time from sending the statement to its last row. Sent to the UI as
    /// `elapsedMs`.
    #[ts(type = "number")]
    #[serde(
        rename = "elapsedMs",
        serialize_with = "qs_core::serde_millis::serialize"
    )]
    pub elapsed: Duration,
}

/// How a script runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecuteOptions {
    /// The most rows to keep from each result; `None` keeps them all.
    pub row_cap: Option<u64>,
}

/// What kind of thing a catalog entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    /// A table, including a partitioned one.
    Table,
    /// A view.
    View,
    /// A materialized view.
    MaterializedView,
    /// A table stored on another server.
    ForeignTable,
    /// A sequence.
    Sequence,
    /// A function.
    Function,
    /// A procedure.
    Procedure,
}

/// One object in a schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DbObject {
    /// Its name.
    pub name: String,
    /// What it is.
    pub kind: ObjectKind,
}

/// One column of a table or view, as the catalog describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    /// Its name.
    pub name: String,
    /// The declared type, as the server spells it.
    pub db_type: String,
    /// Whether it accepts NULL.
    pub nullable: bool,
    /// The default expression, if any.
    pub default: Option<String>,
    /// Its 1-based position in the primary key, if it is part of it.
    pub primary_key_position: Option<u32>,
}

/// A foreign key: `columns` of `table` refer to `ref_columns` of
/// `ref_table`, pairwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    /// The constraint's name, where the engine names it.
    pub name: Option<String>,
    /// The schema of the referring table.
    pub schema: String,
    /// The referring table.
    pub table: String,
    /// Its referring columns, in key order.
    pub columns: Vec<String>,
    /// The schema of the referred table.
    pub ref_schema: String,
    /// The referred table.
    pub ref_table: String,
    /// The referred columns, in the same order.
    pub ref_columns: Vec<String>,
}

/// One step of a query plan.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// What the step does, such as `Seq Scan on orders` or
    /// `SEARCH t USING INDEX i (a=?)`.
    pub label: String,
    /// The planner's estimated total cost, where the engine gives one.
    pub cost: Option<f64>,
    /// The planner's estimated row count, where the engine gives one.
    pub rows: Option<f64>,
    /// Everything else the engine said about the step, in its own words.
    pub details: Vec<PlanDetail>,
    /// The steps feeding this one.
    pub children: Vec<PlanNode>,
}

/// One named fact about a plan step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PlanDetail {
    /// What it is, as the engine names it (`Filter`, `Index Cond`).
    pub name: String,
    /// Its value, as text.
    pub value: String,
}

/// How the engine would run a statement, without running it.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct Plan {
    /// The top steps (usually one).
    pub roots: Vec<PlanNode>,
    /// The engine's own output, for copying.
    pub raw: String,
}

/// The table column a result column comes from, by name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceColumn {
    /// The table's schema (`main` on SQLite).
    pub schema: String,
    /// The table.
    pub table: String,
    /// The column in that table.
    pub column: String,
}

/// An open connection to one database.
pub enum Connection {
    /// PostgreSQL.
    #[cfg(feature = "postgres")]
    Postgres(postgres::PgConnection),
    /// SQLite.
    #[cfg(feature = "sqlite")]
    Sqlite(sqlite::SqliteConnection),
}

impl Connection {
    /// Opens a connection.
    pub async fn connect(config: &ConnectionConfig) -> Result<Connection> {
        match config.engine {
            #[cfg(feature = "postgres")]
            Engine::Postgres => postgres::PgConnection::connect(config)
                .await
                .map(Connection::Postgres),
            #[cfg(feature = "sqlite")]
            Engine::Sqlite => sqlite::SqliteConnection::open(config).map(Connection::Sqlite),
            other => Err(Error::unsupported(format!(
                "{} connections are not supported yet",
                other.display_name()
            ))),
        }
    }

    /// The engine this connection speaks.
    pub fn engine(&self) -> Engine {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(_) => Engine::Postgres,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(_) => Engine::Sqlite,
        }
    }

    /// Runs every statement in `script`, in order, streaming results into
    /// `sink`. Stops at the first failing statement and returns its error,
    /// or [`Error::Cancelled`] once `cancel` fires.
    pub async fn execute(
        &self,
        script: &str,
        options: ExecuteOptions,
        sink: &mut dyn ResultSink,
        cancel: &CancellationToken,
    ) -> Result<()> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.execute(script, options, sink, cancel).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.execute(script, options, sink, cancel).await,
        }
    }

    /// The databases on the server, or an empty list where a connection is
    /// one database (SQLite).
    pub async fn databases(&self) -> Result<Vec<String>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.databases().await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(_) => Ok(Vec::new()),
        }
    }

    /// The schemas in the connected database (attached databases on SQLite).
    pub async fn schemas(&self) -> Result<Vec<String>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.schemas().await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.schemas().await,
        }
    }

    /// The tables, views, sequences and routines in `schema`.
    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.objects(schema).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.objects(schema).await,
        }
    }

    /// The columns of `table` in `schema`.
    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.columns(schema, table).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.columns(schema, table).await,
        }
    }

    /// Where each result column comes from, by name, when it is a plain
    /// table column; `None` for computed ones.
    pub async fn resolve_sources(&self, columns: &[Column]) -> Result<Vec<Option<SourceColumn>>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.resolve_sources(columns).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(_) => Ok(columns
                .iter()
                .map(|c| match &c.source {
                    Some(qs_core::ColumnSource::Named {
                        schema,
                        table,
                        column,
                    }) => Some(SourceColumn {
                        schema: schema.clone().unwrap_or_else(|| "main".to_owned()),
                        table: table.clone(),
                        column: column.clone(),
                    }),
                    _ => None,
                })
                .collect()),
        }
    }

    /// The foreign keys that start or end at a table in `schema`.
    pub async fn foreign_keys(&self, schema: &str) -> Result<Vec<ForeignKey>> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.foreign_keys(schema).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.foreign_keys(schema).await,
        }
    }

    /// How the engine would run `statement` (one statement), without running
    /// it: this never uses `EXPLAIN ANALYZE` or anything else that executes.
    pub async fn explain(&self, statement: &str) -> Result<Plan> {
        // Exactly one statement: whatever follows a `;` would otherwise run
        // for real on engines that accept several statements in one call.
        let statements = qs_sql::split(statement, qs_sql::Dialect::for_engine(self.engine()));
        let statement = match statements.as_slice() {
            [] => return Err(Error::query("there is no statement to explain")),
            [one] => one.text,
            _ => {
                return Err(Error::query(
                    "Explain works on one statement; put the cursor in the one to explain",
                ));
            }
        };
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.explain(statement).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.explain(statement).await,
        }
    }

    /// The SQL that would create the object `name` of `kind` in `schema`, as
    /// the server describes it.
    pub async fn ddl(&self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        match self {
            #[cfg(feature = "postgres")]
            Connection::Postgres(conn) => conn.ddl(schema, name, kind).await,
            #[cfg(feature = "sqlite")]
            Connection::Sqlite(conn) => conn.ddl(schema, name, kind).await,
        }
    }
}

/// Counts rows against the cap for one statement.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CapCounter {
    cap: Option<u64>,
    delivered: u64,
}

impl CapCounter {
    pub(crate) fn new(options: ExecuteOptions) -> Self {
        CapCounter {
            cap: options.row_cap,
            delivered: 0,
        }
    }

    /// Whether one more row may be delivered. Call once per arriving row; a
    /// `false` means the result is capped.
    pub(crate) fn admit(&mut self) -> bool {
        if self.cap.is_some_and(|cap| self.delivered >= cap) {
            return false;
        }
        self.delivered += 1;
        true
    }

    pub(crate) fn delivered(&self) -> u64 {
        self.delivered
    }
}
