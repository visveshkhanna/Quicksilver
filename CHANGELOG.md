# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- PostgreSQL and SQLite drivers: streamed results with a row cap that never
  rewrites the statement, cancellation, multiple statements per script, and
  catalog reads (databases, schemas, objects, columns with primary keys).
- Values rendered as the server prints them (exact numerics, `-Infinity`,
  `\x` hex for bytes) with a type tag and source column per result column.
- TLS with libpq's `sslmode` meanings; `allow` is refused by name.
- Connection URLs with percent-encoded `@` in user names and blank passwords.
- A statement splitter for Postgres, MySQL and SQLite lexical rules.
- A columnar result store with binary page fetches, and Tauri commands to
  connect, run, cancel, page through results and read the catalog.
- A conformance suite every driver must pass, and a 1M-row benchmark
  (`cargo run --release -p qs-service --example bench`).

## [0.0.1] - 2026-11-25

### Added

- Project skeleton: Rust workspace (`qs-core`, `qs-sql`, `qs-net`,
  `qs-drivers`, `qs-store`, `qs-io`, `qs-service`) and the Tauri 2 desktop app.
- An empty three-panel window (navigator, workspace, inspector) whose panel
  sizes persist, following the OS light or dark setting.
- Development databases for every engine in `dev/compose.yaml`, with seed data.
- CI on macOS, Windows and Linux, and a tag-driven release workflow.
