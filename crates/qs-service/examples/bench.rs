//! Streams a large generated result through the whole service stack and
//! reports time and memory. Run it in release mode:
//!
//! ```sh
//! cargo run --release -p qs-service --example bench -- [URL] [ROWS]
//! ```
//!
//! URL defaults to an in-memory SQLite database and ROWS to 1,000,000. For
//! peak process memory, run it under `/usr/bin/time -l` (macOS) or
//! `/usr/bin/time -v` (Linux).

use std::sync::{Arc, Mutex};
use std::time::Instant;

use qs_core::{ConnectionConfig, Engine};
use qs_drivers::{CancellationToken, ExecuteOptions};
use qs_service::{RunEvent, Service};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args
        .next()
        .unwrap_or_else(|| "sqlite:///:memory:".to_owned());
    let rows: u64 = args
        .next()
        .map(|n| n.parse())
        .transpose()?
        .unwrap_or(1_000_000);

    let config = if url == "sqlite:///:memory:" {
        let mut config = ConnectionConfig::new(Engine::Sqlite);
        config.path = Some(":memory:".into());
        config
    } else {
        ConnectionConfig::from_url(&url)?
    };
    let query = match config.engine {
        Engine::Postgres => format!(
            "SELECT g AS id, 'row ' || g AS label, g * 1.5 AS amount, \
                    timestamptz '2025-01-01' + g * interval '1 second' AS at \
             FROM generate_series(1, {rows}) AS g"
        ),
        _ => format!(
            "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < {rows}) \
             SELECT n AS id, 'row ' || n AS label, n * 1.5 AS amount, \
                    datetime('2025-01-01', '+' || n || ' seconds') AS at FROM g"
        ),
    };

    let service = Service::new();
    let started = Instant::now();
    let session = service.connect(&config).await?;
    let connected = started.elapsed();

    let first_row = Arc::new(Mutex::new(None));
    let result_id = Arc::new(Mutex::new(None));
    let (first, id) = (first_row.clone(), result_id.clone());
    let run_started = Instant::now();
    service
        .run(
            session.id,
            &query,
            ExecuteOptions { row_cap: None },
            &CancellationToken::new(),
            move |event| match event {
                RunEvent::ResultStarted { result_id, .. } => {
                    *id.lock().expect("lock") = Some(result_id)
                }
                RunEvent::Progress { .. } => {
                    first
                        .lock()
                        .expect("lock")
                        .get_or_insert(run_started.elapsed());
                }
                RunEvent::Failed { error, .. } => eprintln!("failed: {error}"),
                _ => {}
            },
        )
        .await?;
    let streamed = run_started.elapsed();

    let result = result_id
        .lock()
        .expect("lock")
        .ok_or("the query returned no result")?;
    let info = service.result_info(result)?;

    let pages = 200u64;
    let page_rows = 200u32;
    let paging = Instant::now();
    let mut bytes = 0usize;
    for i in 0..pages {
        // Spread the pages over the whole result, as scrolling would.
        let offset = (info.rows.saturating_sub(u64::from(page_rows))) * i / pages;
        bytes += service.page(result, offset, page_rows)?.len();
    }
    let paged = paging.elapsed();

    println!("engine          {}", config.engine.display_name());
    println!("connect         {connected:.2?}");
    println!("rows            {}", info.rows);
    println!(
        "first progress  {:.2?}",
        first_row.lock().expect("lock").unwrap_or_default()
    );
    println!(
        "all rows        {streamed:.2?}  ({:.0} rows/s)",
        info.rows as f64 / streamed.as_secs_f64()
    );
    println!(
        "store memory    {:.1} MB  ({:.1} bytes/row)",
        info.bytes as f64 / 1e6,
        info.bytes as f64 / info.rows.max(1) as f64
    );
    println!(
        "page fetch      {:.1?} per {page_rows}-row page  ({:.1} KB each)",
        paged / pages as u32,
        bytes as f64 / pages as f64 / 1e3
    );
    Ok(())
}
