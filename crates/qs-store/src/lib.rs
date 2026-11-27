//! What Quicksilver keeps between runs.
//!
//! - Connection profiles, in `profiles.json` ([`profiles`]).
//! - Passwords, only in the OS keychain ([`secrets`]). Each one is read
//!   from it at most once a run and then held in memory, so opening more
//!   sessions does not ask the OS again.
//! - History, saved queries, editor buffers, layout and the catalog cache
//!   for the `Mod+K` switcher, in `state.db` ([`state`]).
//!
//! Development builds use their own directory and keychain service
//! ([`Channel`]). A file that cannot be read is moved aside and kept, never
//! overwritten, and the store reports it as a [`Notice`].

pub mod dirs;
pub mod files;
pub mod profiles;
pub mod secrets;
pub mod state;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use qs_core::Result;
use serde::{Deserialize, Serialize};

pub use dirs::{Channel, DataDir};
pub use profiles::{Auth, Color, Mode, Profile, ProfileBook, ProfileFields};
pub use secrets::{Keychain, MemorySecrets, Secrets};
pub use state::{
    Buffer, CatalogEntry, CatalogObject, HistoryEntry, HistoryQuery, NewHistoryEntry, SavedQuery,
    State,
};

/// Something the user should hear about from opening the store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Notice {
    /// A file could not be read and was moved aside.
    Recovered(Recovered),
    /// A file was written by a newer Quicksilver. It is left untouched;
    /// changes this run are refused (profiles) or kept in memory (state).
    #[serde(rename_all = "camelCase")]
    NewerFormat {
        /// The file.
        file: PathBuf,
        /// Its format version.
        version: i64,
    },
}

/// A file that could not be read, and where it was kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    /// The file that could not be read.
    pub file: PathBuf,
    /// Where it was kept.
    pub kept_as: PathBuf,
    /// Why it could not be read.
    pub reason: String,
}

/// What to do with a profile's saved password when the profile is saved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PasswordChange {
    /// Leave it as it is.
    #[default]
    Keep,
    /// Save this one. Blank is a valid password.
    Set {
        /// The password.
        password: String,
    },
    /// Forget it.
    Clear,
}

/// The open store.
pub struct Store {
    dir: DataDir,
    profiles: Mutex<ProfileBook>,
    state: Mutex<State>,
    secrets: Box<dyn Secrets>,
    /// Passwords known this run, by profile id: read from the keychain once,
    /// or typed and accepted by the server. Never written anywhere.
    known: Mutex<HashMap<String, String>>,
    notices: Vec<Notice>,
}

impl Store {
    /// Opens the store in `dir`, keeping passwords in `secrets`.
    pub fn open(dir: DataDir, secrets: Box<dyn Secrets>) -> Result<Store> {
        let now = now_ms();
        let (profiles, profile_notice) = ProfileBook::load(&dir.profiles(), now)?;
        let (state, state_notice) = State::open(&dir.state(), now)?;
        Ok(Store {
            dir,
            profiles: Mutex::new(profiles),
            state: Mutex::new(state),
            secrets,
            known: Mutex::new(HashMap::new()),
            notices: profile_notice.into_iter().chain(state_notice).collect(),
        })
    }

    /// The directory the store lives in.
    pub fn dir(&self) -> &DataDir {
        &self.dir
    }

    /// What happened while opening, for the UI to show once.
    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }

    /// Every profile.
    pub fn profiles(&self) -> Vec<Profile> {
        self.book().list().to_vec()
    }

    /// The profile with `id`.
    pub fn profile(&self, id: &str) -> Result<Profile> {
        self.book().get(id).cloned()
    }

    /// Saves a new profile, and its password when `password` says to.
    pub fn create_profile(
        &self,
        fields: ProfileFields,
        password: PasswordChange,
    ) -> Result<Profile> {
        let profile = self.book().create(fields, now_ms())?;
        if let Err(err) = self.apply_password(&profile, None, &password) {
            // Do not leave a profile that cannot connect the way it says.
            let _ = self.book().delete(&profile.id);
            return Err(err);
        }
        Ok(profile)
    }

    /// Changes profile `id`, and its password when `password` says to.
    pub fn update_profile(
        &self,
        id: &str,
        fields: ProfileFields,
        password: PasswordChange,
    ) -> Result<Profile> {
        let mut book = self.book();
        let current = book.get(id)?.clone();
        let next = Profile {
            fields: fields.clone(),
            ..current
        };
        // The keychain first: if it fails, the profile is unchanged.
        self.apply_password(&next, Some(&current.fields.auth), &password)?;
        book.update(id, fields, now_ms())
    }

    /// Deletes profile `id`, its keychain entry and what the state database
    /// holds for it.
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.secrets.delete(id)?;
        self.known().remove(id);
        self.book().delete(id)?;
        self.state().forget_profile(id)
    }

    /// The password to connect profile `id` with: one already known this
    /// run, else the one saved in the keychain, if any. The keychain is
    /// asked only the first time, since each read may make the OS ask the
    /// user to allow it.
    pub fn saved_password(&self, id: &str) -> Result<Option<String>> {
        if let Some(password) = self.known().get(id) {
            return Ok(Some(password.clone()));
        }
        let saved = self.secrets.get(id)?;
        if let Some(password) = &saved {
            self.known().insert(id.to_owned(), password.clone());
        }
        Ok(saved)
    }

    /// Holds `password` for profile `id` until the app quits, without saving
    /// it: one the user typed and the server accepted, so the next session
    /// on the profile does not ask again.
    pub fn remember_for_run(&self, id: &str, password: &str) {
        self.known().insert(id.to_owned(), password.to_owned());
    }

    /// The state database. Hold the guard only for the call at hand.
    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn book(&self) -> MutexGuard<'_, ProfileBook> {
        self.profiles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn known(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Applies `change` to `profile`'s saved password. `before` is how the
    /// profile got its password until now (`None` for a new profile).
    fn apply_password(
        &self,
        profile: &Profile,
        before: Option<&Auth>,
        change: &PasswordChange,
    ) -> Result<()> {
        let id = &profile.id;
        if profile.fields.auth != Auth::Keychain {
            self.known().remove(id);
            // A profile that does not use the keychain keeps nothing there.
            // Only one that used it can have an entry to forget, and not
            // touching the keychain otherwise spares an OS prompt on a
            // rename or a move to another folder.
            return match before {
                Some(Auth::Keychain) => self.secrets.delete(id),
                _ => Ok(()),
            };
        }
        match change {
            PasswordChange::Keep => Ok(()),
            PasswordChange::Set { password } => {
                self.secrets.set(id, password)?;
                self.known().insert(id.clone(), password.clone());
                Ok(())
            }
            PasswordChange::Clear => {
                self.known().remove(id);
                self.secrets.delete(id)
            }
        }
    }
}

/// The current time in Unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use qs_core::{ConnectionConfig, Engine, Error};

    use super::*;

    /// Shares one in-memory secret store between the test and the store.
    struct Shared(Arc<MemorySecrets>);

    impl Secrets for Shared {
        fn get(&self, account: &str) -> Result<Option<String>> {
            self.0.get(account)
        }
        fn set(&self, account: &str, password: &str) -> Result<()> {
            self.0.set(account, password)
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.delete(account)
        }
    }

    struct Failing;

    impl Secrets for Failing {
        fn get(&self, _: &str) -> Result<Option<String>> {
            Err(Error::storage("locked"))
        }
        fn set(&self, _: &str, _: &str) -> Result<()> {
            Err(Error::storage("locked"))
        }
        fn delete(&self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    fn open(secrets: Box<dyn Secrets>) -> Result<(tempfile::TempDir, Store)> {
        let dir = tempfile::tempdir().map_err(|e| Error::internal(e.to_string()))?;
        let store = Store::open(DataDir::at(dir.path()), secrets)?;
        Ok((dir, store))
    }

    fn keychain_fields() -> ProfileFields {
        let mut fields = ProfileFields::from_config("db", &ConnectionConfig::new(Engine::Postgres));
        fields.auth = Auth::Keychain;
        fields
    }

    #[test]
    fn passwords_go_to_the_keychain_and_follow_the_profile() -> Result<()> {
        let secrets = Arc::new(MemorySecrets::new());
        let (_dir, store) = open(Box::new(Shared(secrets.clone())))?;
        let profile = store.create_profile(
            keychain_fields(),
            PasswordChange::Set {
                password: String::new(),
            },
        )?;
        // A blank password is saved as blank, not as "no password".
        assert_eq!(store.saved_password(&profile.id)?, Some(String::new()));

        store.update_profile(&profile.id, keychain_fields(), PasswordChange::Keep)?;
        assert_eq!(secrets.get(&profile.id)?, Some(String::new()));

        // Switching to a password command forgets the saved password.
        let mut command = keychain_fields();
        command.auth = Auth::Command {
            program: "aws".into(),
            args: vec!["rds".into(), "generate-db-auth-token".into()],
        };
        store.update_profile(&profile.id, command, PasswordChange::Keep)?;
        assert_eq!(secrets.get(&profile.id)?, None);

        store.update_profile(
            &profile.id,
            keychain_fields(),
            PasswordChange::Set {
                password: "p@ss".into(),
            },
        )?;
        store.delete_profile(&profile.id)?;
        assert_eq!(secrets.get(&profile.id)?, None);
        assert!(store.profiles().is_empty());
        Ok(())
    }

    /// Counts how often the keychain is touched.
    #[derive(Default)]
    struct Counting {
        inner: MemorySecrets,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl Counting {
        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn touch(&self) {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct CountingRef(Arc<Counting>);

    impl Secrets for CountingRef {
        fn get(&self, account: &str) -> Result<Option<String>> {
            self.0.touch();
            self.0.inner.get(account)
        }
        fn set(&self, account: &str, password: &str) -> Result<()> {
            self.0.touch();
            self.0.inner.set(account, password)
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.touch();
            self.0.inner.delete(account)
        }
    }

    #[test]
    fn the_keychain_is_read_once_a_run() -> Result<()> {
        let secrets = Arc::new(Counting::default());
        secrets.inner.set("saved-earlier", "s3cret")?;
        let (_dir, store) = open(Box::new(CountingRef(secrets.clone())))?;
        for _ in 0..3 {
            assert_eq!(
                store.saved_password("saved-earlier")?.as_deref(),
                Some("s3cret")
            );
        }
        assert_eq!(secrets.calls(), 1);

        // A password typed and accepted is used for later sessions, unsaved.
        store.remember_for_run("typed", "hunter2");
        assert_eq!(store.saved_password("typed")?.as_deref(), Some("hunter2"));
        assert_eq!(secrets.inner.get("typed")?, None);
        assert_eq!(secrets.calls(), 1);
        Ok(())
    }

    #[test]
    fn saving_a_profile_without_a_password_leaves_the_keychain_alone() -> Result<()> {
        let secrets = Arc::new(Counting::default());
        let (_dir, store) = open(Box::new(CountingRef(secrets.clone())))?;
        let mut plain = keychain_fields();
        plain.auth = Auth::NoPassword;
        let profile = store.create_profile(plain.clone(), PasswordChange::Keep)?;
        plain.project = Some("work/billing".into());
        store.update_profile(&profile.id, plain, PasswordChange::Keep)?;
        assert_eq!(secrets.calls(), 0);

        // A changed password replaces the one held for the run.
        store.update_profile(
            &profile.id,
            keychain_fields(),
            PasswordChange::Set {
                password: "new".into(),
            },
        )?;
        store.remember_for_run(&profile.id, "old");
        store.update_profile(
            &profile.id,
            keychain_fields(),
            PasswordChange::Set {
                password: "newer".into(),
            },
        )?;
        assert_eq!(store.saved_password(&profile.id)?.as_deref(), Some("newer"));
        Ok(())
    }

    #[test]
    fn a_keychain_failure_leaves_no_half_saved_profile() -> Result<()> {
        let (_dir, store) = open(Box::new(Failing))?;
        let err = store.create_profile(
            keychain_fields(),
            PasswordChange::Set {
                password: "x".into(),
            },
        );
        assert!(matches!(err, Err(Error::Storage { .. })), "{err:?}");
        assert!(store.profiles().is_empty());

        let mut plain = keychain_fields();
        plain.auth = Auth::NoPassword;
        let profile = store.create_profile(plain, PasswordChange::Keep)?;
        let mut renamed = keychain_fields();
        renamed.name = "renamed".into();
        assert!(
            store
                .update_profile(
                    &profile.id,
                    renamed,
                    PasswordChange::Set {
                        password: "x".into()
                    }
                )
                .is_err()
        );
        assert_eq!(store.profile(&profile.id)?.fields.name, "db");
        Ok(())
    }

    #[test]
    fn deleting_a_profile_forgets_its_state() -> Result<()> {
        let (_dir, store) = open(Box::new(MemorySecrets::new()))?;
        let profile = store.create_profile(keychain_fields(), PasswordChange::Keep)?;
        store
            .state()
            .replace_databases(&profile.id, &["app".into()], 1)?;
        store
            .state()
            .save_query(None, "q", Some(&profile.id), "select 1", 1)?;
        store.delete_profile(&profile.id)?;
        assert!(store.state().catalog(None)?.is_empty());
        assert!(store.state().saved_queries(None)?.is_empty());
        Ok(())
    }

    /// `apps/desktop/src/ipc/store.ts` mirrors these shapes by hand.
    #[test]
    fn json_shapes_match_the_ui_types() -> Result<()> {
        let mut fields = keychain_fields();
        fields.color = Some(Color::Purple);
        fields.auth = Auth::Command {
            program: "aws".into(),
            args: vec!["x".into()],
        };
        let profile = Profile {
            id: "id".into(),
            fields,
            created_ms: 1,
            updated_ms: 2,
        };
        let json = serde_json::to_value(&profile).map_err(|e| Error::internal(e.to_string()))?;
        let mut keys: Vec<_> = json
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        assert_eq!(
            keys,
            [
                "auth",
                "color",
                "createdMs",
                "database",
                "engine",
                "host",
                "id",
                "mode",
                "name",
                "options",
                "path",
                "port",
                "project",
                "sslMode",
                "sslRootCert",
                "updatedMs",
                "user"
            ]
        );
        assert_eq!(
            json["auth"],
            serde_json::json!({"kind": "command", "program": "aws", "args": ["x"]})
        );
        assert_eq!(json["color"], "purple");
        assert_eq!(json["sslMode"], "prefer");
        assert_eq!(json["mode"], "readWrite");
        assert_eq!(
            serde_json::to_value(Auth::NoPassword).ok(),
            Some(serde_json::json!({"kind": "none"}))
        );
        let change: PasswordChange =
            serde_json::from_value(serde_json::json!({"kind": "set", "password": ""}))
                .map_err(|e| Error::internal(e.to_string()))?;
        assert_eq!(
            change,
            PasswordChange::Set {
                password: String::new()
            }
        );
        let notice = Notice::Recovered(Recovered {
            file: "a".into(),
            kept_as: "b".into(),
            reason: "c".into(),
        });
        assert_eq!(
            serde_json::to_value(notice).ok(),
            Some(
                serde_json::json!({"kind": "recovered", "file": "a", "keptAs": "b", "reason": "c"})
            )
        );
        let newer = Notice::NewerFormat {
            file: "a".into(),
            version: 2,
        };
        assert_eq!(
            serde_json::to_value(newer).ok(),
            Some(serde_json::json!({"kind": "newerFormat", "file": "a", "version": 2}))
        );
        Ok(())
    }

    #[test]
    fn notices_report_a_corrupt_profiles_file() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::internal(e.to_string()))?;
        std::fs::write(dir.path().join("profiles.json"), "nope")
            .map_err(|e| Error::internal(e.to_string()))?;
        let store = Store::open(DataDir::at(dir.path()), Box::new(MemorySecrets::new()))?;
        assert!(
            matches!(store.notices(), [Notice::Recovered(_)]),
            "{:?}",
            store.notices()
        );
        Ok(())
    }
}
