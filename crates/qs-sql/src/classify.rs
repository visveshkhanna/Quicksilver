//! What a user's statement does, so connection modes can be enforced: a
//! read-write connection asks before anything that changes the schema.
//!
//! The parse tree decides where it can (a data-modifying `WITH`, an
//! `EXPLAIN ANALYZE` that runs its statement). Statements the parser does
//! not know are judged by their first keyword, erring towards asking.

use serde::Serialize;
use sqlparser::ast::{SetExpr, Statement as Ast};
use sqlparser::parser::Parser;

use crate::split::{Dialect, split};

/// What a statement does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum StatementKind {
    /// Reads only.
    Read,
    /// Changes rows.
    Write,
    /// Changes the schema, permissions or anything else beyond rows, or may
    /// (`DO` blocks, `CALL`).
    Schema,
    /// Starts or ends a transaction.
    Transaction,
    /// Anything else (`SET`, `USE`, `PRAGMA`…).
    Other,
}

/// One statement of a script and what it does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct Classified {
    /// The statement's text.
    pub text: String,
    /// What it does.
    pub kind: StatementKind,
}

/// Classifies every statement in `script`.
pub fn classify(script: &str, dialect: Dialect) -> Vec<Classified> {
    split(script, dialect)
        .into_iter()
        .map(|statement| Classified {
            text: statement.text.to_owned(),
            kind: classify_one(statement.text, dialect),
        })
        .collect()
}

/// The first keyword of a statement, upper-cased, after any comments.
fn first_keyword(text: &str) -> String {
    let mut rest = text.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect::<String>()
        .to_ascii_uppercase()
}

fn by_keyword(keyword: &str) -> StatementKind {
    match keyword {
        "SELECT" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" => {
            StatementKind::Read
        }
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "UPSERT" | "REPLACE" | "COPY" => {
            StatementKind::Write
        }
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "ABORT" => {
            StatementKind::Transaction
        }
        "SET" | "RESET" | "USE" | "PRAGMA" | "LISTEN" | "NOTIFY" | "UNLISTEN" | "DISCARD"
        | "LOAD" | "PREPARE" | "DEALLOCATE" | "FETCH" | "CLOSE" | "DECLARE" | "MOVE" | "LOCK"
        | "CHECKPOINT" | "ANALYZE" | "VACUUM" => StatementKind::Other,
        // CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, COMMENT, RENAME,
        // REINDEX, CLUSTER, REFRESH, SECURITY, DO, CALL, EXECUTE, WITH that
        // did not parse, and anything unknown: ask.
        _ => StatementKind::Schema,
    }
}

fn classify_one(text: &str, dialect: Dialect) -> StatementKind {
    let keyword = first_keyword(text);
    let parsed = Parser::parse_sql(parser_dialect(dialect).as_ref(), text);
    let Ok(statements) = parsed else {
        return by_keyword(&keyword);
    };
    match statements.as_slice() {
        [one] => of_ast(one).unwrap_or_else(|| by_keyword(&keyword)),
        _ => by_keyword(&keyword),
    }
}

fn of_ast(statement: &Ast) -> Option<StatementKind> {
    Some(match statement {
        Ast::Query(query) => {
            let mut kind = StatementKind::Read;
            if let Some(with) = &query.with {
                for cte in &with.cte_tables {
                    if !matches!(
                        *cte.query.body,
                        SetExpr::Select(_)
                            | SetExpr::Values(_)
                            | SetExpr::SetOperation { .. }
                            | SetExpr::Query(_)
                    ) {
                        kind = StatementKind::Write;
                    }
                }
            }
            if !matches!(
                *query.body,
                SetExpr::Select(_)
                    | SetExpr::Values(_)
                    | SetExpr::SetOperation { .. }
                    | SetExpr::Query(_)
                    | SetExpr::Table(_)
            ) {
                kind = StatementKind::Write;
            }
            kind
        }
        Ast::Insert(_) | Ast::Update(_) | Ast::Delete(_) | Ast::Merge(_) | Ast::Copy { .. } => {
            StatementKind::Write
        }
        Ast::StartTransaction { .. }
        | Ast::Commit { .. }
        | Ast::Rollback { .. }
        | Ast::Savepoint { .. } => StatementKind::Transaction,
        // EXPLAIN ANALYZE runs what it explains.
        Ast::Explain {
            analyze, statement, ..
        } => {
            if *analyze {
                of_ast(statement).unwrap_or(StatementKind::Schema)
            } else {
                StatementKind::Read
            }
        }
        Ast::ExplainTable { .. } | Ast::ShowVariable { .. } => StatementKind::Read,
        _ => return None,
    })
}

pub(crate) fn parser_dialect(dialect: Dialect) -> Box<dyn sqlparser::dialect::Dialect> {
    match dialect {
        Dialect::Postgres => Box::new(sqlparser::dialect::PostgreSqlDialect {}),
        Dialect::MySql => Box::new(sqlparser::dialect::MySqlDialect {}),
        Dialect::Sqlite => Box::new(sqlparser::dialect::SQLiteDialect {}),
        Dialect::Generic => Box::new(sqlparser::dialect::GenericDialect {}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(script: &str, dialect: Dialect) -> Vec<StatementKind> {
        classify(script, dialect)
            .into_iter()
            .map(|c| c.kind)
            .collect()
    }

    #[test]
    fn sorts_statements_by_what_they_do() {
        use StatementKind::*;
        assert_eq!(
            kinds(
                "select 1; insert into t values (1); update t set a = 1; delete from t; \
                 create table x (a int); alter table x add b int; drop table x; truncate t; \
                 begin; commit; set search_path = s; grant select on t to u",
                Dialect::Postgres
            ),
            [
                Read,
                Write,
                Write,
                Write,
                Schema,
                Schema,
                Schema,
                Schema,
                Transaction,
                Transaction,
                Other,
                Schema
            ]
        );
    }

    #[test]
    fn sees_writes_hidden_in_a_with_or_an_explain_analyze() {
        use StatementKind::*;
        assert_eq!(
            kinds(
                "with gone as (delete from t returning *) select * from gone; \
                 explain select 1; explain analyze delete from t; explain analyze drop table t",
                Dialect::Postgres
            ),
            [Write, Read, Write, Schema]
        );
    }

    #[test]
    fn falls_back_to_the_first_keyword_and_asks_when_unsure() {
        use StatementKind::*;
        assert_eq!(
            kinds(
                "-- a comment\n/* another */ DO $$ BEGIN EXECUTE 'drop table t'; END $$; \
                 call refresh_everything(); vacuum t; frobnicate the database",
                Dialect::Postgres
            ),
            [Schema, Schema, Other, Schema]
        );
        assert_eq!(kinds("PRAGMA foreign_keys = on", Dialect::Sqlite), [Other]);
    }
}
