//! Domain types shared by every Quicksilver crate.
//!
//! Nothing here does I/O or knows about a driver. The UI and the service talk
//! in these types, so they are the boundary that keeps driver types inside
//! `qs-drivers`.

pub mod engine;

pub use engine::Engine;
