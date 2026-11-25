//! Parse-tree gates: every statement Quicksilver generates is parsed back and
//! checked against a whitelist for its path before it may run.
//!
//! A gate never trusts the generator. It is given what the catalog says
//! (the table, its columns, the columns that name a row) and accepts only
//! statements of exactly the expected shape:
//!
//! - **Edits**: one `UPDATE`, `INSERT` or `DELETE` on that table and nothing
//!   else; values are literals; the `WHERE` is a conjunction of `column =
//!   literal` and `column IS NULL` naming exactly the key columns, each once.
//!   No joins, subqueries, functions, `RETURNING`, `LIMIT` or `ON CONFLICT`.
//!   This is also what keeps out `DROP`, `TRUNCATE` and multi-row deletes by
//!   predicate.
//! - **Filters**: one `SELECT *` from that table alone, with no `WITH`, `INTO`
//!   or locking clause. The condition is the user's own.

use sqlparser::ast::{
    AssignmentTarget, BinaryOperator, Expr, FromTable, ObjectName, ObjectNamePart, SelectItem,
    SetExpr, Statement as Ast, TableFactor, TableObject, TableWithJoins, UnaryOperator, Value,
};
use sqlparser::parser::Parser;

use crate::classify::parser_dialect;
use crate::edit::TableName;
use crate::split::Dialect;

/// Why a gate refused a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

fn refuse<T>(why: impl Into<String>) -> Result<T, Refused> {
    Err(Refused(why.into()))
}

/// What an edit statement must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    /// `UPDATE … SET … WHERE <key>`.
    Update,
    /// `INSERT INTO … (…) VALUES (…)`, one row.
    Insert,
    /// `DELETE FROM … WHERE <key>`.
    Delete,
}

/// What the catalog says about the table being edited.
#[derive(Debug, Clone, Copy)]
pub struct EditShape<'a> {
    /// The table.
    pub table: &'a TableName,
    /// Every column it has.
    pub columns: &'a [String],
    /// The columns that name one row: the primary key, or every column when
    /// it has none.
    pub key: &'a [String],
}

fn parse_one(sql: &str, dialect: Dialect) -> Result<Ast, Refused> {
    let statements = Parser::parse_sql(parser_dialect(dialect).as_ref(), sql)
        .map_err(|err| Refused(format!("the statement does not parse: {err}")))?;
    match <[Ast; 1]>::try_from(statements) {
        Ok([one]) => Ok(one),
        Err(_) => refuse("exactly one statement is allowed"),
    }
}

/// The plain identifiers of a name, unquoted.
fn parts(name: &ObjectName) -> Result<Vec<&str>, Refused> {
    name.0
        .iter()
        .map(|part| match part {
            ObjectNamePart::Identifier(ident) => Ok(ident.value.as_str()),
            ObjectNamePart::Function(_) => refuse("names must be plain identifiers"),
        })
        .collect()
}

fn is_table(name: &ObjectName, table: &TableName, dialect: Dialect) -> Result<(), Refused> {
    let got = parts(name)?;
    let ok = match (&table.schema, got.as_slice()) {
        (Some(schema), [s, n]) => s == schema && *n == table.name,
        (Some(schema), [n]) => dialect == Dialect::Sqlite && schema == "main" && *n == table.name,
        (None, [n]) => *n == table.name,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        refuse(format!("the statement must name the table {}", table.name))
    }
}

fn single_table(
    from: &[TableWithJoins],
    table: &TableName,
    dialect: Dialect,
) -> Result<(), Refused> {
    let [TableWithJoins { relation, joins }] = from else {
        return refuse("exactly one table is allowed");
    };
    if !joins.is_empty() {
        return refuse("joins are not allowed");
    }
    match relation {
        TableFactor::Table {
            name,
            alias: None,
            args: None,
            with_hints,
            version: None,
            partitions,
            sample: None,
            ..
        } if with_hints.is_empty() && partitions.is_empty() => is_table(name, table, dialect),
        _ => refuse("only a plain table name is allowed"),
    }
}

/// A column reference: a bare identifier.
fn column(expr: &Expr) -> Result<&str, Refused> {
    match expr {
        Expr::Identifier(ident) => Ok(ident.value.as_str()),
        _ => refuse("only plain column names are allowed"),
    }
}

/// A literal value; `allow_null` for SET and VALUES, not for `=`.
fn literal(expr: &Expr, allow_null: bool) -> Result<(), Refused> {
    match expr {
        Expr::Value(v) => match &v.value {
            Value::Number(..)
            | Value::SingleQuotedString(_)
            | Value::HexStringLiteral(_)
            | Value::Boolean(_) => Ok(()),
            Value::Null if allow_null => Ok(()),
            Value::Null => refuse("NULL is matched with IS NULL"),
            _ => refuse("only plain literals are allowed"),
        },
        Expr::UnaryOp {
            op: UnaryOperator::Minus,
            expr,
        } => match expr.as_ref() {
            Expr::Value(v) if matches!(v.value, Value::Number(..)) => Ok(()),
            _ => refuse("only plain literals are allowed"),
        },
        _ => refuse("only plain literals are allowed"),
    }
}

/// Checks that `selection` names exactly the key columns, each once.
fn names_one_row(selection: Option<&Expr>, shape: &EditShape<'_>) -> Result<(), Refused> {
    let Some(selection) = selection else {
        return refuse("a WHERE naming the row is required");
    };
    let mut terms = Vec::new();
    let mut stack = vec![selection];
    while let Some(expr) = stack.pop() {
        match expr {
            Expr::BinaryOp {
                left,
                op: BinaryOperator::And,
                right,
            } => {
                stack.push(right);
                stack.push(left);
            }
            other => terms.push(other),
        }
    }
    let mut named: Vec<&str> = Vec::new();
    for term in terms {
        let name = match term {
            Expr::BinaryOp {
                left,
                op: BinaryOperator::Eq,
                right,
            } => {
                literal(right, false)?;
                column(left)?
            }
            Expr::IsNull(inner) => column(inner)?,
            _ => return refuse("the WHERE may only compare columns with values"),
        };
        if named.contains(&name) {
            return refuse(format!("the column {name} is matched twice"));
        }
        named.push(name);
    }
    let mut want: Vec<&str> = shape.key.iter().map(String::as_str).collect();
    want.sort_unstable();
    named.sort_unstable();
    if named != want {
        return refuse("the WHERE must name exactly the columns that identify the row");
    }
    Ok(())
}

fn known_column<'a>(name: &'a str, shape: &EditShape<'_>) -> Result<&'a str, Refused> {
    if shape.columns.iter().any(|c| c == name) {
        Ok(name)
    } else {
        refuse(format!("the table has no column {name}"))
    }
}

/// Checks a generated edit against the table's catalog.
pub fn check_edit(
    sql: &str,
    dialect: Dialect,
    kind: EditKind,
    shape: &EditShape<'_>,
) -> Result<(), Refused> {
    let statement = parse_one(sql, dialect)?;
    match (kind, &statement) {
        (EditKind::Update, Ast::Update(update)) => {
            if update.from.is_some()
                || update.returning.is_some()
                || update.output.is_some()
                || update.or.is_some()
                || !update.order_by.is_empty()
                || update.limit.is_some()
                || update.on_cluster.is_some()
                || update.settings.is_some()
            {
                return refuse("only UPDATE … SET … WHERE is allowed");
            }
            single_table(std::slice::from_ref(&update.table), shape.table, dialect)?;
            if update.assignments.is_empty() {
                return refuse("nothing to set");
            }
            let mut set: Vec<&str> = Vec::new();
            for assignment in &update.assignments {
                let AssignmentTarget::ColumnName(name) = &assignment.target else {
                    return refuse("only single columns can be set");
                };
                let [name] = parts(name)?[..] else {
                    return refuse("only plain column names are allowed");
                };
                let name = known_column(name, shape)?;
                if set.contains(&name) {
                    return refuse(format!("the column {name} is set twice"));
                }
                set.push(name);
                literal(&assignment.value, true)?;
            }
            names_one_row(update.selection.as_ref(), shape)
        }
        (EditKind::Delete, Ast::Delete(delete)) => {
            if !delete.tables.is_empty()
                || delete.using.is_some()
                || delete.returning.is_some()
                || delete.output.is_some()
                || !delete.order_by.is_empty()
                || delete.limit.is_some()
                || delete.on_cluster.is_some()
                || delete.settings.is_some()
            {
                return refuse("only DELETE FROM … WHERE is allowed");
            }
            let FromTable::WithFromKeyword(from) = &delete.from else {
                return refuse("only DELETE FROM … WHERE is allowed");
            };
            single_table(from, shape.table, dialect)?;
            names_one_row(delete.selection.as_ref(), shape)
        }
        (EditKind::Insert, Ast::Insert(insert)) => {
            if insert.or.is_some()
                || insert.ignore
                || !insert.into
                || insert.table_alias.is_some()
                || !insert.assignments.is_empty()
                || insert.partitioned.is_some()
                || !insert.after_columns.is_empty()
                || insert.overriding.is_some()
                || insert.on.is_some()
                || insert.returning.is_some()
                || insert.output.is_some()
                || insert.replace_into
                || insert.priority.is_some()
                || insert.insert_alias.is_some()
                || insert.settings.is_some()
                || insert.overwrite
            {
                return refuse("only INSERT INTO … VALUES is allowed");
            }
            let TableObject::TableName(name) = &insert.table else {
                return refuse("only a plain table name is allowed");
            };
            is_table(name, shape.table, dialect)?;
            let mut columns: Vec<&str> = Vec::new();
            for name in &insert.columns {
                let [name] = parts(name)?[..] else {
                    return refuse("only plain column names are allowed");
                };
                let name = known_column(name, shape)?;
                if columns.contains(&name) {
                    return refuse(format!("the column {name} is given twice"));
                }
                columns.push(name);
            }
            match &insert.source {
                // DEFAULT VALUES (and MySQL's `() VALUES ()`).
                None if columns.is_empty() => Ok(()),
                Some(query)
                    if query.with.is_none()
                        && query.order_by.is_none()
                        && query.limit_clause.is_none()
                        && query.locks.is_empty() =>
                {
                    let SetExpr::Values(values) = query.body.as_ref() else {
                        return refuse("only VALUES is allowed");
                    };
                    let [row] = values.rows.as_slice() else {
                        return refuse("exactly one row is allowed");
                    };
                    if row.content.len() != columns.len() {
                        return refuse("every column needs exactly one value");
                    }
                    row.content.iter().try_for_each(|v| literal(v, true))
                }
                _ => refuse("only INSERT INTO … VALUES is allowed"),
            }
        }
        _ => refuse(format!("expected {kind:?}, got another kind of statement")),
    }
}

/// Checks the filter bar's query: everything from `table`, filtered.
pub fn check_filter(sql: &str, dialect: Dialect, table: &TableName) -> Result<(), Refused> {
    let Ast::Query(query) = parse_one(sql, dialect)? else {
        return refuse("a filter must be a SELECT");
    };
    if query.with.is_some() || !query.locks.is_empty() || query.for_clause.is_some() {
        return refuse("a filter cannot use WITH, FOR UPDATE or FOR XML/JSON");
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return refuse("a filter must be a single SELECT");
    };
    if select.into.is_some() {
        return refuse("a filter cannot SELECT INTO");
    }
    if !matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)]) {
        return refuse("a filter selects every column");
    }
    single_table(&select.from, table, dialect)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{Change, generate};

    fn table() -> TableName {
        TableName {
            schema: Some("sales".to_owned()),
            name: "Order \"Items\"".to_owned(),
        }
    }

    fn columns() -> Vec<String> {
        [
            "id", "region", "name", "note", "amount", "ok", "label", "score", "gone", "blob",
            "meta", "count",
        ]
        .map(str::to_owned)
        .to_vec()
    }

    fn check(sql: &str, kind: EditKind, key: &[&str]) -> Result<(), Refused> {
        let key: Vec<String> = key.iter().map(|k| (*k).to_owned()).collect();
        let columns = columns();
        let table = table();
        let shape = EditShape {
            table: &table,
            columns: &columns,
            key: &key,
        };
        check_edit(sql, Dialect::Postgres, kind, &shape)
    }

    #[test]
    fn every_generated_statement_passes_its_gate_in_every_dialect() {
        for dialect in [Dialect::Postgres, Dialect::Sqlite, Dialect::MySql] {
            for change in crate::edit::tests::changes() {
                let sql = generate(&change, &table(), dialect);
                let (kind, key): (EditKind, Vec<String>) = match &change {
                    Change::Update { key, .. } => (
                        EditKind::Update,
                        key.iter().map(|c| c.column.clone()).collect(),
                    ),
                    Change::Insert { .. } => (EditKind::Insert, vec![]),
                    Change::Delete { key } => (
                        EditKind::Delete,
                        key.iter().map(|c| c.column.clone()).collect(),
                    ),
                };
                let columns = columns();
                let table = table();
                let shape = EditShape {
                    table: &table,
                    columns: &columns,
                    key: &key,
                };
                check_edit(&sql, dialect, kind, &shape)
                    .unwrap_or_else(|err| panic!("{dialect:?}: {sql}: {err}"));
            }
        }
    }

    const T: &str = "\"sales\".\"Order \"\"Items\"\"\"";

    #[test]
    fn refuses_anything_but_the_expected_shape() {
        let key = ["id"];
        let refused = [
            (
                format!("UPDATE {T} SET name = 'x' WHERE id = 1; DROP TABLE x"),
                EditKind::Update,
            ),
            ("DROP TABLE sales.x".to_owned(), EditKind::Delete),
            (format!("TRUNCATE {T}"), EditKind::Delete),
            // Not the key.
            (
                format!("DELETE FROM {T} WHERE name = 'x'"),
                EditKind::Delete,
            ),
            (format!("DELETE FROM {T} WHERE id > 1"), EditKind::Delete),
            (
                format!("DELETE FROM {T} WHERE id = 1 OR id = 2"),
                EditKind::Delete,
            ),
            (format!("DELETE FROM {T}"), EditKind::Delete),
            (
                format!("DELETE FROM {T} WHERE id = 1 AND id = 1"),
                EditKind::Delete,
            ),
            (
                format!("DELETE FROM {T} WHERE id = 1 RETURNING *"),
                EditKind::Delete,
            ),
            (
                format!("DELETE FROM {T} WHERE id = (SELECT 1)"),
                EditKind::Delete,
            ),
            (format!("DELETE FROM {T} WHERE id = NULL"), EditKind::Delete),
            // Another table, or more than one.
            (
                "DELETE FROM sales.other WHERE id = 1".to_owned(),
                EditKind::Delete,
            ),
            (
                format!("UPDATE {T} SET name = 'x' FROM sales.other WHERE id = 1"),
                EditKind::Update,
            ),
            // Values must be literals; columns must exist.
            (
                format!("UPDATE {T} SET name = now() WHERE id = 1"),
                EditKind::Update,
            ),
            (
                format!("UPDATE {T} SET name = id WHERE id = 1"),
                EditKind::Update,
            ),
            (
                format!("UPDATE {T} SET secret = 'x' WHERE id = 1"),
                EditKind::Update,
            ),
            (
                format!("UPDATE {T} SET name = 'a', name = 'b' WHERE id = 1"),
                EditKind::Update,
            ),
            (format!("INSERT INTO {T} (id) SELECT 1"), EditKind::Insert),
            (
                format!("INSERT INTO {T} (id) VALUES (1), (2)"),
                EditKind::Insert,
            ),
            (
                format!("INSERT INTO {T} (id) VALUES (1) ON CONFLICT DO NOTHING"),
                EditKind::Insert,
            ),
            (
                format!("INSERT INTO {T} (id, name) VALUES (1)"),
                EditKind::Insert,
            ),
            // The kind asked for.
            (format!("DELETE FROM {T} WHERE id = 1"), EditKind::Update),
        ];
        for (sql, kind) in refused {
            assert!(check(&sql, kind, &key).is_err(), "should refuse: {sql}");
        }
        assert!(
            check(
                &format!("DELETE FROM {T} WHERE id = 1"),
                EditKind::Delete,
                &key
            )
            .is_ok()
        );
        assert!(
            check(
                &format!("DELETE FROM {T} WHERE id = -1 AND (region IS NULL)"),
                EditKind::Delete,
                &["id", "region"]
            )
            .is_err(),
            "parentheses are not something the generator writes"
        );
    }

    #[test]
    fn filters_select_everything_from_the_table_and_nothing_else() {
        let t = table();
        let ok = |sql: &str| check_filter(sql, Dialect::Postgres, &t);
        assert!(
            ok(&format!(
                "SELECT * FROM {T} WHERE id > 1 AND name ILIKE '%a%'"
            ))
            .is_ok()
        );
        assert!(ok(&format!("SELECT * FROM {T} ORDER BY id DESC LIMIT 5")).is_ok());
        for bad in [
            format!("SELECT * FROM {T} WHERE 1 = 1; DELETE FROM {T}"),
            format!("WITH x AS (DELETE FROM {T} RETURNING *) SELECT * FROM {T}"),
            format!("SELECT * FROM {T} FOR UPDATE"),
            format!("SELECT * INTO copy FROM {T}"),
            format!("SELECT * FROM {T}, sales.other"),
            format!("SELECT * FROM {T} JOIN sales.other USING (id)"),
            format!("SELECT id FROM {T}"),
            "SELECT * FROM sales.other".to_owned(),
            format!("DELETE FROM {T}"),
        ] {
            assert!(ok(&bad).is_err(), "should refuse: {bad}");
        }
    }
}
