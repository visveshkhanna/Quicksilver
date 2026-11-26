# AGENTS.md

How Quicksilver is built, and the rules every change follows. Read this before
changing anything.

## Architecture

A Tauri 2 desktop app: a Rust core and a React + TypeScript UI in the OS
webview.

```text
apps/desktop/src          React UI (features/, app/, ipc/, keymap/)
apps/desktop/src-tauri    Tauri shell: thin commands that call qs-service
crates/qs-service         the one API the UI reaches: sessions, results, cancel
crates/qs-io              import and export
crates/qs-store           profiles, keychain, history, layout, catalog cache
crates/qs-drivers         one module per engine, behind cargo features
crates/qs-net             TLS, SSH, AWS SSM, password-command auth
crates/qs-sql             statement splitting, gates, generated SQL
crates/qs-core            shared domain types, no I/O
```

Dependencies point down this list only. Nothing below `src-tauri` depends on
Tauri, and everything below it is tested without a window.

## Product rules

Breaking one of these is a bug, whatever the benefit. If a task seems to need
it, stop and raise it.

1. **Never rewrite the user's SQL.** No silent `LIMIT`. The row cap is applied
   while rows are read, and the UI says when a result was capped.
2. **Every statement Quicksilver generates passes a parse-tree whitelist
   check**, one per path (edits, filters, sorts), and the user can read it
   before it runs. The check inspects the parse tree; it never trusts the
   generator.
3. **A row is edited only when it can be named exactly:** by primary key, or
   by all of its values with an exactly-one-match check. Never `DROP` or
   `TRUNCATE`, and never a multi-row `DELETE` by predicate.
4. **Blank passwords and `@` in usernames work.** Never warn about them.
5. **A TLS mode is honoured or refused by name**, never quietly weakened.
6. **Passwords live in the OS keychain only**, never in a config file or log.
7. **Driver types never leave `qs-drivers`.** The UI receives typed cells (a
   rendered string and a type tag) through `qs-service`.
8. **Rows stay in Rust.** The grid fetches only the visible window, as binary
   pages; the UI never holds a whole result.
9. **No telemetry.** The only request the app makes on its own is the update
   check, and it can be turned off.

## Clean room

Quicksilver is written from scratch. `../dbdelve` (GPL-3.0) may be read to
learn *what* a client must handle, but no code is copied, translated or
closely paraphrased from it.

## Commands

```sh
pnpm install
pnpm dev                                   # app with hot reload
pnpm check                                 # biome, tsc, vitest, version check
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                     # no database needed
cargo test --workspace -- --ignored        # live tests (and the keychain), needs dev/compose.yaml up
cargo test -p qs-store -- --ignored       # round-trips the real OS keychain
pnpm tauri build                           # installers in target/release/bundle
```

## Development databases

`docker compose -f dev/compose.yaml up -d` starts every engine with seed data
(add a service name to start just one). SQL Server is seeded by a one-shot
container: `docker compose -f dev/compose.yaml run --rm mssql-seed`.

```text
postgresql://quicksilver:quicksilver@127.0.0.1:15432/quicksilver_dev   (+ analytics, staging)
mysql://quicksilver:quicksilver@127.0.0.1:13306/quicksilver_dev        (+ analytics)
mariadb://quicksilver:quicksilver@127.0.0.1:13307/quicksilver_dev      (+ analytics)
mssql://sa:Quicksilver_dev1@127.0.0.1:11433/quicksilver_dev
clickhouse://quicksilver:quicksilver@127.0.0.1:18123/quicksilver_dev
mongodb://quicksilver:quicksilver@127.0.0.1:17017/quicksilver_dev?authSource=admin
redis://:quicksilver@127.0.0.1:16379/0
```

Live tests are `#[ignore]`d and default to these URLs; set
`QS_TEST_POSTGRES_URL` to point the Postgres ones elsewhere. Every driver must
pass the shared checks in `crates/qs-drivers/tests/conformance.rs`.

## Where the app keeps its data

The OS's per-app data directory for `dev.visvesh.quicksilver` (on macOS
`~/Library/Application Support/dev.visvesh.quicksilver`), with a `dev/`
subdirectory for debug builds:

```text
profiles.json   saved connections, never passwords
state.db        history, saved queries, tab buffers, layout, catalog cache
```

Passwords are in the OS keychain under the service `Quicksilver` (or
`Quicksilver (dev)`), one entry per profile id. A file that cannot be read is
renamed to `<name>.corrupt-<millis>` and reported once in the UI.

Results with more than 64 MB of cell text spill their full chunks to an
unnamed file in the system temporary directory, which the OS deletes when the
result closes or the app exits.

To measure streaming, paging, sorting and memory:

```sh
cargo run --release -p qs-service --example bench -- [URL] [ROWS]
QS_BENCH_NO_SORT=1 /usr/bin/time -l cargo run --release -p qs-service --example bench   # peak memory, macOS
```

## Versions and releases

- One version for the repository, in `[workspace.package]` of `Cargo.toml`.
  `pnpm version:set 1.2.3` writes it everywhere; CI fails if the manifests
  drift. `tauri.conf.json` reads it from `apps/desktop/package.json`.
- To release: set the version, add a `## [1.2.3]` section to `CHANGELOG.md`,
  commit, then push the tag `v1.2.3`. `release.yml` drafts the release,
  builds macOS (universal), Linux (x64, arm64) and Windows, and publishes when
  all of them succeed. `v0.*` tags are marked as pre-releases.
- The Rust `tauri` crate and the npm `@tauri-apps/api` and `@tauri-apps/cli`
  packages must share a minor version, or `tauri build` refuses to run. Bump
  them together.

## Generated SQL

Every statement Quicksilver writes lives in `crates/qs-sql/src/edit.rs`, and
its gate in `crates/qs-sql/src/gate.rs`. A gate is given what the catalog
says (the table, its columns, its key) and parses the statement back. Never
loosen a gate to make a generator pass: fix the generator. The generated
statements are snapshot-tested with [insta](https://insta.rs). After an
intended change, review the diff, then accept it with
`INSTA_UPDATE=always cargo test -p qs-sql` (or `cargo insta review`).

## Types shared with the UI

The TypeScript types for everything the Rust side sends are generated by
[ts-rs](https://github.com/Aleph-Alpha/ts-rs) into
`apps/desktop/src/ipc/generated` whenever `cargo test` runs. Commit them with
the Rust change; CI fails when they are stale. Never edit them by hand. A new
type the UI receives gets `#[derive(ts_rs::TS)] #[ts(export)]`.

## Conventions

- Rust: edition 2024, `cargo fmt`, clippy clean with `-D warnings`, no
  `unwrap()` outside tests, a doc comment on every public item.
- TypeScript: strict, Biome-formatted. Every keyboard shortcut is defined in
  `apps/desktop/src/keymap/keymap.ts` and nowhere else; `Mod` means Cmd on
  macOS and Ctrl elsewhere. App shortcuts listen in the capture phase, so
  they win over the editor's keys; grid shortcuts have `scope: 'grid'`.
- UI tests run in jsdom, which has no layout or canvas. Drive the grid with
  the keyboard and read its live region (`data-testid="grid-cursor"`).
  Focus inputs rather than clicking them, because the panel separators'
  hit test takes clicks there.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`…).
  No AI attribution trailers or "generated with" lines in commits or PRs.
