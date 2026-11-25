//! What it takes to open a connection.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{Engine, Error, Result};

/// How a connection uses TLS, with libpq's meanings.
///
/// A mode is honoured exactly or refused by name; it is never quietly
/// weakened.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    /// Plaintext only.
    Disable,
    /// libpq's "try plaintext first". Quicksilver refuses it: it would send a
    /// password in the clear to any server that accepts plaintext.
    Allow,
    /// TLS if the server offers it, plaintext if it does not.
    #[default]
    Prefer,
    /// TLS always, without verifying the certificate (unless a root
    /// certificate is given, which makes it `VerifyCa`, as libpq does).
    Require,
    /// TLS always, certificate chain verified, host name not checked.
    VerifyCa,
    /// TLS always, chain and host name verified.
    VerifyFull,
}

impl SslMode {
    /// The mode named by a `sslmode` value, as libpq spells it.
    pub fn parse(value: &str) -> Result<SslMode> {
        Ok(match value {
            "disable" => SslMode::Disable,
            "allow" => SslMode::Allow,
            "prefer" => SslMode::Prefer,
            "require" => SslMode::Require,
            "verify-ca" => SslMode::VerifyCa,
            "verify-full" => SslMode::VerifyFull,
            other => return Err(Error::config(format!("unknown sslmode \"{other}\""))),
        })
    }

    /// libpq's spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Allow => "allow",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyCa => "verify-ca",
            SslMode::VerifyFull => "verify-full",
        }
    }
}

impl fmt::Display for SslMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Everything needed to open one connection.
///
/// The password is held here only while connecting; it is stored in the OS
/// keychain, never in a profile file, and never printed by `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    /// Which engine to speak.
    pub engine: Engine,
    /// Host name or IP address, for server engines.
    pub host: Option<String>,
    /// Port; the engine's default when `None`.
    pub port: Option<u16>,
    /// User name. May contain `@` (cloud IAM users do).
    pub user: Option<String>,
    /// Password. Blank is valid and is sent as blank.
    #[serde(skip_serializing)]
    pub password: Option<String>,
    /// Database to open.
    pub database: Option<String>,
    /// File to open, for file engines.
    pub path: Option<PathBuf>,
    /// TLS mode.
    pub ssl_mode: SslMode,
    /// A root certificate (PEM) to verify the server against, instead of the
    /// OS trust store.
    pub ssl_root_cert: Option<PathBuf>,
    /// Any other URL query parameters, kept for the driver to interpret.
    pub options: BTreeMap<String, String>,
    /// Refuse writes. Postgres starts every transaction read-only (a guard
    /// against accidents; `SET` can lift it). SQLite opens the file
    /// read-only, which nothing can lift.
    #[serde(default)]
    pub read_only: bool,
}

impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("engine", &self.engine)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("database", &self.database)
            .field("path", &self.path)
            .field("ssl_mode", &self.ssl_mode)
            .field("ssl_root_cert", &self.ssl_root_cert)
            .field("options", &self.options)
            .field("read_only", &self.read_only)
            .finish()
    }
}

impl ConnectionConfig {
    /// An empty configuration for `engine`.
    pub fn new(engine: Engine) -> Self {
        ConnectionConfig {
            engine,
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: None,
            ssl_mode: SslMode::default(),
            ssl_root_cert: None,
            options: BTreeMap::new(),
            read_only: false,
        }
    }

    /// The port to connect to: the configured one or the engine's default.
    pub fn effective_port(&self) -> Option<u16> {
        self.port.or_else(|| self.engine.default_port())
    }

    /// Parses a connection URL such as
    /// `postgresql://user%40corp:pw@db.example.com:5432/app?sslmode=require`
    /// or `sqlite:///path/to/file.db`.
    ///
    /// The user name and password are percent-decoded, so `@` and `:` in
    /// them are written `%40` and `%3A`. `sslmode` and `sslrootcert` are
    /// read into their fields; other parameters go to `options`.
    pub fn from_url(input: &str) -> Result<Self> {
        let url = url::Url::parse(input.trim())
            .map_err(|err| Error::config(format!("not a connection URL: {err}")))?;
        let engine = Engine::from_url_scheme(url.scheme()).ok_or_else(|| {
            Error::config(format!(
                "no engine uses the URL scheme \"{}\"",
                url.scheme()
            ))
        })?;
        let mut config = ConnectionConfig::new(engine);

        if engine.is_file_based() {
            let path = decode(url.path())?;
            if path.is_empty() || path == "/" {
                return Err(Error::config("the URL names no file"));
            }
            config.path = Some(PathBuf::from(path));
        } else {
            config.host = url.host_str().filter(|h| !h.is_empty()).map(|host| {
                // IPv6 hosts arrive bracketed; drivers want them bare.
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_owned()
            });
            config.port = url.port();
            if !url.username().is_empty() {
                config.user = Some(decode(url.username())?);
            }
            // A password that is present but blank is kept as blank.
            if let Some(password) = url.password() {
                config.password = Some(decode(password)?);
            } else if userinfo_has_blank_password(input) {
                config.password = Some(String::new());
            }
            let database = url.path().trim_start_matches('/');
            if !database.is_empty() {
                config.database = Some(decode(database)?);
            }
        }

        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "sslmode" => config.ssl_mode = SslMode::parse(&value)?,
                "sslrootcert" => config.ssl_root_cert = Some(PathBuf::from(value.as_ref())),
                _ => {
                    config.options.insert(key.into_owned(), value.into_owned());
                }
            }
        }
        Ok(config)
    }
}

/// Whether the URL's user info ends in `:`, as in `user:@host`: a password that
/// is present but blank. The `url` crate reports that the same as no password.
fn userinfo_has_blank_password(input: &str) -> bool {
    let Some((_, rest)) = input.trim().split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.ends_with(':'))
}

fn decode(raw: &str) -> Result<String> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| Error::config("the URL is not valid UTF-8 once decoded"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_postgres_url() {
        let config = ConnectionConfig::from_url(
            "postgresql://app:s3cret@db.example.com:6543/orders?sslmode=verify-full&application_name=qs",
        )
        .expect("parses");
        assert_eq!(config.engine, Engine::Postgres);
        assert_eq!(config.host.as_deref(), Some("db.example.com"));
        assert_eq!(config.port, Some(6543));
        assert_eq!(config.user.as_deref(), Some("app"));
        assert_eq!(config.password.as_deref(), Some("s3cret"));
        assert_eq!(config.database.as_deref(), Some("orders"));
        assert_eq!(config.ssl_mode, SslMode::VerifyFull);
        assert_eq!(
            config.options.get("application_name").map(String::as_str),
            Some("qs")
        );
    }

    #[test]
    fn user_names_may_contain_at_signs() {
        let config = ConnectionConfig::from_url("postgres://alice%40corp.example:pw%3Ax@host/db")
            .expect("parses");
        assert_eq!(config.user.as_deref(), Some("alice@corp.example"));
        assert_eq!(config.password.as_deref(), Some("pw:x"));
    }

    #[test]
    fn a_blank_password_is_kept_as_blank_not_missing() {
        let blank = ConnectionConfig::from_url("postgres://alice:@host/db").expect("parses");
        assert_eq!(blank.password.as_deref(), Some(""));
        let missing = ConnectionConfig::from_url("postgres://alice@host/db").expect("parses");
        assert_eq!(missing.password, None);
        let in_query =
            ConnectionConfig::from_url("postgres://alice@host/db?x=a:@b").expect("parses");
        assert_eq!(in_query.password, None);
    }

    #[test]
    fn defaults_to_prefer_and_the_engine_port() {
        let config = ConnectionConfig::from_url("mysql://root@localhost").expect("parses");
        assert_eq!(config.ssl_mode, SslMode::Prefer);
        assert_eq!(config.port, None);
        assert_eq!(config.effective_port(), Some(3306));
    }

    #[test]
    fn ipv6_hosts_are_unbracketed() {
        let config = ConnectionConfig::from_url("postgres://u@[::1]:5432/db").expect("parses");
        assert_eq!(config.host.as_deref(), Some("::1"));
    }

    #[test]
    fn file_urls_give_a_path() {
        let config = ConnectionConfig::from_url("sqlite:///tmp/my%20data.db").expect("parses");
        assert_eq!(config.path, Some(PathBuf::from("/tmp/my data.db")));
        assert!(ConnectionConfig::from_url("sqlite:///").is_err());
    }

    #[test]
    fn unknown_schemes_and_sslmodes_are_errors() {
        assert!(ConnectionConfig::from_url("ftp://host/db").is_err());
        assert!(ConnectionConfig::from_url("postgres://h/db?sslmode=maybe").is_err());
    }

    #[test]
    fn debug_never_prints_the_password() {
        let config = ConnectionConfig::from_url("postgres://u:hunter2@h/db").expect("parses");
        assert!(!format!("{config:?}").contains("hunter2"));
    }

    #[test]
    fn serializing_never_writes_the_password() {
        let config = ConnectionConfig::from_url("postgres://u:hunter2@h/db").expect("parses");
        let json = serde_json::to_string(&config).expect("serializes");
        assert!(!json.contains("hunter2"));
    }
}
