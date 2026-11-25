//! Connection profiles: what to connect to, never the password.
//!
//! Profiles live in one JSON file people can read and back up. A file that
//! cannot be read is moved aside and kept, never overwritten; a file written
//! by a newer Quicksilver is left alone and saving is refused.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use qs_core::{ConnectionConfig, Engine, Error, Result, SslMode};
use serde::{Deserialize, Serialize};

use crate::files::{io_error, move_aside, write_atomic};
use crate::{Notice, Recovered};

/// The profile file format this build reads and writes.
pub const PROFILES_VERSION: u32 = 1;

/// A colour that marks a connection everywhere it appears, so production
/// looks different from staging. A fixed set, not a theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Color {
    /// Red.
    Red,
    /// Orange.
    Orange,
    /// Yellow.
    Yellow,
    /// Green.
    Green,
    /// Teal.
    Teal,
    /// Blue.
    Blue,
    /// Purple.
    Purple,
    /// Grey.
    Gray,
}

/// What a connection may do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Writes are refused by the driver (see
    /// [`ConnectionConfig::read_only`]).
    ReadOnly,
    /// Reads and writes; statements that change the schema ask first.
    #[default]
    ReadWrite,
    /// Everything, without asking.
    Full,
}

/// Where a profile's password comes from when it connects.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    /// Send no password.
    #[default]
    #[serde(rename = "none")]
    NoPassword,
    /// The password saved in the OS keychain for this profile. A blank
    /// saved password is sent as blank.
    Keychain,
    /// Run a program and use what it prints, such as
    /// `aws rds generate-db-auth-token`. It runs directly, not through a
    /// shell, so arguments need no quoting.
    Command {
        /// The program to run.
        program: String,
        /// Its arguments.
        #[serde(default)]
        args: Vec<String>,
    },
}

/// Everything about a profile that a person edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFields {
    /// The name shown in the navigator.
    pub name: String,
    /// The project it is grouped under, if any.
    #[serde(default)]
    pub project: Option<String>,
    /// Its marker colour, if any.
    #[serde(default)]
    pub color: Option<Color>,
    /// Which engine to speak.
    pub engine: Engine,
    /// Host name or address, for server engines.
    #[serde(default)]
    pub host: Option<String>,
    /// Port; the engine's default when absent.
    #[serde(default)]
    pub port: Option<u16>,
    /// User name.
    #[serde(default)]
    pub user: Option<String>,
    /// Database to open first.
    #[serde(default)]
    pub database: Option<String>,
    /// File to open, for file engines.
    #[serde(default)]
    pub path: Option<PathBuf>,
    /// TLS mode.
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Root certificate to verify the server against.
    #[serde(default)]
    pub ssl_root_cert: Option<PathBuf>,
    /// Other driver options.
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    /// Where the password comes from.
    #[serde(default)]
    pub auth: Auth,
    /// What the connection may do.
    #[serde(default)]
    pub mode: Mode,
}

impl ProfileFields {
    /// Fields describing `config`, named `name`. A password in `config` is
    /// not kept here: the caller saves it to the keychain and `auth` says so.
    pub fn from_config(name: impl Into<String>, config: &ConnectionConfig) -> ProfileFields {
        ProfileFields {
            name: name.into(),
            project: None,
            color: None,
            engine: config.engine,
            host: config.host.clone(),
            port: config.port,
            user: config.user.clone(),
            database: config.database.clone(),
            path: config.path.clone(),
            ssl_mode: config.ssl_mode,
            ssl_root_cert: config.ssl_root_cert.clone(),
            options: config.options.clone(),
            auth: if config.password.is_some() {
                Auth::Keychain
            } else {
                Auth::NoPassword
            },
            mode: if config.read_only {
                Mode::ReadOnly
            } else {
                Mode::ReadWrite
            },
        }
    }

    /// The connection settings, with `password` filled in by the caller.
    pub fn to_config(&self, password: Option<String>) -> ConnectionConfig {
        let mut config = ConnectionConfig::new(self.engine);
        config.host = self.host.clone();
        config.port = self.port;
        config.user = self.user.clone();
        config.password = password;
        config.database = self.database.clone();
        config.path = self.path.clone();
        config.ssl_mode = self.ssl_mode;
        config.ssl_root_cert = self.ssl_root_cert.clone();
        config.options = self.options.clone();
        config.read_only = self.mode == Mode::ReadOnly;
        config
    }

    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(Error::config("a connection needs a name"));
        }
        if let Auth::Command { program, .. } = &self.auth
            && program.trim().is_empty()
        {
            return Err(Error::config("the password command is empty"));
        }
        Ok(())
    }
}

/// A saved connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Stable id. The keychain entry, buffers and catalog cache refer to it.
    pub id: String,
    /// The editable fields.
    #[serde(flatten)]
    pub fields: ProfileFields,
    /// When it was created, in Unix milliseconds.
    pub created_ms: i64,
    /// When it last changed, in Unix milliseconds.
    pub updated_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct ProfilesFile {
    version: u32,
    profiles: Vec<Profile>,
}

/// The profiles file, loaded.
#[derive(Debug)]
pub struct ProfileBook {
    path: PathBuf,
    profiles: Vec<Profile>,
    /// Set when the file was written by a newer Quicksilver; saving is then
    /// refused so this build cannot drop fields it does not know about.
    newer_version: Option<u32>,
}

impl ProfileBook {
    /// Loads `path`. A missing file is an empty book. An unreadable one is
    /// moved aside, a newer one is read but kept from being rewritten, and
    /// either is reported in the second value.
    pub fn load(path: &Path, now_ms: i64) -> Result<(ProfileBook, Option<Notice>)> {
        let mut book = ProfileBook {
            path: path.to_path_buf(),
            profiles: Vec::new(),
            newer_version: None,
        };
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok((book, None)),
            Err(err) => return Err(io_error("read", path, &err)),
        };
        // Read the version on its own first, so a newer file is recognised
        // even when its profiles no longer parse as this build expects.
        #[derive(Deserialize)]
        struct Version {
            version: u32,
        }
        let reason = match serde_json::from_slice::<Version>(&bytes) {
            Ok(Version { version }) if version > PROFILES_VERSION => {
                book.newer_version = Some(version);
                match serde_json::from_slice::<ProfilesFile>(&bytes) {
                    Ok(file) => book.profiles = file.profiles,
                    Err(err) => tracing::warn!("newer profiles file only partly readable: {err}"),
                }
                return Ok((
                    book,
                    Some(Notice::NewerFormat {
                        file: path.to_path_buf(),
                        version: version.into(),
                    }),
                ));
            }
            Ok(_) => match serde_json::from_slice::<ProfilesFile>(&bytes) {
                Ok(file) => {
                    book.profiles = file.profiles;
                    return Ok((book, None));
                }
                Err(err) => err.to_string(),
            },
            Err(err) => err.to_string(),
        };
        let kept_as = move_aside(path, now_ms)?;
        Ok((
            book,
            Some(Notice::Recovered(Recovered {
                file: path.to_path_buf(),
                kept_as,
                reason,
            })),
        ))
    }

    /// Every profile, in the order they were created.
    pub fn list(&self) -> &[Profile] {
        &self.profiles
    }

    /// The profile with `id`.
    pub fn get(&self, id: &str) -> Result<&Profile> {
        self.profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::config(format!("no saved connection has id {id}")))
    }

    /// Saves a new profile and returns it.
    pub fn create(&mut self, fields: ProfileFields, now_ms: i64) -> Result<Profile> {
        fields.validate()?;
        let profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            fields,
            created_ms: now_ms,
            updated_ms: now_ms,
        };
        let mut next = self.profiles.clone();
        next.push(profile.clone());
        self.commit(next)?;
        Ok(profile)
    }

    /// Replaces the fields of profile `id` and returns it.
    pub fn update(&mut self, id: &str, fields: ProfileFields, now_ms: i64) -> Result<Profile> {
        fields.validate()?;
        let mut next = self.profiles.clone();
        let profile = next
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::config(format!("no saved connection has id {id}")))?;
        profile.fields = fields;
        profile.updated_ms = now_ms;
        let updated = profile.clone();
        self.commit(next)?;
        Ok(updated)
    }

    /// Removes profile `id`. Removing one that does not exist is not an error.
    pub fn delete(&mut self, id: &str) -> Result<()> {
        let next: Vec<Profile> = self
            .profiles
            .iter()
            .filter(|p| p.id != id)
            .cloned()
            .collect();
        if next.len() == self.profiles.len() {
            return Ok(());
        }
        self.commit(next)
    }

    /// Writes `next` and only then makes it the book's contents, so a failed
    /// write leaves memory and disk agreeing.
    fn commit(&mut self, next: Vec<Profile>) -> Result<()> {
        if let Some(version) = self.newer_version {
            return Err(Error::storage(format!(
                "{} was written by a newer Quicksilver (format {version}); update Quicksilver to change connections",
                self.path.display()
            )));
        }
        let file = ProfilesFile {
            version: PROFILES_VERSION,
            profiles: next,
        };
        let mut bytes = serde_json::to_vec_pretty(&file)
            .map_err(|err| Error::internal(format!("could not encode profiles: {err}")))?;
        bytes.push(b'\n');
        write_atomic(&self.path, &bytes)?;
        self.profiles = file.profiles;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(name: &str) -> ProfileFields {
        let config = ConnectionConfig::from_url("postgres://me%40corp@db.example.com/app")
            .unwrap_or_else(|_| ConnectionConfig::new(Engine::Postgres));
        ProfileFields::from_config(name, &config)
    }

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
    }

    #[test]
    fn profiles_survive_a_reload() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("profiles.json");
        let (mut book, recovered) = ProfileBook::load(&path, 1)?;
        assert!(recovered.is_none());
        let a = book.create(fields("prod"), 10)?;
        let mut changed = fields("prod (read only)");
        changed.color = Some(Color::Red);
        changed.project = Some("Payments".into());
        book.update(&a.id, changed.clone(), 20)?;
        book.create(fields("staging"), 30)?;

        let (book, _) = ProfileBook::load(&path, 40)?;
        assert_eq!(book.list().len(), 2);
        let a = book.get(&a.id)?;
        assert_eq!(a.fields, changed);
        assert_eq!((a.created_ms, a.updated_ms), (10, 20));
        assert_eq!(a.fields.user.as_deref(), Some("me@corp"));
        Ok(())
    }

    #[test]
    fn the_file_never_contains_a_password() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("profiles.json");
        let (mut book, _) = ProfileBook::load(&path, 1)?;
        let config = ConnectionConfig::from_url("postgres://u:hunter2@h/d")?;
        let profile = book.create(ProfileFields::from_config("x", &config), 1)?;
        assert_eq!(profile.fields.auth, Auth::Keychain);
        let text = fs::read_to_string(&path).map_err(|e| Error::internal(e.to_string()))?;
        assert!(!text.contains("hunter2"), "{text}");
        Ok(())
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_not_overwritten() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("profiles.json");
        fs::write(&path, b"{\"version\":1,\"profiles\":[{]}")
            .map_err(|e| Error::internal(e.to_string()))?;
        let (mut book, recovered) = ProfileBook::load(&path, 99)?;
        let Some(Notice::Recovered(recovered)) = recovered else {
            return Err(Error::internal(format!(
                "expected recovery, got {recovered:?}"
            )));
        };
        assert_eq!(
            recovered.kept_as,
            dir.path().join("profiles.json.corrupt-99")
        );
        assert!(recovered.kept_as.exists());
        assert!(book.list().is_empty());
        // Saving afterwards writes a fresh file and leaves the kept one alone.
        book.create(fields("new"), 100)?;
        let kept = fs::read(&recovered.kept_as).map_err(|e| Error::internal(e.to_string()))?;
        assert_eq!(kept, b"{\"version\":1,\"profiles\":[{]}");
        Ok(())
    }

    #[test]
    fn a_newer_file_is_read_but_never_rewritten() -> Result<()> {
        let dir = temp();
        let path = dir.path().join("profiles.json");
        let original = br#"{"version":7,"profiles":[],"somethingNew":true}"#;
        fs::write(&path, original).map_err(|e| Error::internal(e.to_string()))?;
        let (mut book, notice) = ProfileBook::load(&path, 1)?;
        assert!(
            matches!(notice, Some(Notice::NewerFormat { version: 7, .. })),
            "{notice:?}"
        );
        let err = book.create(fields("x"), 2);
        assert!(matches!(err, Err(Error::Storage { .. })), "{err:?}");
        assert_eq!(fs::read(&path).ok().as_deref(), Some(&original[..]));
        Ok(())
    }

    #[test]
    fn names_and_commands_are_validated() -> Result<()> {
        let dir = temp();
        let (mut book, _) = ProfileBook::load(&dir.path().join("p.json"), 1)?;
        assert!(book.create(fields("  "), 1).is_err());
        let mut command = fields("iam");
        command.auth = Auth::Command {
            program: " ".into(),
            args: vec![],
        };
        assert!(book.create(command, 1).is_err());
        assert!(book.get("missing").is_err());
        book.delete("missing")?;
        Ok(())
    }

    #[test]
    fn to_config_round_trips_the_fields() -> Result<()> {
        let config = ConnectionConfig::from_url(
            "postgres://u@h:6543/d?sslmode=verify-full&application_name=qs",
        )?;
        let fields = ProfileFields::from_config("x", &config);
        let back = fields.to_config(Some(String::new()));
        assert_eq!(back.password.as_deref(), Some(""));
        assert_eq!(back.port, Some(6543));
        assert_eq!(back.ssl_mode, SslMode::VerifyFull);
        assert_eq!(
            back.options.get("application_name").map(String::as_str),
            Some("qs")
        );
        let mut read_only = fields.clone();
        read_only.mode = Mode::ReadOnly;
        assert!(read_only.to_config(None).read_only);
        assert!(!fields.to_config(None).read_only);
        Ok(())
    }
}
