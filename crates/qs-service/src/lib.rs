//! The one API the desktop shell exposes to the UI.
//!
//! The Tauri commands in `apps/desktop/src-tauri` are thin wrappers over the
//! functions here, so everything the app can do is testable without a window.
//! Sessions, the result store and cancellation arrive in phase 2.

use qs_core::Engine;
use serde::Serialize;

/// What the app reports about itself.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// The product name.
    pub name: &'static str,
    /// The version, shared by every crate and package in the repository.
    pub version: &'static str,
    /// The engines this build knows about.
    pub engines: Vec<EngineInfo>,
}

/// One engine, as the UI lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// The stable identifier, as it is stored in profiles.
    pub id: Engine,
    /// The name shown to people.
    pub name: &'static str,
    /// The default port, if the engine has one.
    pub default_port: Option<u16>,
}

/// The app's name, version and known engines.
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Quicksilver",
        version: env!("CARGO_PKG_VERSION"),
        engines: Engine::ALL
            .iter()
            .map(|&id| EngineInfo {
                id,
                name: id.display_name(),
                default_port: id.default_port(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_lists_every_engine_with_the_workspace_version() {
        let info = app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.engines.len(), Engine::ALL.len());
    }
}
