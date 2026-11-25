//! Domain types shared by every Quicksilver crate.
//!
//! Nothing here does I/O or knows about a driver. The UI and the service talk
//! in these types, so they are the boundary that keeps driver types inside
//! `qs-drivers`.

pub mod config;
pub mod engine;
pub mod error;
pub mod serde_millis;
pub mod value;

pub use config::{ConnectionConfig, SslMode};
pub use engine::Engine;
pub use error::{Error, Result};
pub use value::{Column, ColumnSource, TypeTag};
