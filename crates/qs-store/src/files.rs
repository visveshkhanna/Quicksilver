//! Writing files so that a crash or a full disk never leaves half of one.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use qs_core::{Error, Result};

/// Replaces `path` with `bytes` in one step: the bytes go to a temporary file
/// beside it, are flushed to disk, and the temporary file is renamed over the
/// old one. Readers see the old file or the new one, never a mix.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::storage(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir).map_err(|err| io_error("create", dir, &err))?;
    let tmp = sibling(path, "tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|err| io_error("create", &tmp, &err))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|err| io_error("write", &tmp, &err))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|err| io_error("replace", path, &err))?;
    // Make the rename itself durable where the OS allows syncing a directory.
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Renames `path` to `<name>.corrupt-<millis>` so a file Quicksilver could
/// not read is kept for the user (or a bug report) instead of overwritten.
/// Returns the new path.
pub fn move_aside(path: &Path, now_ms: i64) -> Result<PathBuf> {
    let target = sibling(path, &format!("corrupt-{now_ms}"));
    fs::rename(path, &target).map_err(|err| io_error("move aside", path, &err))?;
    tracing::warn!(
        "{} could not be read; kept it as {}",
        path.display(),
        target.display()
    );
    Ok(target)
}

/// `path` with `.suffix` appended to its file name.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

pub(crate) fn io_error(action: &str, path: &Path, err: &std::io::Error) -> Error {
    Error::storage(format!("could not {action} {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_create_directories_and_replace_the_old_file() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::internal(e.to_string()))?;
        let path = dir.path().join("a/b/file.json");
        write_atomic(&path, b"one")?;
        write_atomic(&path, b"two")?;
        assert_eq!(fs::read(&path).ok(), Some(b"two".to_vec()));
        assert!(!sibling(&path, "tmp").exists());
        Ok(())
    }

    #[test]
    fn moving_aside_keeps_the_bytes() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::internal(e.to_string()))?;
        let path = dir.path().join("profiles.json");
        fs::write(&path, b"{ not json").map_err(|e| Error::internal(e.to_string()))?;
        let kept = move_aside(&path, 42)?;
        assert!(!path.exists());
        assert_eq!(
            kept.file_name().and_then(|n| n.to_str()),
            Some("profiles.json.corrupt-42")
        );
        assert_eq!(fs::read(&kept).ok(), Some(b"{ not json".to_vec()));
        Ok(())
    }
}
