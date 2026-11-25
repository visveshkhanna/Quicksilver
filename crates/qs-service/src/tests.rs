use std::sync::{Arc, Mutex};
use std::time::Duration;

use qs_core::{ConnectionConfig, Engine, Error};
use qs_drivers::{CancellationToken, ExecuteOptions};

use super::*;

fn memory() -> ConnectionConfig {
    let mut config = ConnectionConfig::new(Engine::Sqlite);
    config.path = Some(":memory:".into());
    config
}

fn recorder() -> (
    Arc<Mutex<Vec<RunEvent>>>,
    impl Fn(RunEvent) + Send + Sync + Clone + 'static,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (events, move |event| sink.lock().expect("lock").push(event))
}

const SERIES: &str = "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 2500) SELECT n, 'row ' || n FROM g";

#[test]
fn app_info_lists_every_engine_with_the_workspace_version() {
    let info = app_info();
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(info.engines.len(), Engine::ALL.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_reports_events_in_order_and_results_can_be_paged() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects");
    let (events, sink) = recorder();
    service
        .run(
            session.id,
            &format!("CREATE TABLE t (a INT); {SERIES}"),
            ExecuteOptions { row_cap: None },
            &CancellationToken::new(),
            sink,
        )
        .await
        .expect("runs");

    let events = events.lock().expect("lock").clone();
    let kinds: Vec<_> = events
        .iter()
        .filter(|e| !matches!(e, RunEvent::Progress { .. }))
        .map(|e| match e {
            RunEvent::StatementStarted { index, .. } => format!("start {index}"),
            RunEvent::ResultStarted { index, .. } => format!("result {index}"),
            RunEvent::StatementFinished { index, .. } => format!("finish {index}"),
            RunEvent::Finished { .. } => "done".to_owned(),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "start 0", "finish 0", "start 1", "result 1", "finish 1", "done"
        ]
    );

    let result_id = events
        .iter()
        .find_map(|e| match e {
            RunEvent::ResultStarted { result_id, .. } => Some(*result_id),
            _ => None,
        })
        .expect("a result");
    let info = service.result_info(result_id).expect("info");
    assert_eq!(info.rows, 2500);
    assert_eq!(info.columns.len(), 2);

    let page = service.page(result_id, 2498, 50).expect("page");
    assert_eq!(&page[..4], store::PAGE_MAGIC);
    assert_eq!(
        u32::from_le_bytes(page[4..8].try_into().expect("4")),
        2,
        "clamped to the last two rows"
    );

    // Pages are capped at MAX_PAGE_ROWS whatever the caller asks for.
    let big = service.page(result_id, 0, u32::MAX).expect("page");
    assert_eq!(u32::from_le_bytes(big[4..8].try_into().expect("4")), 2500);

    service.close_result(result_id);
    assert!(service.page(result_id, 0, 1).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_statement_ends_the_run_with_its_index() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects");
    let (events, sink) = recorder();
    service
        .run(
            session.id,
            "SELECT 1; SELECT nope FROM missing; SELECT 3",
            ExecuteOptions { row_cap: None },
            &CancellationToken::new(),
            sink,
        )
        .await
        .expect("runs");
    let last = events.lock().expect("lock").last().cloned();
    match last {
        Some(RunEvent::Failed {
            index: Some(1),
            error: Error::Query { .. },
        }) => {}
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_background_run_can_be_cancelled() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects");
    let (events, sink) = recorder();
    let run = service
        .start_run(
            session.id,
            "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g) SELECT count(*) FROM g".into(),
            ExecuteOptions { row_cap: None },
            false,
            sink,
        )
        .expect("starts");
    tokio::time::sleep(Duration::from_millis(200)).await;
    service.cancel(run);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(RunEvent::Failed { error, .. }) = events.lock().expect("lock").last() {
            assert_eq!(*error, Error::Cancelled);
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the run did not stop"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_row_cap_is_reported_on_the_statement() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects");
    let (events, sink) = recorder();
    service
        .run(
            session.id,
            SERIES,
            ExecuteOptions { row_cap: Some(100) },
            &CancellationToken::new(),
            sink,
        )
        .await
        .expect("runs");
    let finished = events.lock().expect("lock").iter().find_map(|e| match e {
        RunEvent::StatementFinished {
            outcome,
            result_id: Some(id),
            ..
        } => Some((outcome.clone(), *id)),
        _ => None,
    });
    let (outcome, id) = finished.expect("finished");
    assert!(outcome.capped);
    assert_eq!(service.result_info(id).expect("info").rows, 100);
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_sessions_are_errors() {
    let service = Service::new();
    assert!(service.schemas(42).await.is_err());
    assert!(
        service
            .start_run(
                42,
                "SELECT 1".into(),
                ExecuteOptions { row_cap: None },
                false,
                |_| {}
            )
            .is_err()
    );
}

#[test]
fn durations_serialize_as_milliseconds() {
    let json = serde_json::to_value(RunEvent::Finished {
        elapsed: Duration::from_micros(1500),
    })
    .expect("serializes");
    assert_eq!(
        json,
        serde_json::json!({ "event": "finished", "elapsedMs": 1.5 })
    );
}

#[test]
fn events_serialize_with_camel_case_tags() {
    let json = serde_json::to_value(RunEvent::Progress {
        result_id: 3,
        rows: 10,
    })
    .expect("serializes");
    assert_eq!(
        json,
        serde_json::json!({ "event": "progress", "resultId": 3, "rows": 10 })
    );
}

#[test]
fn the_statement_at_the_cursor_is_found_in_utf16_offsets() {
    // "é" and the emoji are 1 and 2 UTF-16 units but 2 and 4 bytes.
    let script = "select 'é😀';\nselect 2;";
    let second = script.encode_utf16().count() - 3;
    let first = statement_at(script, Engine::Postgres, 2).expect("first");
    assert_eq!((first.start, first.end), (0, 12));
    let next = statement_at(script, Engine::Postgres, second).expect("second");
    let text: String =
        String::from_utf16_lossy(&script.encode_utf16().collect::<Vec<_>>()[next.start..next.end]);
    assert_eq!(text, "select 2");
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_say_which_database_they_are_in() {
    let service = Service::new();
    let info = service.connect(&memory()).await.expect("connects");
    assert_eq!(info.database.as_deref(), Some("main"));
    assert!(!info.read_only);
    service.test(&memory()).await.expect("test connects");
}

/// Runs `script` and returns the id of the last result it produced.
async fn last_result(service: &Service, session: SessionId, script: &str) -> ResultId {
    let (events, sink) = recorder();
    service
        .run(
            session,
            script,
            ExecuteOptions { row_cap: None },
            &CancellationToken::new(),
            sink,
        )
        .await
        .expect("runs");
    events
        .lock()
        .expect("lock")
        .iter()
        .rev()
        .find_map(|e| match e {
            RunEvent::ResultStarted { result_id, .. } => Some(*result_id),
            _ => None,
        })
        .expect("a result")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_result_sorts_and_copies_what_is_shown() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects").id;
    let result = last_result(
        &service,
        session,
        "CREATE TABLE p (id INTEGER, name TEXT); \
         INSERT INTO p VALUES (2, 'b'), (10, 'c'), (1, NULL); \
         SELECT id, name FROM p",
    )
    .await;

    service
        .sort_result(result, Some((0, SortDirection::Descending)))
        .expect("sorts");
    let tsv = service
        .copy_rows(result, 0, 2, &[1, 0], CopyFormat::Tsv { header: true })
        .expect("copies");
    assert_eq!(tsv, "name\tid\nc\t10\nb\t2\n");
    let sql = service
        .copy_rows(
            result,
            2,
            5,
            &[0, 1],
            CopyFormat::Insert {
                table: "\"p\"".into(),
            },
        )
        .expect("copies");
    assert_eq!(
        sql,
        "INSERT INTO \"p\" (\"id\", \"name\") VALUES (1, NULL);\n"
    );
    assert!(
        service
            .copy_rows(result, 0, 1, &[9], CopyFormat::Json)
            .is_err()
    );

    service.sort_result(result, None).expect("unsorts");
    let json = service
        .copy_rows(result, 0, 1, &[0], CopyFormat::Json)
        .expect("copies");
    assert_eq!(json, "[\n  {\"id\": 2}\n]\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn explain_and_ddl_go_through_the_session() {
    let service = Service::new();
    let session = service.connect(&memory()).await.expect("connects").id;
    last_result(
        &service,
        session,
        "CREATE TABLE a (id INTEGER PRIMARY KEY); \
         CREATE TABLE b (id INTEGER, a_id INTEGER REFERENCES a (id)); SELECT 1",
    )
    .await;
    let plan = service
        .explain(session, "SELECT * FROM b JOIN a ON a.id = b.a_id")
        .await
        .expect("explains");
    assert!(!plan.roots.is_empty());
    let keys = service.foreign_keys(session, "main").await.expect("keys");
    assert_eq!(keys.len(), 1);
    assert_eq!(
        (keys[0].table.as_str(), keys[0].ref_table.as_str()),
        ("b", "a")
    );
    let ddl = service
        .ddl(session, "main", "b", ObjectKind::Table)
        .await
        .expect("ddl");
    assert!(ddl.starts_with("CREATE TABLE b"), "{ddl}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_large_result_spills_by_the_services_policy() {
    let dir = tempfile::tempdir().expect("dir");
    let service = Service::with_spill(SpillPolicy {
        threshold: Some(0),
        dir: Some(dir.path().to_owned()),
    });
    let session = service.connect(&memory()).await.expect("connects").id;
    let result = last_result(
        &service,
        session,
        "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 150000) \
         SELECT n, 'row ' || n FROM g",
    )
    .await;
    let info = service.result_info(result).expect("info");
    assert_eq!(info.rows, 150_000);
    assert!(info.spilled_bytes > 0, "{info:?}");
    let csv = service
        .copy_rows(result, 149_998, 10, &[1], CopyFormat::Csv { header: false })
        .expect("copies");
    assert_eq!(csv, "row 149999\r\nrow 150000\r\n");
    let tsv = service
        .copy_rows(result, 10, 1, &[1], CopyFormat::Tsv { header: false })
        .expect("copies spilled rows");
    assert_eq!(tsv, "row 11\n");
}

// --- Editing -------------------------------------------------------------------

async fn rows_of(service: &Service, session: SessionId, sql: &str) -> Vec<Vec<Option<String>>> {
    let result = last_result(service, session, sql).await;
    let mut out = Vec::new();
    let store = service.result(result).expect("result");
    let all: Vec<usize> = (0..store.columns().len()).collect();
    store
        .rows(0, u64::MAX, &all, |row| {
            out.push(
                (0..row.len())
                    .map(|i| row.get(i).map(str::to_owned))
                    .collect(),
            );
        })
        .expect("rows");
    out
}

fn set(column: usize, value: Option<&str>) -> CellValue {
    CellValue {
        column,
        value: value.map(str::to_owned),
    }
}

async fn people(service: &Service) -> SessionId {
    let session = service.connect(&memory()).await.expect("connects").id;
    last_result(
        service,
        session,
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, score REAL); \
         INSERT INTO people VALUES (1, 'ann', 1.5), (2, 'bob', NULL), (3, 'cy', 3); \
         CREATE TABLE tags (label TEXT, n INTEGER); \
         INSERT INTO tags VALUES ('a', 1), ('a', 1), ('b', 2); SELECT 1",
    )
    .await;
    session
}

#[tokio::test(flavor = "multi_thread")]
async fn says_which_results_can_be_edited_and_why_not() {
    let service = Service::new();
    let session = people(&service).await;
    let target = |sql: &'static str| {
        let service = service.clone();
        async move {
            let result = last_result(&service, session, sql).await;
            service.edit_target(result).await.expect("target")
        }
    };
    let by_key = target("SELECT name, id FROM people").await;
    assert_eq!(by_key.reason, None);
    assert!(by_key.by_primary_key);
    assert_eq!(by_key.key, [1]);
    assert_eq!(by_key.table.as_deref(), Some("people"));

    let by_values = target("SELECT * FROM tags").await;
    assert_eq!(by_values.reason, None);
    assert!(!by_values.by_primary_key);
    assert_eq!(by_values.key, [0, 1]);

    for (sql, why) in [
        (
            "SELECT name FROM people",
            "primary key column id is not in the result",
        ),
        ("SELECT id, upper(name) FROM people", "computed"),
        (
            "SELECT p.id, t.label FROM people p, tags t",
            "more than one table",
        ),
        ("SELECT label FROM tags", "no primary key"),
        ("SELECT id, id FROM people", "appears twice"),
    ] {
        let reason = target(sql).await.reason.unwrap_or_default();
        assert!(reason.contains(why), "{sql}: {reason}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn applies_updates_inserts_and_deletes_in_one_transaction() {
    let service = Service::new();
    let session = people(&service).await;
    let result = last_result(&service, session, "SELECT * FROM people ORDER BY id").await;
    // Sorted for display, edits still name rows by where they arrived.
    service
        .sort_result(result, Some((0, SortDirection::Descending)))
        .expect("sorts");
    let edits = [
        RowEdit::Update {
            row: 0,
            set: vec![set(1, Some("O'Brien")), set(2, None)],
        },
        RowEdit::Delete { row: 2 },
        RowEdit::Insert {
            values: vec![set(0, Some("9")), set(1, Some("zed"))],
        },
    ];
    let preview = service
        .preview_edits(result, &edits)
        .await
        .expect("previews");
    assert_eq!(
        preview,
        [
            "UPDATE \"people\" SET \"name\" = 'O''Brien', \"score\" = NULL WHERE \"id\" = 1",
            "DELETE FROM \"people\" WHERE \"id\" = 3",
            "INSERT INTO \"people\" (\"id\", \"name\") VALUES (9, 'zed')",
        ]
    );
    // A preview runs nothing.
    assert_eq!(
        rows_of(&service, session, "SELECT count(*) FROM people").await[0][0].as_deref(),
        Some("3")
    );

    let ran = service.apply_edits(result, &edits).await.expect("applies");
    assert_eq!(ran, preview);
    let after = rows_of(
        &service,
        session,
        "SELECT id, name, score FROM people ORDER BY id",
    )
    .await;
    let s = |v: &str| Some(v.to_owned());
    assert_eq!(
        after,
        [
            vec![s("1"), s("O'Brien"), None],
            vec![s("2"), s("bob"), None],
            vec![s("9"), s("zed"), None],
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_saved_unless_every_change_hits_exactly_one_row() {
    let service = Service::new();
    let session = people(&service).await;

    // Two identical rows cannot be told apart, so editing one changes both
    // and the whole transaction is rolled back.
    let tags = last_result(&service, session, "SELECT label, n FROM tags").await;
    let err = service
        .apply_edits(
            tags,
            &[
                RowEdit::Update {
                    row: 2,
                    set: vec![set(0, Some("c"))],
                },
                RowEdit::Update {
                    row: 0,
                    set: vec![set(0, Some("z"))],
                },
            ],
        )
        .await
        .expect_err("refused");
    assert!(err.to_string().contains("2 rows instead of one"), "{err}");
    let labels = rows_of(&service, session, "SELECT label FROM tags ORDER BY label").await;
    assert_eq!(
        labels.concat(),
        [Some("a".into()), Some("a".into()), Some("b".into())]
    );

    // A row deleted since the query ran matches nothing.
    let result = last_result(&service, session, "SELECT * FROM people").await;
    last_result(
        &service,
        session,
        "DELETE FROM people WHERE id = 2; SELECT 1",
    )
    .await;
    let err = service
        .apply_edits(
            result,
            &[
                RowEdit::Update {
                    row: 0,
                    set: vec![set(1, Some("first"))],
                },
                RowEdit::Delete { row: 1 },
            ],
        )
        .await
        .expect_err("refused");
    assert!(err.to_string().contains("0 rows instead of one"), "{err}");
    assert_eq!(
        rows_of(&service, session, "SELECT name FROM people WHERE id = 1").await[0][0].as_deref(),
        Some("ann"),
        "the first change was rolled back too"
    );

    // Bad requests never reach the database.
    assert!(
        service
            .preview_edits(result, &[RowEdit::Delete { row: 99 }])
            .await
            .is_err()
    );
    assert!(
        service
            .preview_edits(
                result,
                &[RowEdit::Update {
                    row: 0,
                    set: vec![set(7, None)]
                }]
            )
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_results_cannot_be_edited() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("ro.db");
    let mut config = ConnectionConfig::new(Engine::Sqlite);
    config.path = Some(path.clone());
    config.options.insert("create".into(), "true".into());
    let service = Service::new();
    let writer = service.connect(&config).await.expect("connects").id;
    last_result(
        &service,
        writer,
        "CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); SELECT 1",
    )
    .await;
    config.read_only = true;
    let reader = service.connect(&config).await.expect("connects").id;
    let result = last_result(&service, reader, "SELECT * FROM t").await;
    let target = service.edit_target(result).await.expect("target");
    assert_eq!(
        target.reason.as_deref(),
        Some("this connection is read-only")
    );
    assert!(
        service
            .apply_edits(result, &[RowEdit::Delete { row: 0 }])
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_write_session_asks_before_changing_the_schema() {
    let service = Service::new();
    let session = service
        .connect_with(
            &memory(),
            SessionPolicy {
                confirm_schema_changes: true,
            },
        )
        .await
        .expect("connects");
    assert!(session.confirm_schema_changes);
    let refused = service
        .start_run(
            session.id,
            "SELECT 1; CREATE TABLE x (a INT); INSERT INTO x VALUES (1)".into(),
            ExecuteOptions { row_cap: None },
            false,
            |_| {},
        )
        .expect_err("asks");
    let Error::ConfirmationNeeded { statements, .. } = refused else {
        panic!("{refused:?}");
    };
    assert_eq!(statements, ["CREATE TABLE x (a INT)"]);
    // Reads and writes run without asking; confirmed, the schema change runs.
    service
        .start_run(
            session.id,
            "SELECT 1; INSERT INTO nowhere VALUES (1)".into(),
            ExecuteOptions { row_cap: None },
            false,
            |_| {},
        )
        .expect("no schema change, no question");
    service
        .start_run(
            session.id,
            "CREATE TABLE x (a INT)".into(),
            ExecuteOptions { row_cap: None },
            true,
            |_| {},
        )
        .expect("confirmed");
}

#[test]
fn the_filter_bar_query_is_built_and_gated_in_rust() {
    assert_eq!(
        filter_query(Engine::Postgres, Some("sales"), "orders", " id > 1 ;").expect("ok"),
        "SELECT * FROM \"sales\".\"orders\" WHERE id > 1;\n"
    );
    assert_eq!(
        filter_query(
            Engine::Postgres,
            Some("sales"),
            "orders",
            "order by id desc"
        )
        .expect("ok"),
        "SELECT * FROM \"sales\".\"orders\" order by id desc;\n"
    );
    assert_eq!(
        filter_query(Engine::Sqlite, Some("main"), "t", "").expect("ok"),
        "SELECT * FROM \"t\";\n"
    );
    for bad in [
        "1 = 1; DELETE FROM orders",
        "1 = 1 FOR UPDATE",
        "id > (",
        "1=1 UNION SELECT * FROM secrets",
    ] {
        assert!(
            filter_query(Engine::Postgres, Some("sales"), "orders", bad).is_err(),
            "{bad}"
        );
    }
}

fn live_postgres() -> ConnectionConfig {
    let url = std::env::var("QS_TEST_POSTGRES_URL").unwrap_or_else(|_| {
        "postgresql://quicksilver:quicksilver@127.0.0.1:15432/quicksilver_dev?sslmode=disable"
            .to_owned()
    });
    ConnectionConfig::from_url(&url).expect("valid URL")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the development Postgres (dev/compose.yaml)"]
async fn live_postgres_names_rows_by_the_values_it_printed() {
    let service = Service::new();
    let session = service
        .connect(&live_postgres())
        .await
        .expect("connects")
        .id;
    let schema = format!("qs_edit_{}", std::process::id());
    last_result(
        &service,
        session,
        &format!(
            "CREATE SCHEMA {schema}; \
             CREATE TABLE {schema}.zoo (n numeric, f float8, t timestamptz, b bytea, j jsonb, \
                 u uuid, a int[], i interval, s text); \
             INSERT INTO {schema}.zoo VALUES \
                 (12345678901234567890.123456789, 0.1, '2024-02-29 23:59:59.123456+05:30', '\\xdeadbeef', \
                  '{{\"k\": [1, \"x\"]}}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{{1,NULL,3}}', \
                  '1 day 02:03:04.5', 'it''s'), \
                 (-1, 'NaN', NULL, '\\x', 'null', NULL, '{{}}', '-1 mon', NULL); \
             SELECT 1"
        ),
    )
    .await;

    let result = last_result(
        &service,
        session,
        &format!("SELECT * FROM {schema}.zoo ORDER BY n DESC"),
    )
    .await;
    let target = service.edit_target(result).await.expect("target");
    assert_eq!(target.reason, None, "{target:?}");
    assert!(!target.by_primary_key);
    // Each row is found again by every value exactly as the server printed
    // it, so each update changes exactly one row.
    service
        .apply_edits(
            result,
            &[
                RowEdit::Update {
                    row: 0,
                    set: vec![set(8, Some("first"))],
                },
                RowEdit::Update {
                    row: 1,
                    set: vec![set(8, Some("second \\ ' \""))],
                },
            ],
        )
        .await
        .expect("both rows matched exactly once");
    let names = rows_of(
        &service,
        session,
        &format!("SELECT s FROM {schema}.zoo ORDER BY n DESC"),
    )
    .await;
    assert_eq!(
        names.concat(),
        [Some("first".into()), Some("second \\ ' \"".into())]
    );

    // Insert and delete by primary key on a keyed table.
    last_result(
        &service,
        session,
        &format!("CREATE TABLE {schema}.keyed (id bigint PRIMARY KEY, note text); INSERT INTO {schema}.keyed VALUES (1, 'a'); SELECT 1"),
    )
    .await;
    let keyed = last_result(&service, session, &format!("SELECT * FROM {schema}.keyed")).await;
    service
        .apply_edits(
            keyed,
            &[
                RowEdit::Insert {
                    values: vec![set(0, Some("2")), set(1, Some("b"))],
                },
                RowEdit::Delete { row: 0 },
            ],
        )
        .await
        .expect("applies");
    let left = rows_of(
        &service,
        session,
        &format!("SELECT id, note FROM {schema}.keyed"),
    )
    .await;
    assert_eq!(left, [vec![Some("2".into()), Some("b".into())]]);

    last_result(
        &service,
        session,
        &format!("DROP SCHEMA {schema} CASCADE; SELECT 1"),
    )
    .await;
}
