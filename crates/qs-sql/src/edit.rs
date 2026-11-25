//! The statements Quicksilver writes for a grid edit: one `UPDATE`, `INSERT`
//! or `DELETE` per changed row, naming the row exactly.
//!
//! Values are the cells as the server rendered them, written back as
//! literals the server parses to the same value: on Postgres every value is a
//! string literal, which the server reads with the column type's own input
//! function, so the text it printed is what it reads back. SQLite and MySQL
//! keep numbers bare, because there a quoted number is a string.
//!
//! Nothing here decides whether a statement is safe to run; [`crate::gate`]
//! checks each one against the table's catalog independently.

use qs_core::TypeTag;

use crate::split::Dialect;

/// A table, as the catalog names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableName {
    /// Its schema, if the engine has schemas.
    pub schema: Option<String>,
    /// Its name.
    pub name: String,
}

/// One column's value in a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// The column's name in the table.
    pub column: String,
    /// The value as text, `None` for NULL.
    pub value: Option<String>,
    /// The column's type tag, which decides how the value is written.
    pub type_tag: TypeTag,
}

/// One row's change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Set `set` on the row named by `key`.
    Update {
        /// The cells that name the row: its primary key, or every value.
        key: Vec<Cell>,
        /// The new values.
        set: Vec<Cell>,
    },
    /// Add a row with `values` (columns left out take their defaults).
    Insert {
        /// The values given.
        values: Vec<Cell>,
    },
    /// Remove the row named by `key`.
    Delete {
        /// The cells that name the row.
        key: Vec<Cell>,
    },
}

/// Quotes an identifier for `dialect`.
pub fn quote_ident(name: &str, dialect: Dialect) -> String {
    match dialect {
        Dialect::MySql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// The table as it is written in a statement.
pub fn qualified(table: &TableName, dialect: Dialect) -> String {
    match &table.schema {
        Some(schema) if !(dialect == Dialect::Sqlite && schema == "main") => {
            format!(
                "{}.{}",
                quote_ident(schema, dialect),
                quote_ident(&table.name, dialect)
            )
        }
        _ => quote_ident(&table.name, dialect),
    }
}

/// Whether `text` is a plain numeric literal: digits, an optional point and
/// exponent, and a leading minus at most.
pub(crate) fn is_plain_number(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    !whole.is_empty()
        && digits(whole)
        && fraction.is_none_or(|f| !f.is_empty() && digits(f))
        && exponent.is_none_or(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && digits(e)
        })
}

fn string_literal(text: &str, dialect: Dialect) -> String {
    let escaped = text.replace('\'', "''");
    // MySQL treats a backslash in a string as an escape unless told not to.
    let escaped = if dialect == Dialect::MySql {
        escaped.replace('\\', "\\\\")
    } else {
        escaped
    };
    format!("'{escaped}'")
}

/// A cell's value as a literal for `dialect`.
pub fn literal(cell: &Cell, dialect: Dialect) -> String {
    let Some(text) = &cell.value else {
        return "NULL".to_owned();
    };
    let numeric = matches!(
        cell.type_tag,
        TypeTag::Integer | TypeTag::Float | TypeTag::Decimal | TypeTag::Bool
    );
    match dialect {
        Dialect::Postgres => string_literal(text, dialect),
        _ if numeric && is_plain_number(text) => text.clone(),
        Dialect::Sqlite | Dialect::MySql
            if cell.type_tag == TypeTag::Bytes
                && text.len() % 2 == 0
                && text.starts_with("\\x")
                && text[2..].bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            format!("X'{}'", &text[2..])
        }
        _ => string_literal(text, dialect),
    }
}

/// `"col" = 'v' AND "other" IS NULL`: the row named by `key`.
fn predicate(key: &[Cell], dialect: Dialect) -> String {
    key.iter()
        .map(|cell| match cell.value {
            None => format!("{} IS NULL", quote_ident(&cell.column, dialect)),
            Some(_) => format!(
                "{} = {}",
                quote_ident(&cell.column, dialect),
                literal(cell, dialect)
            ),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// The statement for one change.
pub fn generate(change: &Change, table: &TableName, dialect: Dialect) -> String {
    let table = qualified(table, dialect);
    match change {
        Change::Update { key, set } => {
            let assignments = set
                .iter()
                .map(|cell| {
                    format!(
                        "{} = {}",
                        quote_ident(&cell.column, dialect),
                        literal(cell, dialect)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "UPDATE {table} SET {assignments} WHERE {}",
                predicate(key, dialect)
            )
        }
        Change::Insert { values } if values.is_empty() => {
            if dialect == Dialect::MySql {
                format!("INSERT INTO {table} () VALUES ()")
            } else {
                format!("INSERT INTO {table} DEFAULT VALUES")
            }
        }
        Change::Insert { values } => {
            let columns = values
                .iter()
                .map(|cell| quote_ident(&cell.column, dialect))
                .collect::<Vec<_>>()
                .join(", ");
            let literals = values
                .iter()
                .map(|cell| literal(cell, dialect))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({columns}) VALUES ({literals})")
        }
        Change::Delete { key } => {
            format!("DELETE FROM {table} WHERE {}", predicate(key, dialect))
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn cell(column: &str, value: Option<&str>, type_tag: TypeTag) -> Cell {
        Cell {
            column: column.to_owned(),
            value: value.map(str::to_owned),
            type_tag,
        }
    }

    /// One of every kind of change, with awkward values.
    pub(crate) fn changes() -> Vec<Change> {
        let key = vec![
            cell("id", Some("42"), TypeTag::Integer),
            cell("region", Some("eu"), TypeTag::Text),
        ];
        vec![
            Change::Update {
                key: key.clone(),
                set: vec![
                    cell("name", Some("O'Brien \\ \"Pat\""), TypeTag::Text),
                    cell("note", None, TypeTag::Text),
                    cell("amount", Some("-12.50"), TypeTag::Decimal),
                    cell("ok", Some("t"), TypeTag::Bool),
                ],
            },
            Change::Update {
                // A row without a primary key, named by every value.
                key: vec![
                    cell("label", Some("a"), TypeTag::Text),
                    cell("score", Some("1e-3"), TypeTag::Float),
                    cell("gone", None, TypeTag::Timestamp),
                    cell("blob", Some("\\xdeadbeef"), TypeTag::Bytes),
                ],
                set: vec![cell("label", Some("b"), TypeTag::Text)],
            },
            Change::Insert {
                values: vec![
                    cell("id", Some("43"), TypeTag::Integer),
                    cell("region", Some("us"), TypeTag::Text),
                    cell("meta", Some("{\"a\": [1, 2]}"), TypeTag::Json),
                    cell("count", Some("not a number"), TypeTag::Integer),
                ],
            },
            Change::Insert { values: vec![] },
            Change::Delete { key },
        ]
    }

    fn table() -> TableName {
        TableName {
            schema: Some("sales".to_owned()),
            name: "Order \"Items\"".to_owned(),
        }
    }

    fn all(dialect: Dialect) -> String {
        changes()
            .iter()
            .map(|c| generate(c, &table(), dialect))
            .collect::<Vec<_>>()
            .join(";\n")
    }

    #[test]
    fn postgres_statements() {
        insta::assert_snapshot!(all(Dialect::Postgres));
    }

    #[test]
    fn sqlite_statements() {
        insta::assert_snapshot!(all(Dialect::Sqlite));
    }

    #[test]
    fn mysql_statements() {
        insta::assert_snapshot!(all(Dialect::MySql));
    }

    #[test]
    fn sqlite_main_is_left_unqualified() {
        let main = TableName {
            schema: Some("main".to_owned()),
            name: "t".to_owned(),
        };
        assert_eq!(qualified(&main, Dialect::Sqlite), "\"t\"");
        assert_eq!(qualified(&main, Dialect::Postgres), "\"main\".\"t\"");
    }

    #[test]
    fn plain_numbers_are_recognised_strictly() {
        for yes in ["0", "-12", "3.25", "1e10", "-2.5E-3"] {
            assert!(is_plain_number(yes), "{yes}");
        }
        for no in [
            "", "-", ".5", "5.", "1e", "1.2.3", "0x10", "NaN", "Infinity", "1 ", "1;DROP",
        ] {
            assert!(!is_plain_number(no), "{no}");
        }
    }
}
