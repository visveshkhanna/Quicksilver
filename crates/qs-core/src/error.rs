//! The errors every layer reports, in a form the UI can show.

use serde::Serialize;

/// Shorthand for results carrying [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Something that went wrong, described for a person.
///
/// Messages are the server's or the library's own words. Quicksilver adds
/// context but never replaces them, because the original text is what people
/// search for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Error {
    /// The connection settings are incomplete or contradict each other.
    #[error("{message}")]
    Config {
        /// What is wrong.
        message: String,
    },
    /// The server could not be reached or refused the login.
    #[error("{message}")]
    Connect {
        /// The driver's description.
        message: String,
    },
    /// TLS could not be set up the way the connection asked for.
    #[error("{message}")]
    Tls {
        /// Which check failed, or which mode was refused.
        message: String,
    },
    /// The server rejected a statement.
    #[error("{message}")]
    Query {
        /// The server's message.
        message: String,
        /// The server's error code (SQLSTATE on SQL engines), when given.
        code: Option<String>,
        /// The 1-based character position in the statement the server
        /// pointed at, when given.
        position: Option<u32>,
        /// Extra detail or a hint from the server.
        detail: Option<String>,
    },
    /// The user cancelled the operation.
    #[error("cancelled")]
    Cancelled,
    /// The connection was closed and must be reopened.
    #[error("the connection is closed")]
    Closed,
    /// Something this build does not support.
    #[error("{message}")]
    Unsupported {
        /// What is not supported.
        message: String,
    },
    /// Anything else, with the underlying message.
    #[error("{message}")]
    Internal {
        /// The underlying message.
        message: String,
    },
}

impl Error {
    /// A [`Error::Config`] with this message.
    pub fn config(message: impl Into<String>) -> Self {
        Error::Config {
            message: message.into(),
        }
    }

    /// A [`Error::Connect`] with this message.
    pub fn connect(message: impl Into<String>) -> Self {
        Error::Connect {
            message: message.into(),
        }
    }

    /// A [`Error::Tls`] with this message.
    pub fn tls(message: impl Into<String>) -> Self {
        Error::Tls {
            message: message.into(),
        }
    }

    /// A [`Error::Query`] with only a message.
    pub fn query(message: impl Into<String>) -> Self {
        Error::Query {
            message: message.into(),
            code: None,
            position: None,
            detail: None,
        }
    }

    /// A [`Error::Unsupported`] with this message.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Error::Unsupported {
            message: message.into(),
        }
    }

    /// A [`Error::Internal`] with this message.
    pub fn internal(message: impl Into<String>) -> Self {
        Error::Internal {
            message: message.into(),
        }
    }
}
