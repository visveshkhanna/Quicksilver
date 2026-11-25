//! Passwords printed by a program, such as a cloud IAM token from
//! `aws rds generate-db-auth-token` or a secret from a password manager CLI.
//!
//! The program runs directly, never through a shell, so its arguments are
//! passed exactly as saved and nothing in them is interpreted.

use std::ffi::OsString;
use std::io::ErrorKind;
use std::process::Stdio;
use std::time::Duration;

use qs_core::{Error, Result};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// How long a password command may run before it is stopped.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The most output read from the program; a token is far smaller.
const MAX_OUTPUT: u64 = 64 * 1024;

/// Runs `program` with `args` and returns what it printed, without the
/// final line break. Fails when it cannot start, exits unsuccessfully,
/// prints nothing, or runs longer than `timeout` (it is then killed).
pub async fn run(program: &str, args: &[String], timeout: Duration) -> Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = search_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        // Do not flash a console window over the app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|err| match err.kind() {
        ErrorKind::NotFound => Error::config(format!(
            "the password command `{program}` was not found; give its full path if it is not on PATH"
        )),
        _ => Error::config(format!("could not run the password command `{program}`: {err}")),
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::internal("no stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::internal("no stderr pipe"))?;
    let mut stdout = stdout.take(MAX_OUTPUT);
    let mut stderr = stderr.take(MAX_OUTPUT);

    let work = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (read_out, read_err, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait(),
        );
        read_out
            .and(read_err)
            .and(status)
            .map(|status| (status, out, err))
    };
    let (status, out, err) = match tokio::time::timeout(timeout, work).await {
        Ok(Ok(done)) => done,
        Ok(Err(err)) => {
            return Err(Error::connect(format!(
                "the password command `{program}` failed: {err}"
            )));
        }
        // Dropping the child kills it (`kill_on_drop`).
        Err(_) => {
            return Err(Error::connect(format!(
                "the password command `{program}` did not finish within {} s",
                timeout.as_secs()
            )));
        }
    };

    if !status.success() {
        let stderr = String::from_utf8_lossy(&err);
        let stderr = stderr.trim();
        let mut message = format!("the password command `{program}` failed ({status})");
        if !stderr.is_empty() {
            message.push_str(": ");
            message.extend(stderr.chars().take(500));
        }
        return Err(Error::connect(message));
    }
    let text = String::from_utf8(out).map_err(|_| {
        Error::connect(format!(
            "the password command `{program}` printed something that is not text"
        ))
    })?;
    let password = strip_line_break(&text);
    if password.is_empty() {
        return Err(Error::connect(format!(
            "the password command `{program}` printed nothing"
        )));
    }
    Ok(password.to_owned())
}

/// Removes one trailing `\n` or `\r\n`, and nothing else: spaces can be part
/// of a password.
fn strip_line_break(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

/// `PATH` with the usual install directories added. An app started from the
/// Dock or a desktop launcher does not get the PATH a terminal has, so tools
/// installed with Homebrew or pip would not be found.
fn search_path() -> Option<OsString> {
    if cfg!(windows) {
        return None;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<_> = std::env::split_paths(&current).collect();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        .into_iter()
        .map(std::path::PathBuf::from)
        .chain(home.map(|home| home.join(".local/bin")));
    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[tokio::test]
    async fn the_output_is_the_password_without_its_line_break() -> Result<()> {
        let token = run("sh", &sh("printf ' tok en \\n'"), DEFAULT_TIMEOUT).await?;
        assert_eq!(token, " tok en ");
        let crlf = run("sh", &sh("printf 'abc\\r\\n'"), DEFAULT_TIMEOUT).await?;
        assert_eq!(crlf, "abc");
        Ok(())
    }

    #[tokio::test]
    async fn arguments_are_not_interpreted_by_a_shell() -> Result<()> {
        let out = run(
            "printf",
            &["%s".into(), "$HOME; rm -rf /".into()],
            DEFAULT_TIMEOUT,
        )
        .await?;
        assert_eq!(out, "$HOME; rm -rf /");
        Ok(())
    }

    #[tokio::test]
    async fn failures_carry_the_programs_own_message() {
        let err = run(
            "sh",
            &sh("echo 'token expired' >&2; exit 3"),
            DEFAULT_TIMEOUT,
        )
        .await;
        let Err(Error::Connect { message }) = err else {
            panic!("expected a connect error, got {err:?}");
        };
        assert!(message.contains("token expired"), "{message}");
        assert!(message.contains('3'), "{message}");
    }

    #[tokio::test]
    async fn empty_output_missing_programs_and_slow_programs_are_errors() {
        assert!(run("sh", &sh("true"), DEFAULT_TIMEOUT).await.is_err());
        let missing = run("qs-no-such-program", &[], DEFAULT_TIMEOUT).await;
        assert!(matches!(missing, Err(Error::Config { .. })), "{missing:?}");

        let started = std::time::Instant::now();
        let slow = run("sh", &sh("sleep 10; echo late"), Duration::from_millis(200)).await;
        assert!(matches!(slow, Err(Error::Connect { .. })), "{slow:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
