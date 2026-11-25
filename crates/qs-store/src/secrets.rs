//! Passwords, kept only in the OS keychain: Keychain Services on macOS,
//! Credential Manager on Windows, the Secret Service on Linux.

use std::collections::HashMap;
use std::sync::Mutex;

use qs_core::{Error, Result};

/// Somewhere passwords can be kept, one per profile id.
pub trait Secrets: Send + Sync {
    /// The saved password for `account`, or `None` when there is none.
    fn get(&self, account: &str) -> Result<Option<String>>;
    /// Saves `password` for `account`, replacing any saved one.
    fn set(&self, account: &str, password: &str) -> Result<()>;
    /// Forgets the password for `account`. Forgetting one that was never
    /// saved is not an error.
    fn delete(&self, account: &str) -> Result<()>;
}

/// The OS keychain, with entries filed under one service name.
pub struct Keychain {
    service: String,
}

impl Keychain {
    /// Entries filed under `service` (see
    /// [`Channel::keychain_service`](crate::Channel::keychain_service)).
    pub fn new(service: impl Into<String>) -> Keychain {
        Keychain {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(keychain_error)
    }
}

impl Secrets for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>> {
        match self.entry(account)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(keychain_error(err)),
        }
    }

    fn set(&self, account: &str, password: &str) -> Result<()> {
        self.entry(account)?
            .set_password(password)
            .map_err(keychain_error)
    }

    fn delete(&self, account: &str) -> Result<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(keychain_error(err)),
        }
    }
}

fn keychain_error(err: keyring::Error) -> Error {
    Error::storage(format!("the OS keychain failed: {err}"))
}

/// Passwords held in memory, for tests and for keychain-less runs.
#[derive(Default)]
pub struct MemorySecrets {
    entries: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    /// An empty store.
    pub fn new() -> MemorySecrets {
        MemorySecrets::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Secrets for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<String>> {
        Ok(self.lock().get(account).cloned())
    }

    fn set(&self, account: &str, password: &str) -> Result<()> {
        self.lock().insert(account.to_owned(), password.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<()> {
        self.lock().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(secrets: &dyn Secrets, account: &str) -> Result<()> {
        secrets.delete(account)?;
        assert_eq!(secrets.get(account)?, None);
        secrets.set(account, "")?;
        assert_eq!(secrets.get(account)?, Some(String::new()));
        secrets.set(account, "p@ss wörd")?;
        assert_eq!(secrets.get(account)?.as_deref(), Some("p@ss wörd"));
        secrets.delete(account)?;
        secrets.delete(account)?;
        assert_eq!(secrets.get(account)?, None);
        Ok(())
    }

    #[test]
    fn memory_secrets_behave_like_a_keychain() -> Result<()> {
        round_trip(&MemorySecrets::new(), "profile")
    }

    /// Touches the real OS keychain, so it runs only when asked:
    /// `cargo test -p qs-store -- --ignored`.
    #[test]
    #[ignore = "uses the OS keychain"]
    fn the_os_keychain_round_trips() -> Result<()> {
        round_trip(&Keychain::new("Quicksilver (test)"), "qs-store-test")
    }
}
