//! Editing a result's rows.
//!
//! The UI never sends SQL for an edit. It names rows by their source row
//! number and columns by index; the service reads the original row from the
//! result, generates one statement per change, checks each against the
//! table's catalog through a parse-tree gate, and runs them all in one
//! transaction that is rolled back unless every statement changed exactly
//! one row.
//!
//! A row is edited only when it can be named exactly: by its primary key, or,
//! for a table without one, by every one of its values (and then the
//! one-row check is what proves the values were unique).

use qs_core::{Column, Engine, Error, Result, TypeTag};
use qs_drivers::{
    CancellationToken, Connection, ExecuteOptions, ResultSink, RowView, Span, StatementOutcome,
};
use qs_sql::edit::{Cell, Change, TableName, generate};
use qs_sql::gate::{EditKind, EditShape, check_edit};
use qs_sql::{Dialect, StatementKind};
use serde::{Deserialize, Serialize};

use crate::store::ResultStore;

/// One column's new value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct CellValue {
    /// The result column, by index.
    pub column: usize,
    /// The value as text; `None` for NULL.
    pub value: Option<String>,
}

/// One change to a result's rows, as the UI asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RowEdit {
    /// Set cells of an existing row.
    Update {
        /// The row's source row number (its place in arrival order).
        row: u64,
        /// The new values.
        set: Vec<CellValue>,
    },
    /// Add a row; columns left out take their defaults.
    Insert {
        /// The values given.
        values: Vec<CellValue>,
    },
    /// Remove a row.
    Delete {
        /// The row's source row number.
        row: u64,
    },
}

/// Whether a result's rows can be edited, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    /// Why the rows cannot be edited; `None` when they can.
    pub reason: Option<String>,
    /// The table's schema.
    pub schema: Option<String>,
    /// The table.
    pub table: Option<String>,
    /// Whether rows are named by primary key (else by every value).
    pub by_primary_key: bool,
    /// The result columns that name a row.
    pub key: Vec<usize>,
}

impl EditTarget {
    pub(crate) fn refused_because(reason: impl Into<String>) -> Self {
        EditTarget {
            reason: Some(reason.into()),
            schema: None,
            table: None,
            by_primary_key: false,
            key: Vec::new(),
        }
    }
}

/// What the service knows about an editable result.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub(crate) table: TableName,
    /// Every column the table has.
    pub(crate) table_columns: Vec<String>,
    /// For each result column, the table column it is.
    pub(crate) column_names: Vec<String>,
    pub(crate) key: Vec<usize>,
    pub(crate) by_primary_key: bool,
}

/// Types Postgres cannot compare with `=`, so a row holding one cannot be
/// named by its values.
fn comparable(column: &Column) -> bool {
    !(column.type_tag == TypeTag::Other
        || (column.type_tag == TypeTag::Json && column.db_type == "json")
        || column.db_type == "xml")
}

/// Works out whether a result can be edited.
pub(crate) async fn target(
    connection: &Connection,
    columns: &[Column],
    read_only: bool,
) -> Result<std::result::Result<Target, String>> {
    if read_only {
        return Ok(Err("this connection is read-only".to_owned()));
    }
    if columns.is_empty() {
        return Ok(Err("the result has no columns".to_owned()));
    }
    let sources = connection.resolve_sources(columns).await?;
    let Some(Some(first)) = sources.first() else {
        return Ok(Err("a column is computed, not read from a table".to_owned()));
    };
    let (schema, table) = (first.schema.clone(), first.table.clone());
    let mut names = Vec::with_capacity(columns.len());
    for source in &sources {
        match source {
            None => return Ok(Err("a column is computed, not read from a table".to_owned())),
            Some(s) if s.schema != schema || s.table != table => {
                return Ok(Err(
                    "the result has columns from more than one table".to_owned()
                ));
            }
            Some(s) if names.contains(&s.column) => {
                return Ok(Err(format!("the column {} appears twice", s.column)));
            }
            Some(s) => names.push(s.column.clone()),
        }
    }
    let catalog = connection.columns(&schema, &table).await?;
    if catalog.is_empty() {
        return Ok(Err(format!("{table} is not a table that can be edited")));
    }
    let table_columns: Vec<String> = catalog.iter().map(|c| c.name.clone()).collect();
    let mut primary: Vec<(u32, &str)> = catalog
        .iter()
        .filter_map(|c| c.primary_key_position.map(|p| (p, c.name.as_str())))
        .collect();
    primary.sort_unstable();

    let (key, by_primary_key) = if primary.is_empty() {
        // No primary key: every column must be shown, and comparable.
        if let Some(missing) = table_columns.iter().find(|c| !names.contains(c)) {
            return Ok(Err(format!(
                "{table} has no primary key, so rows are named by every value, and {missing} is not in the result"
            )));
        }
        if let Some(column) = columns.iter().find(|c| !comparable(c)) {
            return Ok(Err(format!(
                "{table} has no primary key, and {} ({}) cannot be compared to name a row",
                column.name, column.db_type
            )));
        }
        ((0..columns.len()).collect(), false)
    } else {
        let mut key = Vec::with_capacity(primary.len());
        for (_, name) in &primary {
            match names.iter().position(|n| n == name) {
                Some(index) => key.push(index),
                None => {
                    return Ok(Err(format!(
                        "the primary key column {name} is not in the result"
                    )));
                }
            }
        }
        (key, true)
    };
    Ok(Ok(Target {
        table: TableName {
            schema: Some(schema),
            name: table,
        },
        table_columns,
        column_names: names,
        key,
        by_primary_key,
    }))
}

impl Target {
    pub(crate) fn describe(&self) -> EditTarget {
        EditTarget {
            reason: None,
            schema: self.table.schema.clone(),
            table: Some(self.table.name.clone()),
            by_primary_key: self.by_primary_key,
            key: self.key.clone(),
        }
    }

    fn cells(&self, columns: &[Column], values: &[CellValue]) -> Result<Vec<Cell>> {
        let mut cells: Vec<Cell> = Vec::with_capacity(values.len());
        for value in values {
            let name = self
                .column_names
                .get(value.column)
                .ok_or_else(|| Error::config(format!("no column {}", value.column)))?;
            if cells.iter().any(|c| &c.column == name) {
                return Err(Error::config(format!("{name} is given twice")));
            }
            cells.push(Cell {
                column: name.clone(),
                value: value.value.clone(),
                type_tag: columns[value.column].type_tag,
            });
        }
        Ok(cells)
    }

    fn key_cells(&self, columns: &[Column], row: &[Option<String>]) -> Vec<Cell> {
        self.key
            .iter()
            .map(|&i| Cell {
                column: self.column_names[i].clone(),
                value: row[i].clone(),
                type_tag: columns[i].type_tag,
            })
            .collect()
    }

    /// The statements for `edits`, each checked by the gate.
    pub(crate) fn plan(
        &self,
        store: &ResultStore,
        edits: &[RowEdit],
        dialect: Dialect,
    ) -> Result<Vec<String>> {
        let columns = store.columns();
        let key_names: Vec<String> = self
            .key
            .iter()
            .map(|&i| self.column_names[i].clone())
            .collect();
        let shape = EditShape {
            table: &self.table,
            columns: &self.table_columns,
            key: &key_names,
        };
        let mut statements = Vec::with_capacity(edits.len());
        for edit in edits {
            let (change, kind) = match edit {
                RowEdit::Update { row, set } => {
                    if set.is_empty() {
                        continue;
                    }
                    let original = store.source_row(*row)?;
                    (
                        Change::Update {
                            key: self.key_cells(columns, &original),
                            set: self.cells(columns, set)?,
                        },
                        EditKind::Update,
                    )
                }
                RowEdit::Delete { row } => {
                    let original = store.source_row(*row)?;
                    (
                        Change::Delete {
                            key: self.key_cells(columns, &original),
                        },
                        EditKind::Delete,
                    )
                }
                RowEdit::Insert { values } => (
                    Change::Insert {
                        values: self.cells(columns, values)?,
                    },
                    EditKind::Insert,
                ),
            };
            let sql = generate(&change, &self.table, dialect);
            check_edit(&sql, dialect, kind, &shape).map_err(|refused| {
                Error::internal(format!(
                    "a generated statement was refused by its check ({refused}): {sql}"
                ))
            })?;
            statements.push(sql);
        }
        Ok(statements)
    }
}

/// Collects the one outcome of running one statement.
#[derive(Default)]
struct Outcome(Option<StatementOutcome>);

impl ResultSink for Outcome {
    fn statement_started(&mut self, _index: usize, _span: Span) {}
    fn columns(&mut self, _columns: Vec<Column>) {}
    fn row(&mut self, _row: &dyn RowView) {}
    fn statement_finished(&mut self, outcome: StatementOutcome) {
        self.0 = Some(outcome);
    }
}

async fn exec(connection: &Connection, sql: &str) -> Result<Option<u64>> {
    let mut outcome = Outcome::default();
    connection
        .execute(
            sql,
            ExecuteOptions { row_cap: Some(0) },
            &mut outcome,
            &CancellationToken::new(),
        )
        .await?;
    Ok(outcome.0.and_then(|o| o.rows_affected))
}

/// Runs `statements` in one transaction, which is committed only if each
/// one changed exactly one row.
pub(crate) async fn apply(connection: &Connection, statements: &[String]) -> Result<()> {
    exec(connection, "BEGIN").await?;
    for (i, sql) in statements.iter().enumerate() {
        let failure = match exec(connection, sql).await {
            Ok(Some(1)) => continue,
            Ok(changed) => Error::query(format!(
                "change {} would have changed {} rows instead of one, so nothing was saved: {sql}",
                i + 1,
                changed.unwrap_or(0)
            )),
            Err(err) => err,
        };
        if let Err(rollback) = exec(connection, "ROLLBACK").await {
            tracing::warn!("rolling back an edit failed: {rollback}");
        }
        return Err(failure);
    }
    exec(connection, "COMMIT").await?;
    Ok(())
}

/// The statements in `script` that a confirm-first connection must ask about.
pub(crate) fn needing_confirmation(script: &str, engine: Engine) -> Vec<String> {
    qs_sql::classify(script, Dialect::for_engine(engine))
        .into_iter()
        .filter(|c| c.kind == StatementKind::Schema)
        .map(|c| c.text)
        .collect()
}

/// The filter bar's query: everything from the table, with `filter` as its
/// WHERE (or ORDER BY, LIMIT or OFFSET when it starts with one), checked by
/// the filter gate before it is shown or run.
pub fn filter_query(
    engine: Engine,
    schema: Option<&str>,
    table: &str,
    filter: &str,
) -> Result<String> {
    let dialect = Dialect::for_engine(engine);
    let table = TableName {
        schema: schema.map(str::to_owned),
        name: table.to_owned(),
    };
    let condition = filter.trim().trim_end_matches(';').trim_end();
    let name = qs_sql::edit::qualified(&table, dialect);
    // A clause of its own goes in as written; anything else is a condition.
    let words: Vec<String> = condition
        .split_whitespace()
        .take(2)
        .map(str::to_ascii_lowercase)
        .collect();
    let clause = matches!(
        words
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice(),
        ["where", ..] | ["limit", ..] | ["offset", ..] | ["order", "by"]
    );
    let sql = if condition.is_empty() {
        format!("SELECT * FROM {name}")
    } else if clause {
        format!("SELECT * FROM {name} {condition}")
    } else {
        format!("SELECT * FROM {name} WHERE {condition}")
    };
    qs_sql::gate::check_filter(&sql, dialect, &table)
        .map_err(|refused| Error::query(format!("That filter cannot be used: {refused}")))?;
    Ok(format!("{sql};\n"))
}
