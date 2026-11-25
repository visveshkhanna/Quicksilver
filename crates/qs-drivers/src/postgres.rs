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
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, NoTls, SimpleColumn, SimpleQueryMessage, SimpleQueryRow, Statement};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::{
    CancellationToken, CapCounter, ColumnInfo, DbObject, ExecuteOptions, ObjectKind, ResultSink,
    RowView, Span, StatementOutcome,
};

/// How long to wait for in-flight rows after a cancel before giving up on
/// draining them. The connection discards whatever is left either way.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

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

    /// Asks the server to cancel whatever this connection is running. Waits
    /// for the server to take the request, so it cannot land on a later
    /// statement.
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
                        self.cancel_running().await;
                        drain(stream.as_mut()).await;
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
                            self.cancel_running().await;
                            drain(stream.as_mut()).await;
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

    async fn strings(
        &self,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Vec<String>> {
        let rows = self.client.query(sql, params).await.map_err(query_err)?;
        Ok(rows.into_iter().map(|row| row.get(0)).collect())
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
/// up to [`DRAIN_TIMEOUT`].
async fn drain<S>(mut stream: std::pin::Pin<&mut S>)
where
    S: futures_util::Stream<Item = Result<SimpleQueryMessage, tokio_postgres::Error>>,
{
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        while stream.next().await.is_some() {}
    })
    .await;
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
