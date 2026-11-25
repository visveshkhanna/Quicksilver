//! Splitting a buffer into statements.
//!
//! This is a lexer, not a parser: it knows enough about strings, quoted
//! identifiers, comments, dollar quotes and `BEGIN … END` bodies to find the
//! semicolons that end statements, and nothing else. Every statement keeps
//! its exact text, so what runs is what the user wrote.

/// The lexical rules to split by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Dollar quotes, `E''` strings and nested block comments.
    Postgres,
    /// Backslash escapes in strings, `"` strings, backticks and `#` comments.
    MySql,
    /// Backticks and `[bracketed]` identifiers.
    Sqlite,
    /// Only what every dialect shares.
    Generic,
}

/// One statement found in a buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Statement<'a> {
    /// The statement's text, without the `;` that ended it or the whitespace
    /// around it. Comments before it are kept.
    pub text: &'a str,
    /// Byte offset of `text` in the buffer.
    pub start: usize,
    /// Byte offset just past `text` in the buffer.
    pub end: usize,
}

/// Splits `sql` into statements, dropping any that hold only whitespace and
/// comments.
///
/// An unterminated string, identifier or comment runs to the end of the
/// buffer, so the server sees it and reports the error itself.
pub fn split(sql: &str, dialect: Dialect) -> Vec<Statement<'_>> {
    Splitter::new(sql, dialect).run()
}

struct Splitter<'a> {
    sql: &'a str,
    bytes: &'a [u8],
    dialect: Dialect,
    pos: usize,
    statements: Vec<Statement<'a>>,
    // State of the statement being read.
    start: usize,
    has_code: bool,
    first_word: Option<String>,
    has_body: bool,
    depth: u32,
}

impl<'a> Splitter<'a> {
    fn new(sql: &'a str, dialect: Dialect) -> Self {
        Splitter {
            sql,
            bytes: sql.as_bytes(),
            dialect,
            pos: 0,
            statements: Vec::new(),
            start: 0,
            has_code: false,
            first_word: None,
            has_body: false,
            depth: 0,
        }
    }

    fn run(mut self) -> Vec<Statement<'a>> {
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            match b {
                b';' if self.depth == 0 => {
                    self.finish(self.pos);
                    self.pos += 1;
                    self.start = self.pos;
                }
                b'-' if self.peek(1) == Some(b'-') && self.line_comment_allowed() => {
                    self.skip_line();
                }
                b'#' if self.dialect == Dialect::MySql => self.skip_line(),
                b'/' if self.peek(1) == Some(b'*') => self.skip_block_comment(),
                b'\'' => {
                    let backslashes = self.dialect == Dialect::MySql || self.is_escape_string();
                    self.code();
                    self.skip_quoted(b'\'', backslashes);
                }
                b'"' => {
                    self.code();
                    self.skip_quoted(b'"', self.dialect == Dialect::MySql);
                }
                b'`' if matches!(self.dialect, Dialect::MySql | Dialect::Sqlite) => {
                    self.code();
                    self.skip_quoted(b'`', false);
                }
                b'[' if self.dialect == Dialect::Sqlite => {
                    self.code();
                    self.skip_until(b']');
                }
                b'$' if self.dialect == Dialect::Postgres => {
                    self.code();
                    if !self.skip_dollar_quote() {
                        self.pos += 1;
                    }
                }
                b if is_word_start(b) => self.word(),
                b if b.is_ascii_whitespace() => self.pos += 1,
                _ => {
                    self.code();
                    self.pos += 1;
                }
            }
        }
        self.finish(self.bytes.len());
        self.statements
    }

    fn peek(&self, ahead: usize) -> Option<u8> {
        self.bytes.get(self.pos + ahead).copied()
    }

    fn code(&mut self) {
        self.has_code = true;
    }

    fn finish(&mut self, separator: usize) {
        if self.has_code {
            let raw = &self.sql[self.start..separator];
            let leading = raw.len() - raw.trim_start().len();
            let text = raw.trim();
            let start = self.start + leading;
            self.statements.push(Statement {
                text,
                start,
                end: start + text.len(),
            });
        }
        self.has_code = false;
        self.first_word = None;
        self.has_body = false;
        self.depth = 0;
    }

    /// MySQL only treats `--` as a comment when whitespace follows it.
    fn line_comment_allowed(&self) -> bool {
        self.dialect != Dialect::MySql || self.peek(2).is_none_or(|b| b.is_ascii_whitespace())
    }

    fn skip_line(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
            self.pos += 1;
        }
    }

    fn skip_block_comment(&mut self) {
        let nests = self.dialect == Dialect::Postgres;
        let mut depth = 0u32;
        while self.pos < self.bytes.len() {
            if self.bytes[self.pos] == b'/' && self.peek(1) == Some(b'*') {
                if depth == 0 || nests {
                    depth += 1;
                }
                self.pos += 2;
            } else if self.bytes[self.pos] == b'*' && self.peek(1) == Some(b'/') {
                self.pos += 2;
                depth -= 1;
                if depth == 0 {
                    return;
                }
            } else {
                self.pos += 1;
            }
        }
    }

    /// Skips a quoted run starting at the opening quote. A doubled quote is
    /// an escaped quote; with `backslashes`, so is `\` followed by anything.
    fn skip_quoted(&mut self, quote: u8, backslashes: bool) {
        self.pos += 1;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if backslashes && b == b'\\' {
                self.pos += 2;
            } else if b == quote {
                if self.peek(1) == Some(quote) {
                    self.pos += 2;
                } else {
                    self.pos += 1;
                    return;
                }
            } else {
                self.pos += 1;
            }
        }
        self.pos = self.bytes.len();
    }

    fn skip_until(&mut self, close: u8) {
        while self.pos < self.bytes.len() && self.bytes[self.pos] != close {
            self.pos += 1;
        }
        self.pos = (self.pos + 1).min(self.bytes.len());
    }

    /// Postgres `E'…'` strings take backslash escapes. The `E` must be a word
    /// of its own, not the end of an identifier such as `name'`.
    fn is_escape_string(&self) -> bool {
        if self.dialect != Dialect::Postgres || self.pos == 0 {
            return false;
        }
        let prev = self.bytes[self.pos - 1];
        (prev == b'E' || prev == b'e') && (self.pos < 2 || !is_word_byte(self.bytes[self.pos - 2]))
    }

    /// Skips `$tag$ … $tag$` if one starts here. `$1` is a parameter and
    /// `a$b` part of an identifier, so neither opens a quote.
    fn skip_dollar_quote(&mut self) -> bool {
        if self.pos > 0 && is_word_byte(self.bytes[self.pos - 1]) {
            return false;
        }
        let mut end = self.pos + 1;
        if end < self.bytes.len() && is_word_start(self.bytes[end]) {
            while end < self.bytes.len() && is_word_byte(self.bytes[end]) && self.bytes[end] != b'$'
            {
                end += 1;
            }
        }
        if self.bytes.get(end) != Some(&b'$') {
            return false;
        }
        let tag = &self.sql[self.pos..=end];
        match self.sql[end + 1..].find(tag) {
            Some(offset) => self.pos = end + 1 + offset + tag.len(),
            None => self.pos = self.bytes.len(),
        }
        true
    }

    /// Reads one identifier or keyword and tracks `BEGIN … END` bodies.
    fn word(&mut self) {
        self.code();
        let start = self.pos;
        while self.pos < self.bytes.len() && is_word_byte(self.bytes[self.pos]) {
            self.pos += 1;
        }
        let word = self.sql[start..self.pos].to_ascii_uppercase();

        if self.first_word.is_none() {
            self.first_word = Some(word);
            return;
        }
        // A body only exists in routine and trigger definitions. A bare
        // `BEGIN` statement is a transaction, and its `;` ends it.
        if self.first_word.as_deref() == Some("CREATE")
            && matches!(
                word.as_str(),
                "TRIGGER" | "FUNCTION" | "PROCEDURE" | "EVENT"
            )
        {
            self.has_body = true;
        }
        if !self.has_body {
            return;
        }
        match word.as_str() {
            "BEGIN" | "CASE" => self.depth += 1,
            // `END IF`, `END LOOP` and friends close blocks that were never
            // counted, so they must not close the body.
            "END"
                if !matches!(
                    self.next_word().as_deref(),
                    Some("IF" | "LOOP" | "WHILE" | "REPEAT" | "FOR")
                ) =>
            {
                self.depth = self.depth.saturating_sub(1);
            }
            _ => {}
        }
    }

    fn next_word(&self) -> Option<String> {
        let rest = &self.bytes[self.pos..];
        let skip = rest.iter().take_while(|b| b.is_ascii_whitespace()).count();
        let from = self.pos + skip;
        let len = self.bytes[from..]
            .iter()
            .take_while(|&&b| is_word_byte(b))
            .count();
        (len > 0).then(|| self.sql[from..from + len].to_ascii_uppercase())
    }
}

fn is_word_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, dialect: Dialect) -> Vec<&str> {
        split(sql, dialect).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_on_semicolons_and_keeps_a_last_statement_without_one() {
        assert_eq!(
            texts("SELECT 1; SELECT 2;\nSELECT 3", Dialect::Generic),
            ["SELECT 1", "SELECT 2", "SELECT 3"]
        );
    }

    #[test]
    fn drops_empty_and_comment_only_statements() {
        assert_eq!(
            texts(" ;; -- nothing\n; /* still nothing */ ;", Dialect::Postgres),
            Vec::<&str>::new()
        );
        assert_eq!(texts("", Dialect::Generic), Vec::<&str>::new());
    }

    #[test]
    fn offsets_point_at_the_text_including_unicode() {
        let sql = "  SELECT 'ünï'  ;\n\tSELECT 2";
        for statement in split(sql, Dialect::Postgres) {
            assert_eq!(&sql[statement.start..statement.end], statement.text);
        }
        assert_eq!(texts(sql, Dialect::Postgres), ["SELECT 'ünï'", "SELECT 2"]);
    }

    #[test]
    fn keeps_a_leading_comment_with_its_statement() {
        assert_eq!(
            texts("-- totals\nSELECT 1;", Dialect::Generic),
            ["-- totals\nSELECT 1"]
        );
    }

    #[test]
    fn ignores_semicolons_in_strings_identifiers_and_comments() {
        let sql = "SELECT 'a;b', 'it''s;', \"odd;name\" -- c;\n /* d; */ FROM t; SELECT 2";
        assert_eq!(texts(sql, Dialect::Postgres).len(), 2);
    }

    #[test]
    fn postgres_escape_strings_take_backslashes() {
        assert_eq!(
            texts(r"SELECT E'\';'; SELECT 2", Dialect::Postgres),
            [r"SELECT E'\';'", "SELECT 2"]
        );
        // A standard string ends at the first quote, backslash or not.
        assert_eq!(
            texts(r"SELECT 'a\'; SELECT 2", Dialect::Postgres),
            [r"SELECT 'a\'", "SELECT 2"]
        );
        // An identifier ending in E is not an escape-string prefix.
        assert_eq!(
            texts(r"SELECT name'\'; SELECT 2", Dialect::Postgres).len(),
            2
        );
    }

    #[test]
    fn postgres_block_comments_nest() {
        assert_eq!(
            texts("/* a /* b; */ c; */ SELECT 1; SELECT 2", Dialect::Postgres).len(),
            2
        );
    }

    #[test]
    fn postgres_dollar_quotes_hide_semicolons() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()";
        assert_eq!(texts(sql, Dialect::Postgres).len(), 2);
        let tagged = "DO $body$ BEGIN PERFORM $$;$$; END $body$; SELECT 1";
        assert_eq!(texts(tagged, Dialect::Postgres).len(), 2);
    }

    #[test]
    fn postgres_positional_parameters_are_not_dollar_quotes() {
        assert_eq!(
            texts("SELECT $1; SELECT $2", Dialect::Postgres),
            ["SELECT $1", "SELECT $2"]
        );
        assert_eq!(texts("SELECT a$b$c; SELECT 2", Dialect::Postgres).len(), 2);
    }

    #[test]
    fn postgres_begin_atomic_bodies_stay_whole() {
        let sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3";
        assert_eq!(texts(sql, Dialect::Postgres).len(), 2);
    }

    #[test]
    fn transactions_split_into_their_statements() {
        assert_eq!(
            texts("BEGIN; UPDATE t SET a = 1; COMMIT;", Dialect::Postgres),
            ["BEGIN", "UPDATE t SET a = 1", "COMMIT"]
        );
    }

    #[test]
    fn case_expressions_outside_bodies_do_not_matter() {
        assert_eq!(
            texts(
                "SELECT CASE WHEN a THEN 1 END FROM t; SELECT 2",
                Dialect::Generic
            )
            .len(),
            2
        );
    }

    #[test]
    fn sqlite_trigger_bodies_stay_whole() {
        let sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); UPDATE c SET x = CASE WHEN 1 THEN 2 END; END; SELECT 1";
        let found = texts(sql, Dialect::Sqlite);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].ends_with("END"));
    }

    #[test]
    fn sqlite_bracket_and_backtick_identifiers() {
        assert_eq!(
            texts("SELECT [a;b], `c;d` FROM t; SELECT 2", Dialect::Sqlite).len(),
            2
        );
    }

    #[test]
    fn mysql_procedures_with_nested_blocks_stay_whole() {
        let sql = "CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; WHILE 0 DO SELECT 2; END WHILE; END; CALL p()";
        let found = texts(sql, Dialect::MySql);
        assert_eq!(
            found,
            [&sql[..sql.find("; CALL").expect("present")], "CALL p()"]
        );
    }

    #[test]
    fn mysql_strings_take_backslashes_and_hash_comments() {
        assert_eq!(
            texts(r#"SELECT 'it\'s;', "x\";" # c;"#, Dialect::MySql).len(),
            1
        );
        assert_eq!(texts("SELECT 1 # a;\n; SELECT 2", Dialect::MySql).len(), 2);
    }

    #[test]
    fn mysql_double_dash_needs_whitespace() {
        // `1--1` is arithmetic in MySQL, so the `;` after it ends the statement.
        assert_eq!(texts("SELECT 1--1; SELECT 2", Dialect::MySql).len(), 2);
        assert_eq!(texts("SELECT 1 -- c;\n; SELECT 2", Dialect::MySql).len(), 2);
    }

    #[test]
    fn unterminated_quotes_run_to_the_end() {
        assert_eq!(
            texts("SELECT 'oops; SELECT 2", Dialect::Postgres),
            ["SELECT 'oops; SELECT 2"]
        );
        assert_eq!(texts("SELECT $$oops; SELECT 2", Dialect::Postgres).len(), 1);
        assert_eq!(
            texts("SELECT 1 /* oops; SELECT 2", Dialect::Postgres).len(),
            1
        );
    }
}
