//! The one API the desktop shell exposes to the UI.
//!
//! The Tauri commands in `apps/desktop/src-tauri` are thin wrappers over
//! [`Service`], so everything the app can do is testable without a window.
//!
//! A run executes a script on a session and reports what happens as
//! [`RunEvent`]s. Each statement that returns rows gets a result, held in a
//! [`store::ResultStore`] until the UI closes it; the UI reads it a page at a
//! time with [`Service::page`].

pub mod saved;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use qs_core::{Column, ConnectionConfig, Engine, Error, Result};
pub use qs_drivers::{
    CancellationToken, ColumnInfo, DbObject, ExecuteOptions, ForeignKey, ObjectKind, Plan,
    PlanDetail, PlanNode, Span, StatementOutcome,
};
use qs_drivers::{Connection, ResultSink, RowView};
pub use qs_io::rows::Format as CopyFormat;
use serde::Serialize;

use crate::store::ResultStore;
pub use crate::store::{SortDirection, SpillPolicy};

/// The most rows one page may hold, so a single fetch stays small.
pub const MAX_PAGE_ROWS: u32 = 10_000;

/// The most text one copy may produce; past it the UI suggests exporting.
pub const MAX_COPY_BYTES: usize = 64 * 1024 * 1024;

/// How often a run reports how many rows have arrived.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Identifies an open session.
pub type SessionId = u64;
/// Identifies a run, for cancelling it.
pub type RunId = u64;
/// Identifies a statement's result, for paging through it.
pub type ResultId = u64;

/// What the app reports about itself.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// The product name.
    pub name: &'static str,
    /// The version, shared by every crate and package in the repository.
    pub version: &'static str,
    /// The engines this build knows about.
    pub engines: Vec<EngineInfo>,
}

/// One engine, as the UI lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// The stable identifier, as it is stored in profiles.
    pub id: Engine,
    /// The name shown to people.
    pub name: &'static str,
    /// The default port, if the engine has one.
    pub default_port: Option<u16>,
}

/// The app's name, version and known engines.
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Quicksilver",
        version: env!("CARGO_PKG_VERSION"),
        engines: Engine::ALL
            .iter()
            .map(|&id| EngineInfo {
                id,
                name: id.display_name(),
                default_port: id.default_port(),
            })
            .collect(),
    }
}

/// An open session, as the UI sees it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Its id.
    pub id: SessionId,
    /// The engine it speaks.
    pub engine: Engine,
    /// The database it is connected to, when that is known without asking
    /// the server: the configured one, Postgres's default (the user name),
    /// or `main` for SQLite.
    pub database: Option<String>,
    /// Whether writes are refused.
    pub read_only: bool,
}

/// What happens during a run, in order.
#[derive(Debug, Clone, Serialize, PartialEq, ts_rs::TS)]
#[ts(export)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    /// A statement is about to run.
    StatementStarted {
        /// Its position in the script, from 0.
        index: usize,
        /// Its byte range in the script.
        span: Span,
    },
    /// The statement returns rows; page through them with this result id.
    ResultStarted {
        /// The statement's position in the script.
        index: usize,
        /// The result to page through.
        result_id: ResultId,
        /// Its columns.
        columns: Vec<Column>,
    },
    /// More rows have arrived.
    Progress {
        /// The result they belong to.
        result_id: ResultId,
        /// Rows stored so far.
        rows: u64,
    },
    /// The statement finished.
    StatementFinished {
        /// Its position in the script.
        index: usize,
        /// Its result, if it returned rows.
        result_id: Option<ResultId>,
        /// How it went.
        outcome: StatementOutcome,
    },
    /// Every statement ran.
    Finished {
        /// Time for the whole script. Sent to the UI as `elapsedMs`.
        #[ts(type = "number")]
        #[serde(
            rename = "elapsedMs",
            serialize_with = "qs_core::serde_millis::serialize"
        )]
        elapsed: Duration,
    },
    /// A statement failed, or the run was cancelled. Nothing after it ran.
    Failed {
        /// The statement that failed, if one had started.
        index: Option<usize>,
        /// Why.
        error: Error,
    },
}

/// What a result holds right now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ResultInfo {
    /// Its columns.
    pub columns: Vec<Column>,
    /// Rows stored so far.
    pub rows: u64,
    /// Approximate memory held, in bytes.
    pub bytes: u64,
    /// Cell text moved to a temporary file, in bytes.
    pub spilled_bytes: u64,
}

/// The database a connection made with `config` lands in.
fn effective_database(config: &ConnectionConfig) -> Option<String> {
    config.database.clone().or_else(|| match config.engine {
        Engine::Postgres => config.user.clone(),
        Engine::Sqlite => Some("main".to_owned()),
        _ => None,
    })
}

/// A statement's place in the editor, in UTF-16 code units (JavaScript
/// string offsets).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StatementRange {
    /// Where it starts.
    pub start: usize,
    /// Just past where it ends.
    pub end: usize,
}

/// The statement the editor cursor is in (see [`qs_sql::statement_at`]).
/// `cursor` and the result are UTF-16 offsets, as the editor counts.
pub fn statement_at(script: &str, engine: Engine, cursor: usize) -> Option<StatementRange> {
    let byte = utf16_to_byte(script, cursor);
    let statement = qs_sql::statement_at(script, qs_sql::Dialect::for_engine(engine), byte)?;
    Some(StatementRange {
        start: byte_to_utf16(script, statement.start),
        end: byte_to_utf16(script, statement.end),
    })
}

fn utf16_to_byte(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units >= offset {
            return byte;
        }
        units += c.len_utf16();
    }
    text.len()
}

fn byte_to_utf16(text: &str, byte: usize) -> usize {
    text[..byte.min(text.len())].encode_utf16().count()
}

struct Session {
    connection: Connection,
    /// One script at a time per session: statements on one connection run in
    /// order anyway, and interleaving two scripts would mix their effects.
    running: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<SessionId, Arc<Session>>,
    runs: HashMap<RunId, CancellationToken>,
    results: HashMap<ResultId, Arc<ResultStore>>,
}

/// Sessions, runs and results. Cheap to clone; clones share everything.
#[derive(Clone, Default)]
pub struct Service {
    state: Arc<Mutex<State>>,
    next_id: Arc<AtomicU64>,
    spill: Arc<SpillPolicy>,
}

impl Service {
    /// An empty service, spilling large results by the default policy.
    pub fn new() -> Self {
        Service::default()
    }

    /// An empty service that spills large results by `policy`.
    pub fn with_spill(policy: SpillPolicy) -> Self {
        Service {
            spill: Arc::new(policy),
            ..Service::default()
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // A panic while holding this lock leaves plain maps behind, which
        // are still consistent, so the poison flag is safe to ignore.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn session(&self, id: SessionId) -> Result<Arc<Session>> {
        self.state()
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::config(format!("no open session {id}")))
    }

    /// Opens a session.
    pub async fn connect(&self, config: &ConnectionConfig) -> Result<SessionInfo> {
        let connection = Connection::connect(config).await?;
        let engine = connection.engine();
        let id = self.id();
        self.state().sessions.insert(
            id,
            Arc::new(Session {
                connection,
                running: tokio::sync::Mutex::new(()),
            }),
        );
        Ok(SessionInfo {
            id,
            engine,
            database: effective_database(config),
            read_only: config.read_only,
        })
    }

    /// Connects and disconnects at once, to check that `config` works.
    pub async fn test(&self, config: &ConnectionConfig) -> Result<()> {
        Connection::connect(config).await.map(drop)
    }

    /// Closes a session. Results it produced stay readable until closed.
    pub fn disconnect(&self, id: SessionId) {
        self.state().sessions.remove(&id);
    }

    /// Starts running `script` in the background and returns its id at once.
    /// `events` receives every [`RunEvent`], ending with `Finished` or
    /// `Failed`.
    pub fn start_run(
        &self,
        session: SessionId,
        script: String,
        options: ExecuteOptions,
        events: impl Fn(RunEvent) + Send + Sync + 'static,
    ) -> Result<RunId> {
        let session = self.session(session)?;
        let run = self.id();
        let cancel = CancellationToken::new();
        self.state().runs.insert(run, cancel.clone());
        let service = self.clone();
        tokio::spawn(async move {
            service
                .execute(&session, &script, options, &cancel, events)
                .await;
            service.state().runs.remove(&run);
        });
        Ok(run)
    }

    /// Runs `script` to completion, reporting through `events`.
    pub async fn run(
        &self,
        session: SessionId,
        script: &str,
        options: ExecuteOptions,
        cancel: &CancellationToken,
        events: impl Fn(RunEvent) + Send + Sync,
    ) -> Result<()> {
        let session = self.session(session)?;
        self.execute(&session, script, options, cancel, events)
            .await;
        Ok(())
    }

    async fn execute(
        &self,
        session: &Session,
        script: &str,
        options: ExecuteOptions,
        cancel: &CancellationToken,
        events: impl Fn(RunEvent) + Send + Sync,
    ) {
        let _running = session.running.lock().await;
        let started = Instant::now();
        let mut sink = ServiceSink {
            service: self,
            events: &events,
            index: None,
            current: None,
            last_progress: Instant::now(),
            failed: None,
        };
        let result = session
            .connection
            .execute(script, options, &mut sink, cancel)
            .await;
        // A failed or cancelled statement's rows are complete too: nothing
        // more will arrive, so they can be sorted.
        if let Some((_, store)) = &sink.current {
            store.finish();
        }
        let (index, failed) = (sink.index, sink.failed.take());
        match failed.map_or(result, Err) {
            Ok(()) => events(RunEvent::Finished {
                elapsed: started.elapsed(),
            }),
            Err(error) => events(RunEvent::Failed { index, error }),
        }
    }

    /// Cancels a run. Unknown or finished runs are ignored.
    pub fn cancel(&self, run: RunId) {
        if let Some(token) = self.state().runs.get(&run) {
            token.cancel();
        }
    }

    fn result(&self, id: ResultId) -> Result<Arc<ResultStore>> {
        self.state()
            .results
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::config(format!("no result {id}")))
    }

    /// Up to `count` rows of a result from `offset`, as a binary page (see
    /// [`ResultStore::page`]). `count` is limited to [`MAX_PAGE_ROWS`].
    pub fn page(&self, result: ResultId, offset: u64, count: u32) -> Result<Vec<u8>> {
        self.result(result)?.page(offset, count.min(MAX_PAGE_ROWS))
    }

    /// A result's columns, row count and size.
    pub fn result_info(&self, result: ResultId) -> Result<ResultInfo> {
        let store = self.result(result)?;
        Ok(ResultInfo {
            columns: store.columns().to_vec(),
            rows: store.row_count(),
            bytes: store.bytes(),
            spilled_bytes: store.spilled_bytes(),
        })
    }

    /// Sorts what a finished result's pages return by `column`, or restores
    /// arrival order with `None`.
    pub fn sort_result(&self, result: ResultId, by: Option<(usize, SortDirection)>) -> Result<()> {
        self.result(result)?.sort(by)
    }

    /// Frees a result.
    pub fn close_result(&self, result: ResultId) {
        self.state().results.remove(&result);
    }

    /// Displayed rows `offset .. offset + count` of a result, restricted to
    /// `columns` in that order, as text in `format`. Fails past
    /// [`MAX_COPY_BYTES`].
    pub fn copy_rows(
        &self,
        result: ResultId,
        offset: u64,
        count: u64,
        columns: &[usize],
        format: CopyFormat,
    ) -> Result<String> {
        let store = self.result(result)?;
        let fields = columns
            .iter()
            .map(|&c| {
                store
                    .columns()
                    .get(c)
                    .map(|column| qs_io::rows::Field {
                        name: column.name.clone(),
                        type_tag: column.type_tag,
                    })
                    .ok_or_else(|| Error::config(format!("no column {c}")))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut writer = qs_io::rows::RowWriter::new(format, fields, MAX_COPY_BYTES);
        let mut failed = None;
        let mut cells: Vec<Option<String>> = Vec::new();
        store.rows(offset, count, columns, |row| {
            if failed.is_some() {
                return;
            }
            cells.clear();
            cells.extend((0..row.len()).map(|i| row.get(i).map(str::to_owned)));
            let borrowed: Vec<Option<&str>> = cells.iter().map(Option::as_deref).collect();
            if let Err(err) = writer.row(&borrowed) {
                failed = Some(err);
            }
        })?;
        match failed {
            Some(err) => Err(err),
            None => Ok(writer.finish()),
        }
    }

    /// The databases on the session's server.
    pub async fn databases(&self, session: SessionId) -> Result<Vec<String>> {
        self.session(session)?.connection.databases().await
    }

    /// The schemas in the session's database.
    pub async fn schemas(&self, session: SessionId) -> Result<Vec<String>> {
        self.session(session)?.connection.schemas().await
    }

    /// The objects in a schema.
    pub async fn objects(&self, session: SessionId, schema: &str) -> Result<Vec<DbObject>> {
        self.session(session)?.connection.objects(schema).await
    }

    /// The columns of a table or view.
    pub async fn columns(
        &self,
        session: SessionId,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>> {
        self.session(session)?
            .connection
            .columns(schema, table)
            .await
    }

    /// The foreign keys starting or ending in a schema.
    pub async fn foreign_keys(&self, session: SessionId, schema: &str) -> Result<Vec<ForeignKey>> {
        self.session(session)?.connection.foreign_keys(schema).await
    }

    /// How the server would run one statement, without running it. Waits for
    /// a running script on the session to finish first.
    pub async fn explain(&self, session: SessionId, statement: &str) -> Result<Plan> {
        let session = self.session(session)?;
        let _running = session.running.lock().await;
        session.connection.explain(statement).await
    }

    /// The SQL that creates an object.
    pub async fn ddl(
        &self,
        session: SessionId,
        schema: &str,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        self.session(session)?
            .connection
            .ddl(schema, name, kind)
            .await
    }
}

/// Stores rows and turns driver callbacks into [`RunEvent`]s.
struct ServiceSink<'a, F> {
    service: &'a Service,
    events: &'a F,
    index: Option<usize>,
    current: Option<(ResultId, Arc<ResultStore>)>,
    last_progress: Instant,
    /// A storage failure, reported in place of the driver's result.
    failed: Option<Error>,
}

impl<F: Fn(RunEvent) + Send + Sync> ResultSink for ServiceSink<'_, F> {
    fn statement_started(&mut self, index: usize, span: Span) {
        self.index = Some(index);
        self.current = None;
        (self.events)(RunEvent::StatementStarted { index, span });
    }

    fn columns(&mut self, columns: Vec<Column>) {
        let id = self.service.id();
        let store = Arc::new(ResultStore::with_policy(
            columns.clone(),
            SpillPolicy::clone(&self.service.spill),
        ));
        self.service.state().results.insert(id, store.clone());
        self.current = Some((id, store));
        self.last_progress = Instant::now();
        (self.events)(RunEvent::ResultStarted {
            index: self.index.unwrap_or_default(),
            result_id: id,
            columns,
        });
    }

    fn row(&mut self, row: &dyn RowView) {
        let Some((id, store)) = &self.current else {
            return;
        };
        if self.failed.is_some() {
            return;
        }
        if let Err(err) = store.push(row) {
            self.failed = Some(err);
            return;
        }
        if self.last_progress.elapsed() >= PROGRESS_INTERVAL {
            self.last_progress = Instant::now();
            (self.events)(RunEvent::Progress {
                result_id: *id,
                rows: store.row_count(),
            });
        }
    }

    fn statement_finished(&mut self, outcome: StatementOutcome) {
        if let Some((_, store)) = &self.current {
            store.finish();
        }
        (self.events)(RunEvent::StatementFinished {
            index: self.index.unwrap_or_default(),
            result_id: self.current.as_ref().map(|(id, _)| *id),
            outcome,
        });
    }
}

#[cfg(test)]
mod tests;
