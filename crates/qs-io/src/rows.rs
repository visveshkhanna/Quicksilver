//! Writing rows out as text, for the clipboard and for export.
//!
//! Cells arrive as the driver rendered them (`None` is NULL), with the
//! columns' type tags, so each format can decide what is a number and what
//! must be quoted.

use qs_core::{Error, Result, TypeTag};
use serde::Deserialize;

/// A text format for rows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Format {
    /// Tab-separated, as spreadsheets paste it. Cells holding a tab, a line
    /// break or a quote are quoted the way CSV quotes them.
    Tsv {
        /// Whether the first line names the columns.
        header: bool,
    },
    /// Comma-separated, RFC 4180.
    Csv {
        /// Whether the first line names the columns.
        header: bool,
    },
    /// An array of objects, one per row, keyed by column name.
    Json,
    /// One `INSERT` statement per row.
    Insert {
        /// The table to insert into, already quoted and qualified as it
        /// should appear.
        table: String,
    },
}

/// One column as a format sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// Its name.
    pub name: String,
    /// Its type tag.
    pub type_tag: TypeTag,
}

/// Writes rows in one format into a string, refusing to grow past a limit.
pub struct RowWriter {
    format: Format,
    fields: Vec<Field>,
    /// JSON keys, made unique.
    keys: Vec<String>,
    out: String,
    rows: u64,
    limit: usize,
}

impl RowWriter {
    /// A writer for rows with `fields`, in `format`, that fails once the
    /// output passes `limit` bytes.
    pub fn new(format: Format, fields: Vec<Field>, limit: usize) -> Self {
        let keys = unique_keys(&fields);
        let mut writer = RowWriter {
            format,
            fields,
            keys,
            out: String::new(),
            rows: 0,
            limit,
        };
        writer.start();
        writer
    }

    fn start(&mut self) {
        let names: Vec<Option<&str>> = self.fields.iter().map(|f| Some(f.name.as_str())).collect();
        match self.format {
            Format::Tsv { header: true } => push_line(&mut self.out, &names, '\t'),
            Format::Csv { header: true } => push_line(&mut self.out, &names, ','),
            Format::Json => self.out.push('['),
            _ => {}
        }
    }

    /// Adds one row; `cells` has one entry per field.
    pub fn row(&mut self, cells: &[Option<&str>]) -> Result<()> {
        match &self.format {
            Format::Tsv { .. } => push_line(&mut self.out, cells, '\t'),
            Format::Csv { .. } => push_line(&mut self.out, cells, ','),
            Format::Json => {
                self.out
                    .push_str(if self.rows == 0 { "\n  {" } else { ",\n  {" });
                for (i, (cell, field)) in cells.iter().zip(&self.fields).enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    push_json_string(&mut self.out, &self.keys[i]);
                    self.out.push_str(": ");
                    push_json_value(&mut self.out, *cell, field.type_tag);
                }
                self.out.push('}');
            }
            Format::Insert { table } => {
                let table = table.clone();
                self.out.push_str("INSERT INTO ");
                self.out.push_str(&table);
                self.out.push_str(" (");
                for (i, field) in self.fields.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    push_ident(&mut self.out, &field.name);
                }
                self.out.push_str(") VALUES (");
                for (i, (cell, field)) in cells.iter().zip(&self.fields).enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    push_sql_literal(&mut self.out, *cell, field.type_tag);
                }
                self.out.push_str(");\n");
            }
        }
        self.rows += 1;
        if self.out.len() > self.limit {
            return Err(Error::unsupported(format!(
                "the selection is more than {} MB as text; export it to a file instead",
                self.limit / (1024 * 1024)
            )));
        }
        Ok(())
    }

    /// The text written.
    pub fn finish(mut self) -> String {
        if self.format == Format::Json {
            self.out
                .push_str(if self.rows == 0 { "]\n" } else { "\n]\n" });
        }
        self.out
    }
}

/// One delimited line; TSV ends lines as spreadsheets do, CSV with CRLF as
/// RFC 4180 says.
fn push_line(out: &mut String, cells: &[Option<&str>], separator: char) {
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.push(separator);
        }
        if let Some(text) = cell {
            push_delimited(out, text, separator);
        }
    }
    out.push_str(if separator == '\t' { "\n" } else { "\r\n" });
}

/// Column names as JSON keys: a repeated name gets `_2`, `_3` and so on.
fn unique_keys(fields: &[Field]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(fields.len());
    for field in fields {
        let mut key = field.name.clone();
        let mut n = 1;
        while keys.contains(&key) {
            n += 1;
            key = format!("{}_{n}", field.name);
        }
        keys.push(key);
    }
    keys
}

fn push_delimited(out: &mut String, text: &str, separator: char) {
    if text.contains([separator, '"', '\n', '\r']) {
        out.push('"');
        out.push_str(&text.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(text);
    }
}

fn push_json_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()));
}

/// Whether `text` is a number exactly as JSON spells one.
fn is_json_number(text: &str) -> bool {
    serde_json::from_str::<serde_json::Number>(text).is_ok()
}

fn push_json_value(out: &mut String, cell: Option<&str>, tag: TypeTag) {
    let Some(text) = cell else {
        out.push_str("null");
        return;
    };
    match tag {
        // Big integers and exact decimals stay exact: they are written as the
        // server printed them, not through a float.
        TypeTag::Integer | TypeTag::Float | TypeTag::Decimal if is_json_number(text) => {
            out.push_str(text);
        }
        TypeTag::Bool => match bool_of(text) {
            Some(true) => out.push_str("true"),
            Some(false) => out.push_str("false"),
            None => push_json_string(out, text),
        },
        TypeTag::Json if serde_json::from_str::<serde_json::Value>(text).is_ok() => {
            out.push_str(text.trim());
        }
        _ => push_json_string(out, text),
    }
}

fn bool_of(text: &str) -> Option<bool> {
    match text {
        "t" | "true" | "TRUE" | "1" => Some(true),
        "f" | "false" | "FALSE" | "0" => Some(false),
        _ => None,
    }
}

fn push_ident(out: &mut String, name: &str) {
    out.push('"');
    out.push_str(&name.replace('"', "\"\""));
    out.push('"');
}

/// Whether `text` is a plain SQL numeric literal (digits, a point, an
/// exponent), so it can go in unquoted without changing meaning.
fn is_sql_number(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let mut parts = mantissa.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && fraction.is_none_or(digits)
        && !(whole.is_empty() && fraction.is_none_or(str::is_empty));
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    !body.is_empty() && mantissa_ok && exponent_ok
}

fn push_sql_literal(out: &mut String, cell: Option<&str>, tag: TypeTag) {
    let Some(text) = cell else {
        out.push_str("NULL");
        return;
    };
    match tag {
        TypeTag::Integer | TypeTag::Float | TypeTag::Decimal if is_sql_number(text) => {
            out.push_str(text);
        }
        TypeTag::Bool => match bool_of(text) {
            Some(true) => out.push_str("TRUE"),
            Some(false) => out.push_str("FALSE"),
            None => push_sql_string(out, text),
        },
        _ => push_sql_string(out, text),
    }
}

fn push_sql_string(out: &mut String, text: &str) {
    out.push('\'');
    out.push_str(&text.replace('\'', "''"));
    out.push('\'');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Vec<Field> {
        [
            ("id", TypeTag::Integer),
            ("name", TypeTag::Text),
            ("ok", TypeTag::Bool),
            ("amount", TypeTag::Decimal),
            ("meta", TypeTag::Json),
            ("name", TypeTag::Text),
        ]
        .into_iter()
        .map(|(name, type_tag)| Field {
            name: name.into(),
            type_tag,
        })
        .collect()
    }

    const ROWS: &[&[Option<&str>]] = &[
        &[
            Some("1"),
            Some("O'Brien, \"Pat\""),
            Some("t"),
            Some("12345678901234567890.5"),
            Some("{\"a\": [1, 2]}"),
            Some("tab\there"),
        ],
        &[
            Some("2"),
            None,
            Some("f"),
            Some("NaN"),
            Some("not json"),
            Some("line\nbreak"),
        ],
    ];

    fn write(format: Format) -> String {
        let mut writer = RowWriter::new(format, fields(), usize::MAX);
        for row in ROWS {
            writer.row(row).expect("row");
        }
        writer.finish()
    }

    #[test]
    fn tsv_pastes_into_a_spreadsheet() {
        let tsv = write(Format::Tsv { header: true });
        let lines: Vec<&str> = tsv.split_inclusive('\n').collect();
        assert_eq!(lines[0], "id\tname\tok\tamount\tmeta\tname\n");
        // Quotes, tabs and line breaks are quoted; everything else is bare.
        assert_eq!(
            lines[1],
            "1\t\"O'Brien, \"\"Pat\"\"\"\tt\t12345678901234567890.5\t\"{\"\"a\"\": [1, 2]}\"\t\"tab\there\"\n"
        );
        assert_eq!(
            &lines[2..].concat(),
            "2\t\tf\tNaN\tnot json\t\"line\nbreak\"\n"
        );
        assert!(!write(Format::Tsv { header: false }).starts_with("id"));
    }

    #[test]
    fn csv_quotes_per_rfc_4180() {
        let csv = write(Format::Csv { header: true });
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(lines[0], "id,name,ok,amount,meta,name");
        assert_eq!(
            lines[1],
            "1,\"O'Brien, \"\"Pat\"\"\",t,12345678901234567890.5,\"{\"\"a\"\": [1, 2]}\",tab\there"
        );
        assert_eq!(lines[2], "2,,f,NaN,not json,\"line\nbreak\"");
    }

    #[test]
    fn json_keeps_numbers_exact_and_types_right() {
        let json = write(Format::Json);
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value[0]["id"], 1);
        assert_eq!(value[0]["ok"], true);
        assert_eq!(value[0]["meta"]["a"][1], 2);
        assert_eq!(value[0]["name_2"], "tab\there");
        assert_eq!(value[1]["name"], serde_json::Value::Null);
        assert_eq!(value[1]["amount"], "NaN", "not a JSON number");
        assert_eq!(value[1]["meta"], "not json");
        // The big decimal is written digit for digit.
        assert!(
            json.contains("\"amount\": 12345678901234567890.5"),
            "{json}"
        );
        assert_eq!(RowWriter::new(Format::Json, fields(), 100).finish(), "[]\n");
    }

    #[test]
    fn insert_quotes_strings_and_leaves_numbers_bare() {
        let sql = write(Format::Insert {
            table: "\"sales\".\"people\"".into(),
        });
        let first = sql.lines().next().expect("a line");
        assert_eq!(
            first,
            "INSERT INTO \"sales\".\"people\" (\"id\", \"name\", \"ok\", \"amount\", \"meta\", \"name\") \
             VALUES (1, 'O''Brien, \"Pat\"', TRUE, 12345678901234567890.5, '{\"a\": [1, 2]}', 'tab\there');"
        );
        assert!(sql.contains("VALUES (2, NULL, FALSE, 'NaN', 'not json', 'line\nbreak');"));
    }

    #[test]
    fn sql_numbers_are_recognised_strictly() {
        for yes in ["0", "-12", "3.25", ".5", "5.", "1e10", "-2.5E-3"] {
            assert!(is_sql_number(yes), "{yes}");
        }
        for no in [
            "", "-", ".", "1e", "1.2.3", "0x10", "Infinity", "1 ", "1;DROP",
        ] {
            assert!(!is_sql_number(no), "{no}");
        }
    }

    #[test]
    fn stops_past_the_limit() {
        let mut writer = RowWriter::new(Format::Csv { header: false }, fields(), 40);
        assert!(writer.row(ROWS[0]).is_err());
    }
}
