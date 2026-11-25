//! Where Quicksilver keeps its files.

use std::path::{Path, PathBuf};

/// Which build is running. Development builds keep their data apart from
/// the installed app, so trying something out never touches real profiles
/// or keychain entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// A `tauri dev` or debug build.
    Dev,
    /// An installed release build.
    Release,
}

impl Channel {
    /// The channel of the build being compiled.
    pub fn current() -> Channel {
        if cfg!(debug_assertions) {
            Channel::Dev
        } else {
            Channel::Release
        }
    }

    /// The keychain service name entries are filed under.
    pub fn keychain_service(self) -> &'static str {
        match self {
            Channel::Dev => "Quicksilver (dev)",
            Channel::Release => "Quicksilver",
        }
    }
}

/// The directory that holds every file Quicksilver writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    /// A data directory at exactly `root`.
    pub fn at(root: impl Into<PathBuf>) -> DataDir {
        DataDir { root: root.into() }
    }

    /// The data directory for `channel` inside the OS's per-app directory
    /// `app_dir` (which the shell asks Tauri for). Dev builds use a `dev`
    /// subdirectory.
    pub fn for_channel(app_dir: &Path, channel: Channel) -> DataDir {
        match channel {
            Channel::Dev => DataDir::at(app_dir.join("dev")),
            Channel::Release => DataDir::at(app_dir),
        }
    }

    /// The directory itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The connection profiles file.
    pub fn profiles(&self) -> PathBuf {
        self.root.join("profiles.json")
    }

    /// The database holding history, saved queries, buffers, layout and the
    /// catalog cache.
    pub fn state(&self) -> PathBuf {
        self.root.join("state.db")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_and_release_never_share_a_directory_or_keychain_service() {
        let app = Path::new("/apps/quicksilver");
        let dev = DataDir::for_channel(app, Channel::Dev);
        let release = DataDir::for_channel(app, Channel::Release);
        assert_ne!(dev.profiles(), release.profiles());
        assert_ne!(dev.state(), release.state());
        assert_ne!(
            Channel::Dev.keychain_service(),
            Channel::Release.keychain_service()
        );
    }
}
