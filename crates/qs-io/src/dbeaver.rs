//! Connections saved in DBeaver, read so they can be imported as profiles.
//!
//! A DBeaver workspace holds one directory per project. Each project keeps
//! its connections in `.dbeaver/data-sources*.json` and their user names and
//! passwords in the matching `credentials-config*.json`, encrypted with a key
//! every DBeaver install shares. [`scan`] describes what is there without
//! ever handing a password out; [`import`] reads the files again and saves
//! the chosen connections through the [`Store`], so passwords go only to the
//! keychain.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit};
use qs_core::{Engine, SslMode};
use qs_store::{Auth, Color, Mode, PasswordChange, Profile, ProfileFields, Store};
use serde::Serialize;
use serde_json::{Map, Value};

/// The project DBeaver creates by default. It is left out of the imported
/// folder path, since nearly everyone has only this one.
const DEFAULT_PROJECT: &str = "General";

/// DBeaver's built-in key for `credentials-config.json`. It is published
/// with DBeaver and the same on every install, so it hides the file from a
/// casual look and nothing more.
const CREDENTIALS_KEY: [u8; 16] = [
    0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54, 0x4a,
];

/// What a look for DBeaver's saved connections found. It never holds a
/// password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, rename = "DbeaverScan")]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    /// Whether a DBeaver workspace was found at all.
    pub found: bool,
    /// The workspaces that were read.
    pub workspaces: Vec<PathBuf>,
    /// Every connection found, importable or not.
    pub candidates: Vec<Candidate>,
    /// Things to tell the user about the scan as a whole, such as
    /// credentials that could not be read.
    pub notes: Vec<String>,
}

/// One DBeaver connection, as offered for import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, rename = "DbeaverCandidate")]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Names it for [`import`]: the DBeaver project and connection id.
    pub key: String,
    /// The name DBeaver shows.
    pub name: String,
    /// The `/`-separated folder path it would be imported under.
    pub project: Option<String>,
    /// The engine it would use, when the DBeaver driver maps to one.
    pub engine: Option<Engine>,
    /// A short description: `user@host:port/database`, or the file.
    pub summary: String,
    /// Whether DBeaver has a password saved for it (blank counts).
    pub has_password: bool,
    /// Whether a saved connection already points at the same place.
    pub already_imported: bool,
    /// Why it cannot be imported, when it cannot.
    pub skipped: Option<String>,
}

/// What an import did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, rename = "DbeaverImport")]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The profiles created.
    pub imported: Vec<Profile>,
    /// The connections asked for that were not imported, and why.
    pub skipped: Vec<Skipped>,
}

/// A connection that was not imported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, rename = "DbeaverSkipped")]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// Its DBeaver name.
    pub name: String,
    /// Why.
    pub reason: String,
}

/// The DBeaver workspaces on this machine, in the places DBeaver uses on
/// each OS (including the Linux Flatpak and Snap packages). Only those that
/// exist are returned.
pub fn default_workspaces() -> Vec<PathBuf> {
    let env = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let home = env("HOME").or_else(|| env("USERPROFILE"));
    let mut roots = Vec::new();
    if cfg!(target_os = "macos") {
        roots.extend(home.iter().map(|h| h.join("Library/DBeaverData")));
    } else if cfg!(windows) {
        roots.extend(env("APPDATA").map(|a| a.join("DBeaverData")));
    } else {
        let data = env("XDG_DATA_HOME").or_else(|| home.as_ref().map(|h| h.join(".local/share")));
        roots.extend(data.map(|d| d.join("DBeaverData")));
        if let Some(home) = &home {
            roots.push(home.join(".local/share/DBeaverData"));
            roots.push(home.join(".var/app/io.dbeaver.DBeaverCommunity/data/DBeaverData"));
            roots.push(home.join("snap/dbeaver-ce/current/.local/share/DBeaverData"));
        }
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for workspace in roots.into_iter().map(|r| r.join("workspace6")) {
        if workspace.is_dir() && !found.contains(&workspace) {
            found.push(workspace);
        }
    }
    found
}

/// Describes the connections saved in `workspaces`, marking those that
/// `existing` profiles already point at.
pub fn scan(workspaces: &[PathBuf], existing: &[Profile]) -> Scan {
    let read = read(workspaces);
    let candidates = read
        .found
        .iter()
        .map(|f| Candidate {
            key: f.key.clone(),
            name: f.name.clone(),
            project: f.project.clone(),
            engine: f.engine,
            summary: f.summary.clone(),
            has_password: f.password().is_some(),
            already_imported: f.already_imported(existing),
            skipped: f.fields.as_ref().err().cloned(),
        })
        .collect();
    Scan {
        found: !workspaces.is_empty(),
        workspaces: workspaces.to_vec(),
        candidates,
        notes: read.notes,
    }
}

/// Reads `workspaces` again and saves the connections named by `keys` as
/// profiles in `store`, with their DBeaver passwords in the keychain when
/// `passwords` is set. A connection with no password to bring along is saved
/// to ask for one when it connects. Connections that cannot be imported, or
/// that a saved profile already points at, are reported as skipped.
pub fn import(store: &Store, workspaces: &[PathBuf], keys: &[String], passwords: bool) -> Imported {
    let read = read(workspaces);
    let existing = store.profiles();
    let mut result = Imported {
        imported: Vec::new(),
        skipped: Vec::new(),
    };
    for key in keys {
        let Some(found) = read.found.iter().find(|f| &f.key == key) else {
            result.skipped.push(Skipped {
                name: key.clone(),
                reason: "it is no longer in DBeaver's files".into(),
            });
            continue;
        };
        let skip = |reason: String| Skipped {
            name: found.name.clone(),
            reason,
        };
        let fields = match &found.fields {
            Ok(fields) => fields.clone(),
            Err(reason) => {
                result.skipped.push(skip(reason.clone()));
                continue;
            }
        };
        if found.already_imported(&existing) {
            result
                .skipped
                .push(skip("a saved connection already points there".into()));
            continue;
        }
        let password = match found.password() {
            Some(password) if passwords => PasswordChange::Set {
                password: password.to_owned(),
            },
            _ => PasswordChange::Keep,
        };
        match store.create_profile(fields, password) {
            Ok(profile) => result.imported.push(profile),
            Err(err) => result.skipped.push(skip(err.to_string())),
        }
    }
    result
}

/// One DBeaver connection, mapped.
struct Found {
    key: String,
    name: String,
    project: Option<String>,
    engine: Option<Engine>,
    summary: String,
    /// The profile it becomes, or why it cannot be imported.
    fields: std::result::Result<ProfileFields, String>,
    /// Its saved password. Never serialised, never logged.
    password: Option<String>,
}

impl Found {
    /// The password to bring along: only for connections that use one.
    fn password(&self) -> Option<&str> {
        match &self.fields {
            Ok(fields) if fields.auth == Auth::Keychain => self.password.as_deref(),
            _ => None,
        }
    }

    fn already_imported(&self, existing: &[Profile]) -> bool {
        self.fields
            .as_ref()
            .is_ok_and(|fields| existing.iter().any(|p| same_place(&p.fields, fields)))
    }
}

/// Whether two profiles reach the same database as the same user.
fn same_place(a: &ProfileFields, b: &ProfileFields) -> bool {
    let host = |f: &ProfileFields| f.host.as_ref().map(|h| h.to_ascii_lowercase());
    let port = |f: &ProfileFields| f.port.or_else(|| f.engine.default_port());
    a.engine == b.engine
        && host(a) == host(b)
        && port(a) == port(b)
        && a.database == b.database
        && a.user == b.user
        && a.path == b.path
}

struct Read {
    found: Vec<Found>,
    notes: Vec<String>,
}

fn read(workspaces: &[PathBuf]) -> Read {
    let mut read = Read {
        found: Vec::new(),
        notes: Vec::new(),
    };
    for workspace in workspaces {
        let Ok(entries) = fs::read_dir(workspace) else {
            read.notes
                .push(format!("{} could not be read", workspace.display()));
            continue;
        };
        let mut projects: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.join(".dbeaver").is_dir())
            .collect();
        projects.sort();
        for project in projects {
            read_project(&project, &mut read);
        }
    }
    read.found.sort_by(|a, b| {
        (a.project.as_deref().unwrap_or(""), a.name.to_lowercase())
            .cmp(&(b.project.as_deref().unwrap_or(""), b.name.to_lowercase()))
    });
    read
}

fn read_project(dir: &Path, read: &mut Read) {
    let project = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config = dir.join(".dbeaver");
    let Ok(entries) = fs::read_dir(&config) else {
        return;
    };
    // `data-sources.json`, then `data-sources-2.json` and the like.
    let mut suffixes: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let suffix = name.strip_prefix("data-sources")?.strip_suffix(".json")?;
            Some(suffix.to_owned())
        })
        .collect();
    suffixes.sort();
    for suffix in suffixes {
        let file = config.join(format!("data-sources{suffix}.json"));
        let sources = match fs::read(&file)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
        {
            Ok(sources) => sources,
            Err(err) => {
                read.notes
                    .push(format!("{} could not be read: {err}", file.display()));
                continue;
            }
        };
        let credentials = read_credentials(
            &config.join(format!("credentials-config{suffix}.json")),
            &project,
            &mut read.notes,
        );
        let empty = Map::new();
        let section = |name: &str| {
            sources
                .get(name)
                .and_then(Value::as_object)
                .unwrap_or(&empty)
        };
        let file = DataSources {
            project: &project,
            folders: section("folders"),
            types: section("connection-types"),
            credentials: &credentials,
        };
        for (id, connection) in section("connections") {
            read.found.push(file.map(id, connection, &mut read.notes));
        }
    }
}

/// A user name and password saved by DBeaver.
#[derive(Default)]
struct Credentials {
    user: Option<String>,
    password: Option<String>,
}

/// The credentials in `path`, by connection id. A missing file is no
/// credentials; one that cannot be decrypted is reported in `notes`.
fn read_credentials(
    path: &Path,
    project: &str,
    notes: &mut Vec<String>,
) -> BTreeMap<String, Credentials> {
    let Ok(bytes) = fs::read(path) else {
        return BTreeMap::new();
    };
    let parsed = decrypt(&bytes).and_then(|plain| {
        serde_json::from_slice::<Map<String, Value>>(&plain).map_err(|e| e.to_string())
    });
    match parsed {
        Ok(map) => map
            .into_iter()
            .map(|(id, entry)| {
                let connection = entry.get("#connection");
                let field = |name: &str| {
                    connection
                        .and_then(|c| c.get(name))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                };
                let credentials = Credentials {
                    user: field("user").filter(|u| !u.is_empty()),
                    // A blank saved password stays blank.
                    password: field("password"),
                };
                (id, credentials)
            })
            .collect(),
        Err(_) => {
            notes.push(format!(
                "DBeaver's saved credentials for project {project} could not be decrypted, so its connections are imported without user names or passwords"
            ));
            BTreeMap::new()
        }
    }
}

/// Decrypts a `credentials-config.json`: AES-128-CBC with PKCS#5 padding,
/// the first block being the IV.
fn decrypt(bytes: &[u8]) -> std::result::Result<Vec<u8>, String> {
    if bytes.len() < 32 || !bytes.len().is_multiple_of(16) {
        return Err("not an encrypted credentials file".into());
    }
    let (iv, body) = bytes.split_at(16);
    let mut buf = body.to_vec();
    let cipher = cbc::Decryptor::<Aes128>::new_from_slices(&CREDENTIALS_KEY, iv)
        .map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt_padded::<Pkcs7>(&mut buf)
        .map_err(|_| "the credentials file did not decrypt".to_owned())?;
    Ok(plain.to_vec())
}

/// One `data-sources*.json`, with what its connections refer to.
struct DataSources<'a> {
    project: &'a str,
    folders: &'a Map<String, Value>,
    types: &'a Map<String, Value>,
    credentials: &'a BTreeMap<String, Credentials>,
}

impl DataSources<'_> {
    fn map(&self, id: &str, connection: &Value, notes: &mut Vec<String>) -> Found {
        let none = Credentials::default();
        let credentials = self.credentials.get(id).unwrap_or(&none);
        let name = text(connection, "name").unwrap_or_else(|| id.to_owned());
        let folder = text(connection, "folder").map(|f| self.folder_path(&f));
        let project = [
            Some(self.project).filter(|p| *p != DEFAULT_PROJECT),
            folder.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/");
        let provider = text(connection, "provider").unwrap_or_default();
        let driver = text(connection, "driver").unwrap_or_default();
        let engine = engine_for(&provider, &driver);
        let config = connection.get("configuration").unwrap_or(&Value::Null);
        let mut found = Found {
            key: format!("{}/{id}", self.project),
            name: name.clone(),
            project: Some(project).filter(|p| !p.is_empty()),
            engine: engine.as_ref().ok().copied(),
            summary: if driver.is_empty() {
                provider.clone()
            } else {
                format!("{provider} ({driver})")
            },
            fields: Err(String::new()),
            password: credentials.password.clone(),
        };
        let engine = match engine {
            Ok(engine) => engine,
            Err(reason) => {
                found.fields = Err(reason);
                return found;
            }
        };
        let mut fields = ProfileFields {
            name: name.clone(),
            project: found.project.clone(),
            color: text(config, "type").and_then(|t| self.color(&t)),
            engine,
            host: text(config, "host"),
            port: text(config, "port").and_then(|p| p.parse().ok()),
            user: credentials.user.clone().or_else(|| text(config, "user")),
            database: text(config, "database"),
            path: None,
            ssl_mode: SslMode::default(),
            ssl_root_cert: None,
            options: BTreeMap::new(),
            auth: if engine.is_file_based() {
                Auth::NoPassword
            } else {
                Auth::Keychain
            },
            mode: if connection.get("read-only").and_then(Value::as_bool) == Some(true) {
                Mode::ReadOnly
            } else {
                Mode::ReadWrite
            },
        };
        let url = text(config, "url").and_then(|u| parse_jdbc(&u));
        if engine.is_file_based() {
            fields.path = url
                .as_ref()
                .and_then(|u| u.path.clone())
                .or_else(|| fields.database.take().map(PathBuf::from));
            fields.database = None;
            fields.host = None;
            fields.port = None;
            fields.user = None;
        } else if let Some(url) = &url {
            fields.host = fields.host.or_else(|| url.host.clone());
            fields.port = fields.port.or(url.port);
            fields.database = fields.database.or_else(|| url.database.clone());
            if engine == Engine::Postgres
                && let Some(mode) = &url.ssl_mode
            {
                fields.ssl_mode = *mode;
            }
        }
        self.network(&name, engine, config, &mut fields, notes);
        if let Some(model) = text(config, "auth-model").filter(|m| m != "native")
            && !engine.is_file_based()
        {
            notes.push(format!(
                "{name} uses DBeaver's \"{model}\" sign-in; it is imported to ask for a password instead"
            ));
        }
        found.summary = summary(&fields);
        found.fields = if engine.is_file_based() && fields.path.is_none() {
            Err("no database file is set".into())
        } else if !engine.is_file_based() && fields.host.is_none() {
            Err("no host is set, and the JDBC URL could not be read".into())
        } else {
            Ok(fields)
        };
        found
    }

    /// The folder's full path, walking up its parents. A folder key may
    /// already be the full path, or only a name with a parent.
    fn folder_path(&self, key: &str) -> String {
        let mut parts = Vec::new();
        let mut current = key.to_owned();
        for _ in 0..64 {
            let parent = self
                .folders
                .get(&current)
                .and_then(|f| text(f, "parent"))
                .filter(|p| p != &current);
            match parent {
                Some(parent) => {
                    let name = current.rsplit('/').next().unwrap_or(&current).to_owned();
                    parts.push(name);
                    current = parent;
                }
                None => break,
            }
        }
        parts.push(current);
        parts.reverse();
        parts
            .iter()
            .flat_map(|p| p.split('/'))
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// The marker colour for connection type `id`, when it is clearly one
    /// of Quicksilver's.
    fn color(&self, id: &str) -> Option<Color> {
        match self.types.get(id).and_then(|t| text(t, "color")) {
            Some(rgb) => nearest_color(&rgb),
            // DBeaver's built-in production type is red unless changed.
            None if id == "prod" => Some(Color::Red),
            None => None,
        }
    }

    /// Applies the TLS settings in DBeaver's network handlers, and notes
    /// the ones Quicksilver does not import.
    fn network(
        &self,
        name: &str,
        engine: Engine,
        config: &Value,
        fields: &mut ProfileFields,
        notes: &mut Vec<String>,
    ) {
        let Some(handlers) = config.get("handlers").and_then(Value::as_object) else {
            return;
        };
        for (id, handler) in handlers {
            if handler.get("enabled").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let lower = id.to_ascii_lowercase();
            if lower.contains("ssh") {
                notes.push(format!(
                    "{name} uses an SSH tunnel, which Quicksilver cannot import yet; it is imported without it"
                ));
            } else if lower.contains("ssl") || lower.contains("tls") {
                let properties = handler.get("properties").and_then(Value::as_object);
                let property = |want: &str| {
                    properties.and_then(|p| {
                        p.iter()
                            .find(|(k, _)| squash(k).contains(want))
                            .and_then(|(_, v)| value_text(v))
                    })
                };
                let mode = property("sslmode")
                    .and_then(|m| SslMode::parse(&m.to_ascii_lowercase().replace('_', "-")).ok());
                fields.ssl_root_cert = property("rootcert")
                    .or_else(|| property("cacert"))
                    .map(PathBuf::from);
                match mode {
                    Some(mode) if engine == Engine::Postgres => fields.ssl_mode = mode,
                    _ => {
                        fields.ssl_mode = if fields.ssl_root_cert.is_some() {
                            SslMode::VerifyCa
                        } else {
                            SslMode::Require
                        };
                        notes.push(format!(
                            "{name} uses SSL settings Quicksilver could not read exactly; it is imported with TLS mode {}, so check it",
                            fields.ssl_mode
                        ));
                    }
                }
            } else {
                notes.push(format!(
                    "{name} uses DBeaver's \"{id}\" network setting, which is not imported"
                ));
            }
        }
    }
}

/// Lower case, without the separators DBeaver property names vary in.
fn squash(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The engine for a DBeaver provider and driver id.
fn engine_for(provider: &str, driver: &str) -> std::result::Result<Engine, String> {
    let provider_id = provider.to_ascii_lowercase();
    let driver_id = driver.to_ascii_lowercase();
    // Redshift speaks the PostgreSQL protocol; its catalog differs in
    // places, but queries and browsing work over the Postgres driver.
    if driver_id.contains("redshift") || provider_id.contains("redshift") {
        return Ok(Engine::Postgres);
    }
    for (needle, engine) in [
        ("sqlite", Engine::Sqlite),
        ("duckdb", Engine::Duckdb),
        ("maria", Engine::Mariadb),
    ] {
        if driver_id.contains(needle) {
            return Ok(engine);
        }
    }
    Ok(match provider_id.as_str() {
        // Servers that speak the PostgreSQL protocol.
        "postgresql" | "postgres" | "greenplum" | "timescale" | "timescaledb" | "yugabyte"
        | "yugabytedb" | "cockroach" | "cockroachdb" => Engine::Postgres,
        "mysql" => Engine::Mysql,
        "mariadb" => Engine::Mariadb,
        "sqlite" => Engine::Sqlite,
        "duckdb" => Engine::Duckdb,
        "sqlserver" | "mssql" => Engine::Mssql,
        "clickhouse" | "yandex_clickhouse" => Engine::Clickhouse,
        "mongodb" | "mongo" => Engine::Mongodb,
        "redis" => Engine::Redis,
        "snowflake" => Engine::Snowflake,
        "generic" => {
            let by_driver = [
                ("clickhouse", Engine::Clickhouse),
                ("snowflake", Engine::Snowflake),
            ];
            return by_driver
                .into_iter()
                .find(|(needle, _)| driver_id.contains(needle))
                .map(|(_, engine)| engine)
                .ok_or_else(|| {
                    format!("DBeaver's \"{driver}\" driver is not one Quicksilver can use")
                });
        }
        "" => return Err("DBeaver does not say which database it is".into()),
        _ => return Err(format!("{provider} connections are not supported")),
    })
}

/// What a JDBC URL says.
#[derive(Debug, Default, PartialEq, Eq)]
struct Jdbc {
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    path: Option<PathBuf>,
    ssl_mode: Option<SslMode>,
}

/// Reads the common JDBC URL shapes: `jdbc:<engine>://host:port/db?params`,
/// SQL Server's `jdbc:sqlserver://host:port;databaseName=db`, and
/// `jdbc:sqlite:<path>` or `jdbc:duckdb:<path>`.
fn parse_jdbc(url: &str) -> Option<Jdbc> {
    let (scheme, rest) = url.strip_prefix("jdbc:")?.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme == "sqlite" || scheme == "duckdb" {
        let path = rest.strip_prefix("file:").unwrap_or(rest);
        let path = path.split('?').next().unwrap_or(path).trim();
        return Some(Jdbc {
            path: (!path.is_empty() && path != ":memory:").then(|| PathBuf::from(path)),
            ..Jdbc::default()
        });
    }
    if !matches!(
        scheme.as_str(),
        "postgresql" | "mysql" | "mariadb" | "clickhouse" | "ch" | "sqlserver"
    ) {
        return None;
    }
    // `//host` or, for newer ClickHouse drivers, `http://host`.
    let rest = rest
        .strip_prefix("//")
        .or_else(|| rest.split_once("://").map(|(_, r)| r))?;
    let mut jdbc = Jdbc::default();
    let (authority, database, params): (&str, Option<&str>, Vec<(&str, &str)>) =
        if scheme == "sqlserver" {
            let mut parts = rest.split(';');
            let authority = parts.next().unwrap_or("");
            let params: Vec<_> = parts.filter_map(|p| p.split_once('=')).collect();
            let database = params
                .iter()
                .find(|(k, _)| {
                    k.eq_ignore_ascii_case("databaseName") || k.eq_ignore_ascii_case("database")
                })
                .map(|(_, v)| *v);
            (authority, database, params)
        } else {
            let (before, query) = rest.split_once('?').unwrap_or((rest, ""));
            let (authority, database) = match before.split_once('/') {
                Some((a, d)) => (a, Some(d)),
                None => (before, None),
            };
            let params = query.split('&').filter_map(|p| p.split_once('=')).collect();
            (authority, database, params)
        };
    // Drop any `user:password@`; credentials come from DBeaver's own file.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        (host, after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    let host = host.split('\\').next().unwrap_or(host).trim();
    jdbc.host = (!host.is_empty()).then(|| host.to_owned());
    jdbc.port = port.and_then(|p| p.trim().parse().ok());
    jdbc.database = database
        .map(|d| d.trim_end_matches('/').trim())
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    jdbc.ssl_mode = params
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("sslmode"))
        .and_then(|(_, v)| SslMode::parse(v).ok());
    Some(jdbc)
}

/// `user@host:port/database`, or the file, for the scan list.
fn summary(fields: &ProfileFields) -> String {
    if let Some(path) = &fields.path {
        return path.display().to_string();
    }
    let mut out = String::new();
    if let Some(user) = &fields.user {
        out.push_str(user);
        out.push('@');
    }
    out.push_str(fields.host.as_deref().unwrap_or("?"));
    if let Some(port) = fields.port {
        out.push_str(&format!(":{port}"));
    }
    if let Some(database) = &fields.database {
        out.push('/');
        out.push_str(database);
    }
    out
}

/// The closest marker colour to DBeaver's `"r,g,b"`, or none for white,
/// black and greys (DBeaver's default type is white).
fn nearest_color(rgb: &str) -> Option<Color> {
    let parts: Vec<f32> = rgb
        .split(',')
        .map(|p| p.trim().parse::<u8>().map(f32::from))
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    let [r, g, b] = parts[..] else {
        return None;
    };
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let chroma = max - min;
    if chroma < 40.0 {
        return None;
    }
    let hue = if max == r {
        60.0 * ((g - b) / chroma).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / chroma + 2.0)
    } else {
        60.0 * ((r - g) / chroma + 4.0)
    };
    Some(match hue {
        h if h < 20.0 => Color::Red,
        h if h < 45.0 => Color::Orange,
        h if h < 70.0 => Color::Yellow,
        h if h < 160.0 => Color::Green,
        h if h < 200.0 => Color::Teal,
        h if h < 260.0 => Color::Blue,
        h if h < 330.0 => Color::Purple,
        _ => Color::Red,
    })
}

/// A non-empty string or number field of `value`, as text.
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(value_text)
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use cbc::cipher::BlockModeEncrypt;
    use qs_store::{DataDir, MemorySecrets};
    use serde_json::json;

    use super::*;

    fn encrypt(plain: &[u8], iv: [u8; 16]) -> Vec<u8> {
        let mut buf = plain.to_vec();
        buf.resize(plain.len() + 16, 0);
        let cipher = cbc::Encryptor::<Aes128>::new_from_slices(&CREDENTIALS_KEY, &iv)
            .unwrap_or_else(|e| panic!("{e}"));
        let body = cipher
            .encrypt_padded::<Pkcs7>(&mut buf, plain.len())
            .unwrap_or_else(|e| panic!("{e}"))
            .to_vec();
        [iv.to_vec(), body].concat()
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap_or_else(|e| panic!("{e}"));
        }
        fs::write(path, bytes).unwrap_or_else(|e| panic!("{e}"));
    }

    /// A workspace with a `General` project (two files) and a `Clients`
    /// project.
    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let general = dir.path().join("General/.dbeaver");
        let sources = json!({
            "folders": {
                "Work": {},
                "Client A": { "parent": "Work" },
                "Work/Client B": { "parent": "Work" }
            },
            "connections": {
                "pg-1": {
                    "provider": "postgresql", "driver": "postgres-jdbc", "name": "Orders",
                    "folder": "Client A", "save-password": true, "read-only": true,
                    "configuration": {
                        "host": "db.example.com", "port": "6543", "database": "orders",
                        "url": "jdbc:postgresql://db.example.com:6543/orders",
                        "type": "prod", "auth-model": "native",
                        "handlers": { "ssh_tunnel": { "enabled": true } }
                    }
                },
                "pg-url": {
                    "provider": "postgresql", "driver": "postgres-jdbc", "name": "By URL",
                    "folder": "Work/Client B",
                    "configuration": {
                        "url": "jdbc:postgresql://[::1]:5433/app?sslmode=verify-full",
                        "type": "dev", "user": "me@corp"
                    }
                },
                "es-1": {
                    "provider": "elasticsearch", "driver": "elastic_search_jdbc", "name": "Search",
                    "configuration": { "host": "es", "port": 9200, "url": "jdbc:es://es:9200/" }
                },
                "bad-url": {
                    "provider": "mysql", "driver": "mysql8", "name": "Odd",
                    "configuration": { "url": "jdbc:mysql:loadbalance:something" }
                }
            },
            "connection-types": {
                "dev": { "color": "255,255,255" },
                "prod": { "color": "247,159,129" }
            }
        });
        write(
            &general.join("data-sources.json"),
            sources.to_string().as_bytes(),
        );
        let credentials = json!({
            "pg-1": { "#connection": { "user": "alice", "password": "" } },
            "pg-url": { "#connection": { "password": "s3cret" } }
        });
        write(
            &general.join("credentials-config.json"),
            &encrypt(credentials.to_string().as_bytes(), [7; 16]),
        );
        let second = json!({
            "connections": {
                "lite": {
                    "provider": "generic", "driver": "sqlite_jdbc", "name": "Local",
                    "configuration": { "url": "jdbc:sqlite:/tmp/local.db" }
                }
            }
        });
        write(
            &general.join("data-sources-2.json"),
            second.to_string().as_bytes(),
        );
        let clients = dir.path().join("Clients/.dbeaver");
        let third = json!({
            "connections": {
                "maria": {
                    "provider": "mysql", "driver": "mariaDB", "name": "Shop",
                    "configuration": { "host": "shop", "port": "3307", "database": "shop" }
                }
            }
        });
        write(
            &clients.join("data-sources.json"),
            third.to_string().as_bytes(),
        );
        // Not encrypted with DBeaver's key, so it cannot be read.
        write(&clients.join("credentials-config.json"), &[1; 48]);
        dir
    }

    fn candidate<'a>(scan: &'a Scan, key: &str) -> &'a Candidate {
        scan.candidates
            .iter()
            .find(|c| c.key == key)
            .unwrap_or_else(|| panic!("no {key} in {scan:?}"))
    }

    #[test]
    fn credentials_round_trip_through_dbeavers_encryption() {
        let plain = br##"{"id":{"#connection":{"user":"u","password":"p"}}}"##;
        let encrypted = encrypt(plain, [3; 16]);
        assert_eq!(decrypt(&encrypted).as_deref(), Ok(&plain[..]));
        assert!(decrypt(&[0; 48]).is_err());
        assert!(decrypt(b"{}").is_err());
    }

    #[test]
    fn a_scan_maps_connections_and_never_holds_a_password() {
        let dir = workspace();
        let scan = scan(&[dir.path().to_path_buf()], &[]);
        assert!(scan.found);
        assert_eq!(scan.candidates.len(), 6, "{scan:?}");

        let orders = candidate(&scan, "General/pg-1");
        assert_eq!(orders.project.as_deref(), Some("Work/Client A"));
        assert_eq!(orders.engine, Some(Engine::Postgres));
        assert_eq!(orders.summary, "alice@db.example.com:6543/orders");
        assert!(orders.has_password, "a blank saved password still counts");
        assert_eq!(orders.skipped, None);

        let by_url = candidate(&scan, "General/pg-url");
        assert_eq!(by_url.project.as_deref(), Some("Work/Client B"));
        assert_eq!(by_url.summary, "me@corp@::1:5433/app");

        let search = candidate(&scan, "General/es-1");
        assert_eq!(search.engine, None);
        assert!(search.skipped.is_some());
        assert!(candidate(&scan, "General/bad-url").skipped.is_some());

        let local = candidate(&scan, "General/lite");
        assert_eq!(local.engine, Some(Engine::Sqlite));
        assert_eq!(local.summary, "/tmp/local.db");
        assert!(!local.has_password);

        let shop = candidate(&scan, "Clients/maria");
        assert_eq!(shop.project.as_deref(), Some("Clients"));
        assert_eq!(shop.engine, Some(Engine::Mariadb));
        assert!(!shop.has_password);

        assert!(
            scan.notes
                .iter()
                .any(|n| n.contains("Orders") && n.contains("SSH"))
        );
        assert!(
            scan.notes
                .iter()
                .any(|n| n.contains("Clients") && n.contains("decrypted"))
        );
        let json = serde_json::to_string(&scan).unwrap_or_default();
        assert!(!json.contains("s3cret"), "{json}");
        assert!(json.contains("\"hasPassword\":true"), "{json}");
    }

    #[test]
    fn importing_saves_passwords_to_the_keychain_and_skips_what_is_there() {
        let dir = workspace();
        let data = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Store::open(DataDir::at(data.path()), Box::new(MemorySecrets::new()))
            .unwrap_or_else(|e| panic!("{e}"));
        let workspaces = [dir.path().to_path_buf()];
        let keys: Vec<String> = [
            "General/pg-1",
            "General/pg-url",
            "General/es-1",
            "General/lite",
            "gone",
        ]
        .map(str::to_owned)
        .to_vec();
        let result = import(&store, &workspaces, &keys, true);
        assert_eq!(result.imported.len(), 3, "{result:?}");
        assert_eq!(result.skipped.len(), 2, "{result:?}");

        let orders = &result.imported[0].fields;
        assert_eq!(orders.name, "Orders");
        assert_eq!(orders.mode, Mode::ReadOnly);
        assert_eq!(orders.color, Some(Color::Red));
        assert_eq!(orders.auth, Auth::Keychain);
        assert_eq!(orders.port, Some(6543));
        let id = &result.imported[0].id;
        assert_eq!(store.saved_password(id).ok().flatten().as_deref(), Some(""));

        let by_url = &result.imported[1];
        assert_eq!(by_url.fields.host.as_deref(), Some("::1"));
        assert_eq!(by_url.fields.ssl_mode, SslMode::VerifyFull);
        assert_eq!(by_url.fields.color, None);
        assert_eq!(
            store.saved_password(&by_url.id).ok().flatten().as_deref(),
            Some("s3cret")
        );

        let local = &result.imported[2].fields;
        assert_eq!(local.path.as_deref(), Some(Path::new("/tmp/local.db")));
        assert_eq!(local.auth, Auth::NoPassword);

        // Everything imported is now marked, and importing it again skips it.
        let again = scan(&workspaces, &store.profiles());
        assert!(candidate(&again, "General/pg-1").already_imported);
        assert!(!candidate(&again, "Clients/maria").already_imported);
        let twice = import(&store, &workspaces, &keys[..1], true);
        assert!(twice.imported.is_empty());
        assert_eq!(twice.skipped.len(), 1);
    }

    #[test]
    fn without_passwords_connections_ask_on_connect() {
        let dir = workspace();
        let data = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Store::open(DataDir::at(data.path()), Box::new(MemorySecrets::new()))
            .unwrap_or_else(|e| panic!("{e}"));
        let keys = ["General/pg-url".to_owned(), "Clients/maria".to_owned()];
        let result = import(&store, &[dir.path().to_path_buf()], &keys, false);
        assert_eq!(result.imported.len(), 2, "{result:?}");
        for profile in &result.imported {
            assert_eq!(profile.fields.auth, Auth::Keychain);
            assert_eq!(store.saved_password(&profile.id).ok().flatten(), None);
        }
    }

    #[test]
    fn folders_resolve_by_walking_parents() {
        let folders = json!({
            "A": {},
            "B": { "parent": "A" },
            "A/B/C": { "parent": "B" },
            "loop": { "parent": "loop" }
        });
        let folders = folders.as_object().cloned().unwrap_or_default();
        let (types, credentials) = (Map::new(), BTreeMap::new());
        let file = DataSources {
            project: "P",
            folders: &folders,
            types: &types,
            credentials: &credentials,
        };
        assert_eq!(file.folder_path("B"), "A/B");
        assert_eq!(file.folder_path("A/B/C"), "A/B/C");
        assert_eq!(file.folder_path("Unknown/Deep"), "Unknown/Deep");
        assert_eq!(file.folder_path("loop"), "loop");
    }

    #[test]
    fn jdbc_urls_are_read() {
        let pg = parse_jdbc("jdbc:postgresql://h:5433/db?sslmode=require&x=1");
        assert_eq!(
            pg,
            Some(Jdbc {
                host: Some("h".into()),
                port: Some(5433),
                database: Some("db".into()),
                path: None,
                ssl_mode: Some(SslMode::Require),
            })
        );
        let mysql = parse_jdbc("jdbc:mysql://h/shop").unwrap_or_default();
        assert_eq!((mysql.host.as_deref(), mysql.port), (Some("h"), None));
        let mssql = parse_jdbc("jdbc:sqlserver://h\\SQL:1434;databaseName=app;encrypt=true")
            .unwrap_or_default();
        assert_eq!(mssql.host.as_deref(), Some("h"));
        assert_eq!(mssql.database.as_deref(), Some("app"));
        let ch = parse_jdbc("jdbc:clickhouse:http://h:8123").unwrap_or_default();
        assert_eq!((ch.host.as_deref(), ch.port), (Some("h"), Some(8123)));
        let lite = parse_jdbc("jdbc:sqlite:C:\\data\\x.db").unwrap_or_default();
        assert_eq!(lite.path, Some(PathBuf::from("C:\\data\\x.db")));
        assert_eq!(parse_jdbc("jdbc:es://h:9200/"), None);
        assert_eq!(parse_jdbc("postgresql://h/db"), None);
    }

    #[test]
    fn colours_map_to_the_nearest_marker() {
        assert_eq!(nearest_color("255,255,255"), None);
        assert_eq!(nearest_color("128,128,128"), None);
        assert_eq!(nearest_color("247,159,129"), Some(Color::Red));
        assert_eq!(nearest_color("196,255,181"), Some(Color::Green));
        assert_eq!(nearest_color("0,0,255"), Some(Color::Blue));
        assert_eq!(nearest_color("255,165,0"), Some(Color::Orange));
        assert_eq!(nearest_color("bad"), None);
    }

    #[test]
    fn providers_map_to_engines() {
        assert_eq!(
            engine_for("postgresql", "postgres-jdbc"),
            Ok(Engine::Postgres)
        );
        assert_eq!(engine_for("mysql", "mariaDB"), Ok(Engine::Mariadb));
        assert_eq!(engine_for("generic", "duckdb_jdbc"), Ok(Engine::Duckdb));
        assert_eq!(
            engine_for("sqlserver", "mssql_jdbc_ms_new"),
            Ok(Engine::Mssql)
        );
        assert_eq!(
            engine_for("clickhouse", "com_clickhouse"),
            Ok(Engine::Clickhouse)
        );
        assert_eq!(engine_for("redshift", "redshift"), Ok(Engine::Postgres));
        assert!(engine_for("oracle", "oracle_thin").is_err());
        assert!(engine_for("generic", "h2_embedded").is_err());
    }
}
