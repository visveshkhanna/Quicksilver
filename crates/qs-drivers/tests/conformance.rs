//! Behaviour every driver must share, run against each engine.
//!
//! SQLite runs in memory on every `cargo test`. Postgres runs against the
//! development database and is `#[ignore]`d; run it with
//! `cargo test -p qs-drivers -- --ignored` after
//! `docker compose -f dev/compose.yaml up -d postgres`. Set
//! `QS_TEST_POSTGRES_URL` to point it elsewhere.

use std::time::{Duration, Instant};

use qs_core::{Column, ConnectionConfig, Engine, Error, TypeTag};
use qs_drivers::{
    CancellationToken, Connection, ExecuteOptions, ObjectKind, ResultSink, RowView, SourceColumn,
    Span, StatementOutcome,
};

// ---------------------------------------------------------------------------
// Harness

#[derive(Debug, Default)]
struct Collected {
    statements: Vec<StatementResult>,
}

#[derive(Debug)]
struct StatementResult {
    index: usize,
    span: Span,
    columns: Option<Vec<Column>>,
    rows: Vec<Vec<Option<String>>>,
    outcome: Option<StatementOutcome>,
}

impl Collected {
    fn current(&mut self) -> &mut StatementResult {
        self.statements
            .last_mut()
            .expect("statement_started came first")
    }

    fn only(&self) -> &StatementResult {
        assert_eq!(self.statements.len(), 1, "{:#?}", self.statements);
        &self.statements[0]
    }
}

impl ResultSink for Collected {
    fn statement_started(&mut self, index: usize, span: Span) {
        self.statements.push(StatementResult {
            index,
            span,
            columns: None,
            rows: Vec::new(),
            outcome: None,
        });
    }

    fn columns(&mut self, columns: Vec<Column>) {
        self.current().columns = Some(columns);
    }

    fn row(&mut self, row: &dyn RowView) {
        let cells = (0..row.len())
            .map(|i| row.get(i).map(str::to_owned))
            .collect();
        self.current().rows.push(cells);
    }

    fn statement_finished(&mut self, outcome: StatementOutcome) {
        self.current().outcome = Some(outcome);
    }
}

const ALL: ExecuteOptions = ExecuteOptions { row_cap: None };

async fn run(
    conn: &Connection,
    script: &str,
    options: ExecuteOptions,
) -> (Collected, Result<(), Error>) {
    let mut sink = Collected::default();
    let result = conn
        .execute(script, options, &mut sink, &CancellationToken::new())
        .await;
    (sink, result)
}

async fn run_ok(conn: &Connection, script: &str) -> Collected {
    let (sink, result) = run(conn, script, ALL).await;
    result.unwrap_or_else(|err| panic!("{script}: {err:?}"));
    sink
}

fn cells(row: &[Option<String>]) -> Vec<Option<&str>> {
    row.iter().map(Option::as_deref).collect()
}

/// The SQL each engine spells differently.
struct Dialect {
    /// A query returning the integers 1..=n in one column.
    series: fn(u64) -> String,
    /// A query that runs for many seconds unless cancelled.
    slow: &'static str,
    /// The schema the catalog tests create objects in.
    schema: String,
    /// DDL creating `schema` (empty if it always exists).
    create_schema: String,
    /// DDL dropping it again (empty if nothing to clean up).
    drop_schema: String,
}

// ---------------------------------------------------------------------------
// The checks

async fn literals_nulls_and_unicode(conn: &Connection) {
    let out = run_ok(
        conn,
        "SELECT 1 AS one, NULL AS missing, 'héllo 🚀' AS greeting",
    )
    .await;
    let result = out.only();
    let names: Vec<_> = result
        .columns
        .as_ref()
        .expect("columns")
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["one", "missing", "greeting"]);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(cells(&result.rows[0]), [Some("1"), None, Some("héllo 🚀")]);
    let outcome = result.outcome.as_ref().expect("finished");
    assert_eq!(
        (outcome.rows_returned, outcome.capped, outcome.rows_affected),
        (1, false, None)
    );
}

async fn statements_run_in_order_with_spans(conn: &Connection) {
    let script = "SELECT 1 AS a;\n  SELECT 2 AS b ; ";
    let out = run_ok(conn, script).await;
    assert_eq!(out.statements.len(), 2);
    for (i, statement) in out.statements.iter().enumerate() {
        assert_eq!(statement.index, i);
        assert!(statement.outcome.is_some());
    }
    assert_eq!(
        &script[out.statements[0].span.start..out.statements[0].span.end],
        "SELECT 1 AS a"
    );
    assert_eq!(
        &script[out.statements[1].span.start..out.statements[1].span.end],
        "SELECT 2 AS b"
    );
    assert_eq!(cells(&out.statements[1].rows[0]), [Some("2")]);
}

async fn the_row_cap_keeps_rows_and_says_so(conn: &Connection, dialect: &Dialect) {
    let query = (dialect.series)(1000);

    let (out, result) = run(conn, &query, ExecuteOptions { row_cap: Some(10) }).await;
    result.expect("runs");
    let capped = out.only();
    assert_eq!(capped.rows.len(), 10);
    assert_eq!(cells(&capped.rows[9]), [Some("10")]);
    let outcome = capped.outcome.as_ref().expect("finished");
    assert!(outcome.capped);
    assert_eq!(outcome.rows_returned, 10);

    // Exactly as many rows as the cap is not capped.
    let (out, result) = run(
        conn,
        &query,
        ExecuteOptions {
            row_cap: Some(1000),
        },
    )
    .await;
    result.expect("runs");
    assert!(!out.only().outcome.as_ref().expect("finished").capped);

    // After a capped result the connection is clean for the next statement.
    let out = run_ok(conn, "SELECT 42 AS answer").await;
    assert_eq!(cells(&out.only().rows[0]), [Some("42")]);
}

async fn syntax_errors_point_at_the_token(conn: &Connection) {
    let (_, result) = run(conn, "SELECT 'é', 1 FROMM t", ALL).await;
    match result {
        // Both engines point at a character within the statement; exactly
        // which token differs, so only the range is checked.
        Err(Error::Query {
            position: Some(position),
            ..
        }) => assert!((1..=21).contains(&position), "{position}"),
        other => panic!("{other:?}"),
    }
}

async fn errors_stop_the_script(conn: &Connection) {
    let (out, result) = run(
        conn,
        "SELECT 1; SELECT * FROM no_such_table_qs; SELECT 3",
        ALL,
    )
    .await;
    let err = result.expect_err("fails");
    assert!(matches!(err, Error::Query { .. }), "{err:?}");
    assert!(err.to_string().contains("no_such_table_qs"), "{err}");
    assert_eq!(out.statements.len(), 2, "the third statement never started");
    assert!(out.statements[0].outcome.is_some());
    assert!(out.statements[1].outcome.is_none());
}

async fn cancel_stops_a_running_statement(conn: &Connection, dialect: &Dialect) {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        trigger.cancel();
    });
    let started = Instant::now();
    let mut sink = Collected::default();
    let result = conn.execute(dialect.slow, ALL, &mut sink, &cancel).await;
    assert_eq!(result, Err(Error::Cancelled));
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );

    let out = run_ok(conn, "SELECT 7 AS after_cancel").await;
    assert_eq!(cells(&out.only().rows[0]), [Some("7")]);
}

async fn catalog_lists_what_was_created(conn: &Connection, dialect: &Dialect) {
    let schema = &dialect.schema;
    if !dialect.create_schema.is_empty() {
        run_ok(conn, &dialect.create_schema).await;
    }
    run_ok(
        conn,
        &format!(
            "CREATE TABLE {schema}.qs_parent (id INTEGER NOT NULL, region TEXT NOT NULL, note TEXT DEFAULT 'none', \
             PRIMARY KEY (region, id));\
             CREATE VIEW {schema}.qs_view AS SELECT id FROM {schema}.qs_parent"
        ),
    )
    .await;

    assert!(conn.schemas().await.expect("schemas").contains(schema));
    let objects = conn.objects(schema).await.expect("objects");
    let find = |name: &str| objects.iter().find(|o| o.name == name).map(|o| o.kind);
    assert_eq!(find("qs_parent"), Some(ObjectKind::Table), "{objects:?}");
    assert_eq!(find("qs_view"), Some(ObjectKind::View), "{objects:?}");

    let columns = conn.columns(schema, "qs_parent").await.expect("columns");
    let summary: Vec<_> = columns
        .iter()
        .map(|c| (c.name.as_str(), c.nullable, c.primary_key_position))
        .collect();
    assert_eq!(
        summary,
        [
            ("id", false, Some(2)),
            ("region", false, Some(1)),
            ("note", true, None)
        ]
    );
    assert!(
        columns[2]
            .default
            .as_deref()
            .is_some_and(|d| d.contains("none")),
        "{columns:?}"
    );

    // A foreign key, with and without naming the referred columns (SQLite
    // fills them in from the primary key; Postgres needs them qualified).
    let parent = if schema == "main" {
        "qs_parent".to_owned()
    } else {
        format!("{schema}.qs_parent (region, id)")
    };
    run_ok(
        conn,
        &format!(
            "CREATE TABLE {schema}.qs_child (cid INTEGER PRIMARY KEY, pregion TEXT, pid INTEGER, \
             FOREIGN KEY (pregion, pid) REFERENCES {parent})"
        ),
    )
    .await;
    let keys = conn.foreign_keys(schema).await.expect("foreign keys");
    let key = keys
        .iter()
        .find(|k| k.table == "qs_child")
        .unwrap_or_else(|| panic!("{keys:?}"));
    assert_eq!(key.columns, ["pregion", "pid"]);
    assert_eq!(
        (key.ref_schema.as_str(), key.ref_table.as_str()),
        (schema.as_str(), "qs_parent")
    );
    assert_eq!(key.ref_columns, ["region", "id"]);

    // Explain plans without running, and refuses a second statement.
    let plan = conn
        .explain(&format!(
            "SELECT * FROM {schema}.qs_child c JOIN {schema}.qs_parent p ON p.id = c.pid;"
        ))
        .await
        .expect("explain");
    assert!(!plan.roots.is_empty() && !plan.raw.is_empty(), "{plan:?}");
    let deleted = conn
        .explain(&format!("SELECT 1; DELETE FROM {schema}.qs_parent"))
        .await;
    assert!(deleted.is_err());
    let delete_plan = conn
        .explain(&format!("DELETE FROM {schema}.qs_child"))
        .await
        .expect("explain a delete");
    assert!(!delete_plan.roots.is_empty());
    run_ok(
        conn,
        &format!("INSERT INTO {schema}.qs_parent (id, region) VALUES (1, 'eu')"),
    )
    .await;
    run_ok(
        conn,
        &format!("INSERT INTO {schema}.qs_child VALUES (1, 'eu', 1)"),
    )
    .await;
    conn.explain(&format!("DELETE FROM {schema}.qs_child"))
        .await
        .expect("explain");
    let count = run_ok(conn, &format!("SELECT count(*) FROM {schema}.qs_child")).await;
    assert_eq!(
        cells(&count.only().rows[0]),
        [Some("1")],
        "explain ran nothing"
    );

    // Result columns resolve to the table columns they come from.
    let out = run_ok(
        conn,
        &format!("SELECT note AS renamed, id + 1 AS computed FROM {schema}.qs_parent"),
    )
    .await;
    let columns = out.only().columns.clone().expect("columns");
    let sources = conn.resolve_sources(&columns).await.expect("sources");
    assert_eq!(
        sources,
        [
            Some(SourceColumn {
                schema: schema.clone(),
                table: "qs_parent".to_owned(),
                column: "note".to_owned(),
            }),
            None
        ]
    );

    // DDL reads back what was created.
    let ddl = conn
        .ddl(schema, "qs_child", ObjectKind::Table)
        .await
        .expect("ddl");
    assert!(ddl.contains("qs_child") && ddl.contains("pregion"), "{ddl}");
    assert!(ddl.to_ascii_uppercase().contains("REFERENCES"), "{ddl}");
    let view = conn
        .ddl(schema, "qs_view", ObjectKind::View)
        .await
        .expect("view ddl");
    assert!(view.to_ascii_uppercase().contains("VIEW"), "{view}");
    run_ok(conn, &format!("DROP TABLE {schema}.qs_child")).await;

    if !dialect.drop_schema.is_empty() {
        run_ok(conn, &dialect.drop_schema).await;
    }
}

async fn writes_report_rows_affected(conn: &Connection, dialect: &Dialect) {
    let table = format!("{}.qs_writes", dialect.schema);
    if !dialect.create_schema.is_empty() {
        run_ok(conn, &dialect.create_schema).await;
    }
    let out = run_ok(
        conn,
        &format!(
            "CREATE TABLE {table} (n INTEGER); INSERT INTO {table} VALUES (1), (2), (3); \
             UPDATE {table} SET n = n + 1 WHERE n > 1; DELETE FROM {table}"
        ),
    )
    .await;
    let affected: Vec<_> = out
        .statements
        .iter()
        .map(|s| s.outcome.as_ref().expect("finished").rows_affected)
        .collect();
    assert_eq!(affected, [Some(0), Some(3), Some(2), Some(3)]);
    if !dialect.drop_schema.is_empty() {
        run_ok(conn, &dialect.drop_schema).await;
    }
}

async fn conformance(conn: &Connection, dialect: &Dialect) {
    literals_nulls_and_unicode(conn).await;
    statements_run_in_order_with_spans(conn).await;
    the_row_cap_keeps_rows_and_says_so(conn, dialect).await;
    errors_stop_the_script(conn).await;
    syntax_errors_point_at_the_token(conn).await;
    cancel_stops_a_running_statement(conn, dialect).await;
    catalog_lists_what_was_created(conn, dialect).await;
    writes_report_rows_affected(conn, dialect).await;
}

// ---------------------------------------------------------------------------
// SQLite

fn sqlite_dialect() -> Dialect {
    Dialect {
        series: |n| {
            format!(
                "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < {n}) SELECT n FROM g"
            )
        },
        slow: "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g) SELECT count(*) FROM g",
        schema: "main".to_owned(),
        create_schema: String::new(),
        drop_schema: String::new(),
    }
}

async fn sqlite() -> Connection {
    let mut config = ConnectionConfig::new(Engine::Sqlite);
    config.path = Some(":memory:".into());
    Connection::connect(&config).await.expect("opens")
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_conformance() {
    conformance(&sqlite().await, &sqlite_dialect()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_types_and_sources() {
    let conn = sqlite().await;
    run_ok(
        &conn,
        "CREATE TABLE t (i INTEGER PRIMARY KEY, r REAL, s TEXT, b BLOB, d DECIMAL(10,2), flag BOOLEAN)",
    )
    .await;
    run_ok(
        &conn,
        "INSERT INTO t VALUES (1, 2.5, 'x', x'00ff', 9.99, 1)",
    )
    .await;
    let out = run_ok(
        &conn,
        "SELECT i, r, s, b, d, flag, i + 1 AS computed FROM t",
    )
    .await;
    let result = out.only();
    let columns = result.columns.as_ref().expect("columns");
    let tags: Vec<_> = columns.iter().map(|c| c.type_tag).collect();
    assert_eq!(
        tags,
        [
            TypeTag::Integer,
            TypeTag::Float,
            TypeTag::Text,
            TypeTag::Bytes,
            TypeTag::Decimal,
            TypeTag::Bool,
            TypeTag::Other
        ]
    );
    assert!(columns[0].source.is_some());
    assert!(
        columns[6].source.is_none(),
        "a computed column has no source"
    );
    assert_eq!(
        cells(&result.rows[0]),
        [
            Some("1"),
            Some("2.5"),
            Some("x"),
            Some("\\x00ff"),
            Some("9.99"),
            Some("1"),
            Some("2")
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_refuses_to_create_a_missing_file_unless_asked() {
    let path = std::env::temp_dir().join(format!("qs-missing-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut config = ConnectionConfig::new(Engine::Sqlite);
    config.path = Some(path.clone());
    assert!(matches!(
        Connection::connect(&config).await,
        Err(Error::Connect { .. })
    ));
    config.options.insert("create".into(), "true".into());
    Connection::connect(&config).await.expect("creates");
    assert!(path.exists());
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_read_only_refuses_writes_but_reads() {
    let path = std::env::temp_dir().join(format!("qs-read-only-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut config = ConnectionConfig::new(Engine::Sqlite);
    config.path = Some(path.clone());
    config.options.insert("create".into(), "true".into());
    {
        let writable = Connection::connect(&config).await.expect("creates");
        run_ok(
            &writable,
            "CREATE TABLE t (a INT); INSERT INTO t VALUES (1)",
        )
        .await;
    }
    config.options.clear();
    config.read_only = true;
    let conn = Connection::connect(&config).await.expect("opens");
    assert_eq!(run_ok(&conn, "SELECT a FROM t").await.only().rows.len(), 1);
    let (_, result) = run(&conn, "INSERT INTO t VALUES (2)", ALL).await;
    assert!(matches!(result, Err(Error::Query { .. })), "{result:?}");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// PostgreSQL (live)

fn postgres_url() -> String {
    std::env::var("QS_TEST_POSTGRES_URL").unwrap_or_else(|_| {
        "postgresql://quicksilver:quicksilver@127.0.0.1:15432/quicksilver_dev?sslmode=disable"
            .to_owned()
    })
}

async fn postgres() -> Connection {
    let config = ConnectionConfig::from_url(&postgres_url()).expect("valid URL");
    Connection::connect(&config).await.expect("connects")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_conformance() {
    let schema = format!("qs_conformance_{}", std::process::id());
    let dialect = Dialect {
        series: |n| format!("SELECT g FROM generate_series(1, {n}) AS g"),
        slow: "SELECT pg_sleep(30)",
        create_schema: format!("CREATE SCHEMA IF NOT EXISTS {schema}"),
        drop_schema: format!("DROP SCHEMA {schema} CASCADE"),
        schema,
    };
    conformance(&postgres().await, &dialect).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_read_only_refuses_writes_but_reads() {
    let mut config = ConnectionConfig::from_url(&postgres_url()).expect("valid URL");
    config.read_only = true;
    let conn = Connection::connect(&config).await.expect("connects");
    assert_eq!(run_ok(&conn, "SELECT 1").await.only().rows.len(), 1);
    let (_, result) = run(&conn, "CREATE TEMP TABLE qs_ro (a int)", ALL).await;
    let Err(Error::Query { code, .. }) = result else {
        panic!("expected a query error, got {result:?}");
    };
    // read_only_sql_transaction
    assert_eq!(code.as_deref(), Some("25006"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_renders_types_as_the_server_does() {
    let conn = postgres().await;
    let out = run_ok(
        &conn,
        "SELECT id, a_bool, a_bigint, a_numeric, a_double, a_bytea, a_timestamptz, a_interval, a_uuid, \
                a_jsonb, a_int_array, a_inet, a_point \
         FROM public.type_zoo ORDER BY id",
    )
    .await;
    let result = out.only();
    let columns = result.columns.as_ref().expect("columns");
    let described: Vec<_> = columns
        .iter()
        .map(|c| (c.type_tag, c.db_type.as_str()))
        .collect();
    assert_eq!(
        described,
        [
            (TypeTag::Integer, "int4"),
            (TypeTag::Bool, "bool"),
            (TypeTag::Integer, "int8"),
            (TypeTag::Decimal, "numeric"),
            (TypeTag::Float, "float8"),
            (TypeTag::Bytes, "bytea"),
            (TypeTag::TimestampTz, "timestamptz"),
            (TypeTag::Interval, "interval"),
            (TypeTag::Uuid, "uuid"),
            (TypeTag::Json, "jsonb"),
            (TypeTag::Array, "int4[]"),
            (TypeTag::Network, "inet"),
            (TypeTag::Other, "point"),
        ]
    );
    assert!(
        columns.iter().all(|c| c.source.is_some()),
        "every column comes from type_zoo"
    );

    let first = cells(&result.rows[0]);
    assert_eq!(first[1], Some("t"));
    assert_eq!(first[2], Some("9223372036854775807"));
    // An exact numeric is never squeezed through a float.
    assert_eq!(first[3], Some("12345678901234567890.123456789"));
    assert_eq!(first[5], Some("\\xdeadbeef"));
    assert_eq!(first[10], Some("{1,2,3}"));
    let second = cells(&result.rows[1]);
    assert_eq!(second[4], Some("-Infinity"));
    assert_eq!(second[1], None);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_catalog_sees_the_seed() {
    let conn = postgres().await;
    let databases = conn.databases().await.expect("databases");
    for expected in ["analytics", "quicksilver_dev", "staging"] {
        assert!(databases.iter().any(|d| d == expected), "{databases:?}");
    }
    let objects = conn.objects("sales").await.expect("objects");
    let kind = |name: &str| objects.iter().find(|o| o.name == name).map(|o| o.kind);
    assert_eq!(kind("accounts"), Some(ObjectKind::Table));
    assert_eq!(kind("paid_orders"), Some(ObjectKind::View));
    assert_eq!(
        kind("revenue_by_country"),
        Some(ObjectKind::MaterializedView)
    );
    assert_eq!(kind("account_total"), Some(ObjectKind::Function));
    let items = conn.columns("sales", "order_items").await.expect("columns");
    let keys: Vec<_> = items
        .iter()
        .map(|c| (c.name.as_str(), c.primary_key_position))
        .collect();
    assert_eq!(&keys[..2], [("order_id", Some(1)), ("line", Some(2))]);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_errors_carry_code_and_position() {
    let conn = postgres().await;
    let (_, result) = run(&conn, "SELECT 1 FROM sales.accounts WHERE nope = 1", ALL).await;
    match result {
        Err(Error::Query { code, position, .. }) => {
            assert_eq!(code.as_deref(), Some("42703"), "undefined column");
            assert_eq!(position, Some(36));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_wrong_password_is_a_connect_error() {
    let mut config = ConnectionConfig::from_url(&postgres_url()).expect("valid URL");
    config.password = Some("definitely-wrong".into());
    match Connection::connect(&config).await {
        Err(Error::Connect { message }) => assert!(message.contains("password"), "{message}"),
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("connected with a wrong password"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_refuses_tls_the_server_cannot_give() {
    // The dev server has no TLS, so `require` must fail rather than fall back.
    let mut config = ConnectionConfig::from_url(&postgres_url()).expect("valid URL");
    config.ssl_mode = qs_core::SslMode::Require;
    assert!(Connection::connect(&config).await.is_err());
    // `prefer` falls back to plaintext, as it is defined to.
    config.ssl_mode = qs_core::SslMode::Prefer;
    Connection::connect(&config)
        .await
        .expect("connects in plaintext");
}
