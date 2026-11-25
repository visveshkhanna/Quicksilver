//! PostgreSQL, over tokio-postgres.
//!
//! Each statement runs in two steps on the same connection. A `prepare`
//! (which executes nothing) reports the column types and the table column each
//! value comes from. The statement then runs through the simple query
//! protocol, so the server renders every value as text exactly as `psql`
//! shows it, and rows stream in as they arrive. If `prepare` fails, the
//! statement still runs and the server's own error, if any, is what the user
//! sees.
//!
//! At the row cap Quicksilver asks the server to cancel the statement rather
//! than reading the rest off the wire, then drains what is already in flight
//! so the connection is clean for the next statement.

use std::error::Error as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use qs_core::{Column, ColumnSource, ConnectionConfig, Error, Result, SslMode, TypeTag};
use qs_sql::{Dialect, split};
use tokio::task::JoinHandle;
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, NoTls, SimpleColumn, SimpleQueryMessage, SimpleQueryRow, Statement};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::{
    CancellationToken, CapCounter, ColumnInfo, DbObject, ExecuteOptions, ForeignKey, ObjectKind,
    Plan, PlanDetail, PlanNode, ResultSink, RowView, Span, StatementOutcome,
};

/// How long to wait for in-flight rows after a cancel before giving up on
/// draining them. The connection discards whatever is left either way.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs after a cancel the server may not have acted on yet, long enough for
/// the request to arrive and end it rather than the next statement.
const CANCEL_FENCE: &str = "SELECT pg_sleep(0.25)";

/// An open PostgreSQL connection.
pub struct PgConnection {
    client: Client,
    tls: Option<MakeRustlsConnect>,
    task: JoinHandle<()>,
}

impl Drop for PgConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl PgConnection {
    /// Connects with `config`, honouring its `sslmode` exactly.
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let option = |key: &str| config.options.get(key).map(String::as_str);
        let mut pg = tokio_postgres::Config::new();

        let host = config
            .host
            .as_deref()
            .ok_or_else(|| Error::config("a PostgreSQL connection needs a host"))?;
        if host.starts_with('/') {
            #[cfg(unix)]
            pg.host_path(host);
            #[cfg(not(unix))]
            return Err(Error::config(
                "Unix socket hosts are only supported on macOS and Linux",
            ));
        } else {
            pg.host(host);
        }
        pg.port(config.effective_port().unwrap_or(5432));
        let user = config
            .user
            .as_deref()
            .ok_or_else(|| Error::config("a PostgreSQL connection needs a user name"))?;
        pg.user(user);
        if let Some(password) = &config.password {
            // Blank is a valid password and is sent as one.
            pg.password(password);
        }
        if let Some(database) = &config.database {
            pg.dbname(database);
        }
        pg.application_name(option("application_name").unwrap_or("Quicksilver"));
        if config.read_only {
            pg.options("-c default_transaction_read_only=on");
        }
        let timeout = option("connect_timeout")
            .and_then(|s| s.parse().ok())
            .unwrap_or(15);
        pg.connect_timeout(Duration::from_secs(timeout));
        // tokio-postgres decides only whether TLS is attempted or mandatory;
        // what gets verified is decided by the rustls config below.
        pg.ssl_mode(match config.ssl_mode {
            SslMode::Disable => tokio_postgres::config::SslMode::Disable,
            SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            _ => tokio_postgres::config::SslMode::Require,
        });

        let tls_config =
            qs_net::tls::client_config(config.ssl_mode, config.ssl_root_cert.as_deref())?;
        let (client, tls, task) = match tls_config {
            None => {
                let (client, connection) = pg.connect(NoTls).await.map_err(connect_err)?;
                (client, None, tokio::spawn(drive(connection)))
            }
            Some(tls_config) => {
                let tls = MakeRustlsConnect::new(Arc::unwrap_or_clone(tls_config));
                let (client, connection) = pg.connect(tls.clone()).await.map_err(connect_err)?;
                (client, Some(tls), tokio::spawn(drive(connection)))
            }
        };
        Ok(PgConnection { client, tls, task })
    }

    /// Cancels the statement `stream` belongs to and reads what is left of
    /// it.
    ///
    /// A cancel request goes over its own connection and the server acts on
    /// it a little later, so when the statement had already finished the
    /// request is still on its way and would cancel whatever runs next. A
    /// short fence statement takes it instead.
    async fn cancel_and_drain<S>(&self, stream: std::pin::Pin<&mut S>)
    where
        S: futures_util::Stream<Item = Result<SimpleQueryMessage, tokio_postgres::Error>>,
    {
        self.cancel_running().await;
        if !drain(stream).await {
            let _ =
                tokio::time::timeout(DRAIN_TIMEOUT, self.client.simple_query(CANCEL_FENCE)).await;
        }
    }

    /// Asks the server to cancel whatever this connection is running.
    async fn cancel_running(&self) {
        let token = self.client.cancel_token();
        let result = match &self.tls {
            None => token.cancel_query(NoTls).await,
            Some(tls) => token.cancel_query(tls.clone()).await,
        };
        if let Err(err) = result {
            tracing::warn!("cancel request failed: {err}");
        }
    }

    pub(crate) async fn execute(
        &self,
        script: &str,
        options: ExecuteOptions,
        sink: &mut dyn ResultSink,
        cancel: &CancellationToken,
    ) -> Result<()> {
        for (index, statement) in split(script, Dialect::Postgres).into_iter().enumerate() {
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

            let described = tokio::select! {
                described = self.client.prepare(statement.text) => described.ok(),
                () = cancel.cancelled() => return Err(Error::Cancelled),
            };
            let stream = tokio::select! {
                stream = self.client.simple_query_raw(statement.text) => stream.map_err(query_err)?,
                () = cancel.cancelled() => return Err(Error::Cancelled),
            };
            let mut stream = std::pin::pin!(stream);

            let mut counter = CapCounter::new(options);
            let mut returned_rows = false;
            let mut capped = false;
            let mut affected = None;
            loop {
                let message = tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        self.cancel_and_drain(stream.as_mut()).await;
                        return Err(Error::Cancelled);
                    }
                    message = stream.next() => message,
                };
                match message {
                    None => break,
                    Some(Err(err)) => return Err(query_err(err)),
                    Some(Ok(SimpleQueryMessage::RowDescription(columns))) => {
                        returned_rows = true;
                        sink.columns(describe(&columns, described.as_ref()));
                    }
                    Some(Ok(SimpleQueryMessage::Row(row))) => {
                        if counter.admit() {
                            sink.row(&PgRow(&row));
                        } else {
                            capped = true;
                            self.cancel_and_drain(stream.as_mut()).await;
                            break;
                        }
                    }
                    Some(Ok(SimpleQueryMessage::CommandComplete(count))) => {
                        if !returned_rows {
                            affected = Some(count);
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
            sink.statement_finished(StatementOutcome {
                rows_returned: counter.delivered(),
                rows_affected: affected,
                capped,
                elapsed: started.elapsed(),
            });
        }
        Ok(())
    }

    pub(crate) async fn databases(&self) -> Result<Vec<String>> {
        self.strings(
            "SELECT datname::text FROM pg_database \
             WHERE datallowconn AND NOT datistemplate ORDER BY datname",
            &[],
        )
        .await
    }

    pub(crate) async fn schemas(&self) -> Result<Vec<String>> {
        self.strings(
            "SELECT nspname::text FROM pg_namespace \
             WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname",
            &[],
        )
        .await
    }

    pub(crate) async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        // Partitions are left out: they are reached through their parent.
        let rows = self
            .client
            .query(
                "SELECT c.relname::text, c.relkind::text \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') \
                   AND NOT c.relispartition \
                 UNION ALL \
                 SELECT DISTINCT p.proname::text, CASE p.prokind WHEN 'p' THEN 'P' ELSE 'F' END \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
                 ORDER BY 1, 2",
                &[&schema],
            )
            .await
            .map_err(query_err)?;
        let mut objects = Vec::with_capacity(rows.len());
        for row in rows {
            let kind = match row.get::<_, &str>(1) {
                "r" | "p" => ObjectKind::Table,
                "v" => ObjectKind::View,
                "m" => ObjectKind::MaterializedView,
                "f" => ObjectKind::ForeignTable,
                "S" => ObjectKind::Sequence,
                "P" => ObjectKind::Procedure,
                _ => ObjectKind::Function,
            };
            objects.push(DbObject {
                name: row.get(0),
                kind,
            });
        }
        Ok(objects)
    }

    pub(crate) async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let rows = self
            .client
            .query(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                        pg_get_expr(d.adbin, d.adrelid), \
                        (SELECT k.position FROM pg_index i, \
                                unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) \
                          WHERE i.indrelid = c.oid AND i.indisprimary AND k.attnum = a.attnum) \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                &[&schema, &table],
            )
            .await
            .map_err(query_err)?;
        Ok(rows
            .into_iter()
            .map(|row| ColumnInfo {
                name: row.get(0),
                db_type: row.get(1),
                nullable: row.get(2),
                default: row.get(3),
                // `indkey` is an int2vector, indexed from 0, so the position
                // comes from ORDINALITY, which counts from 1.
                primary_key_position: row
                    .get::<_, Option<i64>>(4)
                    .and_then(|p| u32::try_from(p).ok()),
            })
            .collect())
    }

    pub(crate) async fn foreign_keys(&self, schema: &str) -> Result<Vec<ForeignKey>> {
        let rows = self
            .client
            .query(
                "SELECT con.conname::text, n.nspname::text, c.relname::text, \
                        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, pos) \
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num \
                              ORDER BY k.pos), \
                        fn.nspname::text, fc.relname::text, \
                        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, pos) \
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num \
                              ORDER BY k.pos) \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_class fc ON fc.oid = con.confrelid \
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                 WHERE con.contype = 'f' AND (n.nspname = $1 OR fn.nspname = $1) \
                 ORDER BY 2, 3, 1",
                &[&schema],
            )
            .await
            .map_err(query_err)?;
        Ok(rows
            .into_iter()
            .map(|row| ForeignKey {
                name: Some(row.get(0)),
                schema: row.get(1),
                table: row.get(2),
                columns: row.get(3),
                ref_schema: row.get(4),
                ref_table: row.get(5),
                ref_columns: row.get(6),
            })
            .collect())
    }

    pub(crate) async fn explain(&self, statement: &str) -> Result<Plan> {
        // The extended protocol takes exactly one statement, so nothing after
        // it can run even if the splitter missed a `;`.
        let row = self
            .client
            .query_one(&format!("EXPLAIN (FORMAT JSON) {statement}"), &[])
            .await
            .map_err(query_err)?;
        let json: serde_json::Value = row.get(0);
        let roots = json
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("Plan"))
            .map(pg_plan_node)
            .collect();
        Ok(Plan {
            roots,
            raw: serde_json::to_string_pretty(&json).unwrap_or_default(),
        })
    }

    pub(crate) async fn ddl(&self, schema: &str, name: &str, kind: ObjectKind) -> Result<String> {
        let qualified = format!("{}.{}", quote(schema), quote(name));
        match kind {
            ObjectKind::Table | ObjectKind::ForeignTable => self.table_ddl(schema, name).await,
            ObjectKind::View | ObjectKind::MaterializedView => {
                let row = self
                    .client
                    .query_one(
                        "SELECT pg_get_viewdef(c.oid, true), c.relkind::text \
                         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1 AND c.relname = $2",
                        &[&schema, &name],
                    )
                    .await
                    .map_err(query_err)?;
                let body: String = row.get(0);
                let create = if row.get::<_, &str>(1) == "m" {
                    "CREATE MATERIALIZED VIEW"
                } else {
                    "CREATE OR REPLACE VIEW"
                };
                Ok(format!("{create} {qualified} AS\n{}\n", body.trim_end()))
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let bodies = self
                    .strings(
                        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                         JOIN pg_namespace n ON n.oid = p.pronamespace \
                         WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid",
                        &[&schema, &name],
                    )
                    .await?;
                Ok(bodies
                    .iter()
                    .map(|b| format!("{};\n", b.trim_end()))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            ObjectKind::Sequence => {
                let row = self
                    .client
                    .query_one(
                        "SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, \
                                s.seqmin, s.seqmax, s.seqcache, s.seqcycle \
                         FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid \
                         JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1 AND c.relname = $2",
                        &[&schema, &name],
                    )
                    .await
                    .map_err(query_err)?;
                Ok(format!(
                    "CREATE SEQUENCE {qualified} AS {} START {} INCREMENT {} MINVALUE {} MAXVALUE {} CACHE {}{};\n",
                    row.get::<_, String>(0),
                    row.get::<_, i64>(1),
                    row.get::<_, i64>(2),
                    row.get::<_, i64>(3),
                    row.get::<_, i64>(4),
                    row.get::<_, i64>(5),
                    if row.get::<_, bool>(6) { " CYCLE" } else { "" },
                ))
            }
        }
    }

    /// `CREATE TABLE` from the catalog: columns, then constraints as the
    /// server prints them, then the indexes no constraint owns.
    async fn table_ddl(&self, schema: &str, name: &str) -> Result<String> {
        let columns = self.columns(schema, name).await?;
        if columns.is_empty() {
            return Err(Error::query(format!("{schema}.{name} was not found")));
        }
        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut line = format!("    {} {}", quote(&c.name), c.db_type);
                if let Some(default) = &c.default {
                    line.push_str(" DEFAULT ");
                    line.push_str(default);
                }
                if !c.nullable {
                    line.push_str(" NOT NULL");
                }
                line
            })
            .collect();
        let constraints = self
            .client
            .query(
                "SELECT con.conname::text, pg_get_constraintdef(con.oid, true) \
                 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p', 'u', 'f', 'c', 'x') \
                 ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, 1",
                &[&schema, &name],
            )
            .await
            .map_err(query_err)?;
        for row in constraints {
            lines.push(format!(
                "    CONSTRAINT {} {}",
                quote(row.get(0)),
                row.get::<_, &str>(1)
            ));
        }
        let mut out = format!(
            "CREATE TABLE {}.{} (\n{}\n);\n",
            quote(schema),
            quote(name),
            lines.join(",\n")
        );
        let indexes = self
            .strings(
                "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i \
                 JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 \
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid) \
                 ORDER BY 1",
                &[&schema, &name],
            )
            .await?;
        for index in indexes {
            out.push_str(&index);
            out.push_str(";\n");
        }
        Ok(out)
    }

    async fn strings(
        &self,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Vec<String>> {
        let rows = self.client.query(sql, params).await.map_err(query_err)?;
        Ok(rows.into_iter().map(|row| row.get(0)).collect())
    }
}

/// A double-quoted identifier, as Postgres reads it.
fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The plan keys shown in a node's label or as cost and rows, so they are not
/// repeated in its details.
const PLAN_SUMMARY_KEYS: &[&str] = &[
    "Node Type",
    "Plans",
    "Total Cost",
    "Plan Rows",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "Join Type",
    "Parent Relationship",
];

fn pg_plan_node(node: &serde_json::Value) -> PlanNode {
    let text = |key: &str| node.get(key).and_then(serde_json::Value::as_str);
    let mut label = text("Node Type").unwrap_or("Step").to_owned();
    if let Some(join) = text("Join Type")
        && !label.contains(join)
    {
        label = format!("{join} {label}");
    }
    if let Some(index) = text("Index Name") {
        label.push_str(" using ");
        label.push_str(index);
    }
    if let Some(relation) = text("Relation Name") {
        label.push_str(" on ");
        label.push_str(relation);
        if let Some(alias) = text("Alias").filter(|alias| *alias != relation) {
            label.push(' ');
            label.push_str(alias);
        }
    }
    let details = node
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| !PLAN_SUMMARY_KEYS.contains(&key.as_str()))
        .map(|(key, value)| PlanDetail {
            name: key.clone(),
            value: match value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            },
        })
        .collect();
    PlanNode {
        label,
        cost: node.get("Total Cost").and_then(serde_json::Value::as_f64),
        rows: node.get("Plan Rows").and_then(serde_json::Value::as_f64),
        details,
        children: node
            .get("Plans")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .map(pg_plan_node)
            .collect(),
    }
}

async fn drive<C>(connection: C)
where
    C: std::future::Future<Output = Result<(), tokio_postgres::Error>>,
{
    if let Err(err) = connection.await {
        tracing::warn!("PostgreSQL connection ended: {err}");
    }
}

/// Reads and discards what the server still sends for a cancelled statement,
/// up to [`DRAIN_TIMEOUT`]. Returns whether the server reported the cancel,
/// which means it was used up on this statement.
async fn drain<S>(mut stream: std::pin::Pin<&mut S>) -> bool
where
    S: futures_util::Stream<Item = Result<SimpleQueryMessage, tokio_postgres::Error>>,
{
    tokio::time::timeout(DRAIN_TIMEOUT, async {
        let mut cancelled = false;
        while let Some(message) = stream.next().await {
            if let Err(err) = message {
                cancelled |= err.code() == Some(&SqlState::QUERY_CANCELED);
            }
        }
        cancelled
    })
    .await
    .unwrap_or(false)
}

struct PgRow<'a>(&'a SimpleQueryRow);

impl RowView for PgRow<'_> {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn get(&self, index: usize) -> Option<&str> {
        if index < self.0.len() {
            self.0.get(index)
        } else {
            None
        }
    }
}

/// The columns of a result: names from the simple query, types and sources
/// from the prepared statement when it described the same columns.
fn describe(columns: &[SimpleColumn], described: Option<&Statement>) -> Vec<Column> {
    let typed = described
        .map(Statement::columns)
        .filter(|typed| typed.len() == columns.len());
    columns
        .iter()
        .enumerate()
        .map(|(i, column)| match typed.map(|typed| &typed[i]) {
            Some(typed) => {
                let (type_tag, db_type) = describe_type(typed.type_());
                Column {
                    name: column.name().to_owned(),
                    type_tag,
                    db_type,
                    source: typed.table_oid().zip(typed.column_id()).map(
                        |(table_oid, column_id)| ColumnSource::PostgresAttribute {
                            table_oid,
                            column_id,
                        },
                    ),
                }
            }
            None => Column {
                name: column.name().to_owned(),
                type_tag: TypeTag::Other,
                db_type: String::new(),
                source: None,
            },
        })
        .collect()
}

fn describe_type(ty: &Type) -> (TypeTag, String) {
    match ty.kind() {
        Kind::Array(element) => (TypeTag::Array, format!("{}[]", describe_type(element).1)),
        Kind::Domain(base) => (describe_type(base).0, ty.name().to_owned()),
        Kind::Enum(_) => (TypeTag::Text, ty.name().to_owned()),
        _ => {
            let tag = match *ty {
                Type::BOOL => TypeTag::Bool,
                Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => TypeTag::Integer,
                Type::FLOAT4 | Type::FLOAT8 => TypeTag::Float,
                Type::NUMERIC => TypeTag::Decimal,
                Type::TEXT
                | Type::VARCHAR
                | Type::BPCHAR
                | Type::NAME
                | Type::CHAR
                | Type::UNKNOWN => TypeTag::Text,
                Type::BYTEA => TypeTag::Bytes,
                Type::DATE => TypeTag::Date,
                Type::TIME | Type::TIMETZ => TypeTag::Time,
                Type::TIMESTAMP => TypeTag::Timestamp,
                Type::TIMESTAMPTZ => TypeTag::TimestampTz,
                Type::INTERVAL => TypeTag::Interval,
                Type::UUID => TypeTag::Uuid,
                Type::JSON | Type::JSONB => TypeTag::Json,
                Type::INET | Type::CIDR | Type::MACADDR | Type::MACADDR8 => TypeTag::Network,
                _ => TypeTag::Other,
            };
            (tag, ty.name().to_owned())
        }
    }
}

fn query_err(err: tokio_postgres::Error) -> Error {
    if let Some(db) = err.as_db_error() {
        return Error::Query {
            message: db.message().to_owned(),
            code: Some(db.code().code().to_owned()),
            position: match db.position() {
                Some(ErrorPosition::Original(position)) => Some(*position),
                _ => None,
            },
            detail: db.detail().or(db.hint()).map(str::to_owned),
        };
    }
    if err.is_closed() {
        return Error::Closed;
    }
    Error::internal(with_sources(&err))
}

fn connect_err(err: tokio_postgres::Error) -> Error {
    match err.as_db_error() {
        Some(db) => Error::connect(db.message()),
        None => Error::connect(with_sources(&err)),
    }
}

/// The error's message followed by its causes, which is where the useful part
/// of a connection failure (a refused port, a certificate check) usually is.
fn with_sources(err: &tokio_postgres::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}
