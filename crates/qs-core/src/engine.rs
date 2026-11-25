//! The database engines Quicksilver knows about.

use serde::{Deserialize, Serialize};

/// A database engine Quicksilver can (or will) connect to.
///
/// Callers ask an `Engine` questions through its methods instead of matching
/// on it, so adding an engine means adding arms here, not special cases in
/// every view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// PostgreSQL and wire-compatible servers.
    Postgres,
    /// MySQL.
    Mysql,
    /// MariaDB.
    Mariadb,
    /// SQLite, a local file.
    Sqlite,
    /// DuckDB, a local file or in memory.
    Duckdb,
    /// Microsoft SQL Server.
    Mssql,
    /// ClickHouse, over HTTP.
    Clickhouse,
    /// MongoDB.
    Mongodb,
    /// Redis and compatible servers (Valkey, KeyDB, Dragonfly).
    Redis,
    /// Snowflake, over its SQL REST API.
    Snowflake,
    /// Turso / libSQL, a local file.
    Turso,
}

impl Engine {
    /// Every engine, in the order the connection form lists them.
    pub const ALL: [Engine; 11] = [
        Engine::Postgres,
        Engine::Mysql,
        Engine::Mariadb,
        Engine::Sqlite,
        Engine::Duckdb,
        Engine::Mssql,
        Engine::Clickhouse,
        Engine::Mongodb,
        Engine::Redis,
        Engine::Snowflake,
        Engine::Turso,
    ];

    /// The name shown to people.
    pub fn display_name(self) -> &'static str {
        match self {
            Engine::Postgres => "PostgreSQL",
            Engine::Mysql => "MySQL",
            Engine::Mariadb => "MariaDB",
            Engine::Sqlite => "SQLite",
            Engine::Duckdb => "DuckDB",
            Engine::Mssql => "SQL Server",
            Engine::Clickhouse => "ClickHouse",
            Engine::Mongodb => "MongoDB",
            Engine::Redis => "Redis",
            Engine::Snowflake => "Snowflake",
            Engine::Turso => "Turso",
        }
    }

    /// The port a server listens on by default, or `None` for engines that
    /// open a local file or have no fixed port.
    pub fn default_port(self) -> Option<u16> {
        match self {
            Engine::Postgres => Some(5432),
            Engine::Mysql | Engine::Mariadb => Some(3306),
            Engine::Mssql => Some(1433),
            Engine::Clickhouse => Some(8123),
            Engine::Mongodb => Some(27017),
            Engine::Redis => Some(6379),
            Engine::Snowflake => Some(443),
            Engine::Sqlite | Engine::Duckdb | Engine::Turso => None,
        }
    }

    /// Whether the engine opens a local file rather than reaching a server.
    pub fn is_file_based(self) -> bool {
        matches!(self, Engine::Sqlite | Engine::Duckdb | Engine::Turso)
    }

    /// The engine a connection URL's scheme names, if any.
    ///
    /// The scheme is matched case-insensitively, as URL schemes are.
    pub fn from_url_scheme(scheme: &str) -> Option<Engine> {
        let engine = match scheme.to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" => Engine::Postgres,
            "mysql" => Engine::Mysql,
            "mariadb" => Engine::Mariadb,
            "sqlite" | "file" => Engine::Sqlite,
            "duckdb" => Engine::Duckdb,
            "mssql" | "sqlserver" => Engine::Mssql,
            "clickhouse" => Engine::Clickhouse,
            "mongodb" | "mongodb+srv" => Engine::Mongodb,
            "redis" | "rediss" | "valkey" => Engine::Redis,
            "snowflake" => Engine::Snowflake,
            "libsql" | "turso" => Engine::Turso,
            _ => return None,
        };
        Some(engine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_engine_has_a_distinct_display_name() {
        let mut names: Vec<_> = Engine::ALL.iter().map(|e| e.display_name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), Engine::ALL.len());
    }

    #[test]
    fn file_engines_have_no_port_and_servers_do() {
        for engine in Engine::ALL {
            assert_eq!(
                engine.is_file_based(),
                engine.default_port().is_none(),
                "{engine:?}"
            );
        }
    }

    #[test]
    fn url_schemes_resolve_case_insensitively() {
        assert_eq!(
            Engine::from_url_scheme("postgresql"),
            Some(Engine::Postgres)
        );
        assert_eq!(Engine::from_url_scheme("PostgreS"), Some(Engine::Postgres));
        assert_eq!(
            Engine::from_url_scheme("mongodb+srv"),
            Some(Engine::Mongodb)
        );
        assert_eq!(Engine::from_url_scheme("rediss"), Some(Engine::Redis));
        assert_eq!(Engine::from_url_scheme("ftp"), None);
    }

    #[test]
    fn engines_serialize_as_lowercase_names() {
        let json = serde_json::to_string(&Engine::Mssql).expect("serializes");
        assert_eq!(json, "\"mssql\"");
    }
}
