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
