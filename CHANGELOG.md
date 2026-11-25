# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.1] - 2026-11-25

### Added

- Project skeleton: Rust workspace (`qs-core`, `qs-sql`, `qs-net`,
  `qs-drivers`, `qs-store`, `qs-io`, `qs-service`) and the Tauri 2 desktop app.
- An empty three-panel window (navigator, workspace, inspector) whose panel
  sizes persist, following the OS light or dark setting.
- Development databases for every engine in `dev/compose.yaml`, with seed data.
- CI on macOS, Windows and Linux, and a tag-driven release workflow.
