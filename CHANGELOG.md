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
- Saved connections with projects and marker colours, in `profiles.json`. A
  file that cannot be read is moved aside and kept; one written by a newer
  version is never rewritten.
- Passwords in the OS keychain (Keychain Services, Credential Manager, Secret
  Service), or from a password command such as
  `aws rds generate-db-auth-token`, run without a shell.
- History, saved queries, editor tab buffers, layout state and a catalog
  cache for the `Mod+K` switcher, in `state.db`.
- Development builds keep their data and keychain entries apart from the
  installed app.
- The app shell:
  - A navigator with every connection, grouped by project. It expands
    lazily to databases, schemas, tables, views, functions, sequences and
    columns, and has a filter and context menus.
  - A connection form with Paste URL, Test, a password from the keychain or
    a command, TLS mode, colour, project and mode.
- Read-only connections are enforced by the database connection itself:
  SQLite opens the file read-only, and Postgres starts every transaction
  read-only.
- `Mod+K` switches the tab's database by fuzzy search, most recent first
  (`Mod+Enter` opens a new tab instead). `Mod+P` goes to a table or view.
  `Mod+Shift+P` lists every command that can run now, with its shortcut.
- Tabs are bound to a connection and database, and are restored on launch.
  Closed tabs can be reopened, and `Mod+1` to `Mod+9` jump to a tab.
- Every shortcut can be rebound, with conflicts refused.
- TypeScript types for the UI are generated from the Rust types.
- A CodeMirror SQL editor:
  - `Mod+Enter` runs the selection, or else the statement under the cursor.
  - Completion knows the schema: columns after `alias.`, tables after
    `FROM` and `JOIN`, and whole `JOIN … ON` conditions from foreign keys.
  - Server error positions are underlined in the text.
  - `Mod+Shift+F` formats, only when asked, as one undo step.
- A canvas results grid that pages rows from Rust, so a million rows cost
  what the screen shows:
  - Columns can be resized, fitted, pinned, hidden and sorted.
  - Cells can be selected with the mouse or keyboard and copied as TSV, CSV,
    JSON or `INSERT` statements.
  - Each statement's result has its own tab, and a capped result offers to
    run again without the limit.
- Results over 64 MB of text spill to a temporary file, so memory stays
  bounded. Streaming 5M rows peaks at 168 MB.
- Explain (`Mod+E`) shows the plan as a tree with costs, without running the
  statement.
- Tables opened from the navigator or `Mod+P` get a `WHERE` bar. It writes
  the filtered query into the editor and runs it.
- Copy DDL for tables, views, routines and sequences.
- Editing rows:
  - Edit cells in the grid, set them to NULL, delete rows and add rows. The
    changes collect in a draft.
  - `Mod+S` shows the exact statements before anything runs. They are saved
    in one transaction, which is undone unless every statement changed
    exactly one row.
  - Rows are named by primary key. A table without one is named by every
    value, and the one-row rule then proves the values were unique.
  - The UI never sends SQL for an edit. Rust generates every statement and
    checks its parse tree against the table's catalog before it can run.
- Connection modes are enforced in Rust. Read-only connections cannot be
  edited, read-write connections ask before a script that may change the
  schema, and full ones run everything.
- The filter bar's query is built and checked in Rust too.

### Changed

- The row cap is now 100,000 per statement, up from 1,000.
- Result pages (`QSP2`) carry each row's place in arrival order.

### Fixed

- A cancel request that arrived after a capped statement had finished no
  longer cancels the next statement.

## [0.0.1] - 2026-11-25

### Added

- Project skeleton: Rust workspace (`qs-core`, `qs-sql`, `qs-net`,
  `qs-drivers`, `qs-store`, `qs-io`, `qs-service`) and the Tauri 2 desktop app.
- An empty three-panel window (navigator, workspace, inspector) whose panel
  sizes persist, following the OS light or dark setting.
- Development databases for every engine in `dev/compose.yaml`, with seed data.
- CI on macOS, Windows and Linux, and a tag-driven release workflow.
