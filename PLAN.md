# Quicksilver: build plan (v2)

**Status:** architecture confirmed (Tauri 2, Apache-2.0). Phase 1 is done
locally. Its exit criterion (CI green on all three OSes and a `v0.0.1`
pre-release) is met once the repository is pushed and tagged.

Quicksilver is a fast, cross-platform, multi-engine database client with a
DBeaver-style layout and keyboard-first navigation. It is **written from
scratch**. `../dbdelve` is a reference for behaviour and edge cases only: no
code is copied or adapted from it, so its GPL-3.0 licence does not apply. A
docs website, modelled on `../../Switchboard/apps/docs`, is built last and
served from Cloudflare Workers.

## 0. Ground rules

- **Clean room.** Read dbdelve's docs, behaviour and tests to learn *what* to
  handle (SSL modes, IAM usernames, no-PK edits). Write every line ourselves.
  Do not paste or translate its source.
- **Licence:** Apache-2.0 (same as Switchboard).
- **Commits and PRs:** no AI attribution trailers or "generated with" lines.
- **Out of scope:** theme picker and imports (only light and dark, following
  the OS), glass effects, ER diagrams, telemetry, and anything paywalled.

### Product rules (our own, informed by dbdelve's experience)

1. Never rewrite the user's SQL. No silent `LIMIT`; the row cap is applied
   while reading, and the UI says when a result was capped.
2. Every statement Quicksilver generates (cell edits, filters, sorts) passes
   one parse-tree whitelist check per path, and the user can read it before
   it runs.
3. A row is edited only when it can be named exactly: by primary key, or by
   all of its values with an exactly-one-match check. Never `DROP` or
   `TRUNCATE`, and never a multi-row `DELETE` by predicate.
4. Blank passwords and `@` in usernames work. A TLS mode is honoured or
   refused by name, never quietly weakened.
5. Passwords live in the OS keychain only.
6. The UI never sees driver types. It gets typed cells (a rendered string
   plus a type tag) through one API.

## 1. Architecture (confirmed)

### Recommendation: Tauri 2, with a Rust core and a TypeScript UI

```text
┌──────────────────────── Quicksilver.app ─────────────────────────┐
│  UI (OS webview)          React + TypeScript + Vite              │
│   navigator · tabs · CodeMirror 6 editor · canvas grid · ⌘K      │
│        ▲  typed commands (generated TS bindings)                 │
│        │  row pages as binary ArrayBuffers · progress events     │
│        ▼                                                         │
│  Tauri shell (src-tauri)  thin: wires commands → service         │
│        ▼                                                         │
│  qs-service   sessions · result store · history · cancellation   │
│        ▼                                                         │
│  qs-drivers · qs-sql · qs-net · qs-store · qs-io · qs-core       │
│        (plain Rust on tokio, no UI dependency)                   │
└──────────────────────────────────────────────────────────────────┘
```

**Why this works better across machines and OSes than dbdelve's GPUI stack:**

| Concern | GPUI (dbdelve) | Tauri 2 (proposed) |
| --- | --- | --- |
| Framework stability | Pre-1.0, breaks on minor bumps; dbdelve vendors 5 patched crates | Stable 2.x line with semver; no vendoring |
| Windows / Linux maturity | Windows support is the newest; Linux needs X11/Wayland feature flags or it panics | WebView2 (preinstalled on Win 10/11), WKWebView on macOS, WebKitGTK on Linux; all three are first-class targets |
| Async database work | GPUI's executor can't run tokio, so every driver needs its own runtime and blocking bridges | Tokio is native; every driver is plain async Rust |
| Text input, IME, accessibility, copy/paste | Hand-rolled in the framework | Comes from the browser engine |
| SQL editor | Custom tree-sitter integration | CodeMirror 6: mature SQL mode, autocomplete API, multi-cursor |
| Packaging, signing, auto-update | Hand-written scripts per OS | `tauri-action` builds dmg/msi/nsis/deb/rpm/AppImage; signed updater plugin |
| Reuse | Core is tied to the app | Core crates also give us a CLI later, and TypeScript is shared with the docs site |

**Costs and how we deal with them:**

- **The webview is slower than native rendering, especially WebKitGTK on
  Linux.** The result grid draws on a `<canvas>` (Glide Data Grid, or our own
  later), not as DOM rows. Rows **stay in Rust**: the grid asks for the
  visible window (`fetch_rows(result_id, offset, count)`) and gets a compact
  binary page back. JS never holds a million rows.
- **Memory is higher than GPUI:** roughly 100–150 MB idle against dbdelve's
  133 MB, and much lower than DBeaver's ~600 MB. We'll measure from phase 2.
- **Two languages:** Rust and TypeScript. Type-safe bindings
  (`tauri-specta`) generate the TS types from Rust, so they never drift.

**Alternatives considered:** GPUI (above); egui, iced or Slint (weak text
editing, IME and accessibility, so a good SQL editor becomes a project of its
own); Electron (too heavy, and the main thing users dislike about other
clients).

### How data moves (the part that makes or breaks performance)

1. `run_query(tab_id, sql)` starts a task in `qs-service` and returns a
   `result_id` straight away.
2. The driver streams rows into a **result store**: columnar, string cells in
   an arena, with a row cap. Results past a size threshold spill to a temp
   file so memory stays bounded.
3. Progress (rows so far, elapsed time, done, error) goes to the UI over a
   Tauri `Channel`.
4. The grid fetches pages for the visible rows as raw binary responses (no
   JSON for cells), decodes them in a small TS module and paints them on the
   canvas.
5. `cancel(result_id)` uses the engine's own cancel (Postgres cancel
   request, `KILL QUERY`, and so on) as well as dropping the task.

## 2. Repository structure

A Cargo workspace for Rust and a pnpm workspace for TypeScript, side by side.

```text
Quicksilver/
├── Cargo.toml                    # Rust workspace, shared version
├── package.json                  # pnpm workspace root (+ turbo)
├── pnpm-workspace.yaml
├── rust-toolchain.toml
├── crates/
│   ├── qs-core/                  # Cell, TypeTag, Column, Engine, Dialect, Capabilities,
│   │                             # ConnectionConfig, errors — no I/O
│   ├── qs-sql/                   # statement splitting, parse-tree gates, SQL generation
│   │                             # (UPDATE/INSERT/DELETE/ORDER BY/filter), formatter
│   ├── qs-drivers/               # Driver enum, one module per engine behind a cargo
│   │                             # feature; connect, stream, cancel, catalog
│   ├── qs-net/                   # rustls TLS, SSH tunnel via system ssh, AWS SSM,
│   │                             # password-command (IAM token) auth
│   ├── qs-store/                 # profiles, keychain, history, saved queries, buffers,
│   │                             # layout, catalog cache (for ⌘K)
│   ├── qs-io/                    # CSV/TSV/JSON import + export, DBeaver/TablePlus import
│   └── qs-service/               # sessions, result store, cancellation; the one API
│                                 # the shell exposes
├── apps/
│   ├── desktop/
│   │   ├── src-tauri/            # Tauri 2 shell: commands, menus, updater, windows
│   │   └── src/                  # React UI
│   │       ├── app/              # layout, panels, routing between tabs
│   │       ├── features/         # navigator, editor, grid, palette, forms, settings
│   │       ├── ipc/              # generated bindings + binary page decoder
│   │       └── keymap/           # bindings (also exported to the docs)
│   └── docs/                     # Fumadocs + Next static export → Cloudflare Workers
├── dev/
│   ├── compose.yaml              # one container per engine, fixed ports, seed data
│   └── seed/
├── .github/workflows/            # ci.yml, release.yml, docs.yml, audit.yml
├── AGENTS.md                     # product rules, build/test commands
├── CHANGELOG.md
├── LICENSE
└── README.md
```

Dependencies point one way: `desktop/src-tauri → qs-service → qs-io,
qs-store, qs-drivers → qs-net, qs-sql → qs-core`. The UI talks only to the
`qs-service` API. Every crate is testable without a window.

**Frontend libraries:** React 19, Vite, TypeScript, Tailwind,
`@codemirror/lang-sql`, Glide Data Grid (canvas), cmdk-style fuzzy matcher for
the palettes, Radix primitives for menus and dialogs, Zustand for UI state.
Vitest for unit tests and Playwright (or WebdriverIO through `tauri-driver`)
for end-to-end tests.

**Rust libraries:** tokio, tokio-postgres, mysql_async, rusqlite (bundled),
duckdb (bundled), tiberius, mongodb, redis, reqwest (ClickHouse, Snowflake),
rustls, keyring, sqlparser-rs (multi-dialect parse trees for the gates),
serde, specta/tauri-specta, insta (snapshot tests), tracing.

## 3. UX

### Layout (DBeaver-style)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ● prod-pg ▸ analytics ▸ public        [READ-ONLY]          ⌘K switch DB   │
├───────────────┬──────────────────────────────────────────┬───────────────┤
│ 🔍 filter…     │ [orders ✕] [Query 1 · prod-pg/analytics ✕] │ Row / Info    │
│ ▾ prod-pg     │ ┌──────────────────────────────────────┐ │ id: 42        │
│   ▾ analytics │ │ SELECT * FROM orders WHERE …         │ │ status: paid  │
│     ▾ public  │ ├──────────────────────────────────────┤ │ meta: {…}     │
│       ▸ Tables│ │ id │ status │ total │ created_at     │ │               │
│       ▸ Views │ │ canvas grid, virtualised             │ │               │
│   ▸ staging   │ └──────────────────────────────────────┘ │               │
│ ▸ local-mysql │                                          │               │
├───────────────┴──────────────────────────────────────────┴───────────────┤
│ 1,000 rows (capped) · 210 ms · prod-pg/analytics · read-only              │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left navigator** lists every connection at once, grouped by project:
  Connection → Databases → Schemas → Tables / Views / Functions / Sequences →
  Columns, Indexes, Keys. Nodes load lazily, and there's a filter box at the
  top.
- **Several connections and databases open at once.** Each tab is bound to
  connection + database + schema, shown in its title. There's also a
  database selector in the editor toolbar.
- **Right inspector:** the selected row in full (with JSON), or a tree node's
  DDL, size and row estimate.
- **Status bar:** rows, capped flag, time, target, mode. The connection's
  colour shows on the title bar, the tab and the status bar.
- Panels can be resized and collapsed, and the layout is saved.

### Keyboard (`Mod` = Cmd on macOS, Ctrl elsewhere, all rebindable)

| Shortcut | Action |
| --- | --- |
| `Mod+K` | **Switch database:** fuzzy search across every `connection / database`, most recent first, from the cached catalog. `Enter` retargets the tab, `Mod+Enter` opens a new tab there |
| `Mod+P` | Go to a table, view or function in the current connection |
| `Mod+Shift+P` | Command palette (only commands valid right now, each with its shortcut) |
| `Mod+T` / `Mod+W` / `Mod+Shift+T` | New tab / close tab / reopen closed tab |
| `Mod+Enter` / `Mod+Shift+Enter` | Run the statement under the cursor / run everything |
| `Mod+.` | Cancel the running query |
| `Mod+Shift+E` | Focus the navigator filter |
| `Mod+1…9` | Jump to tab N |

### Other UX fixes

- A first-run screen with New connection, Paste URL and Import from
  DBeaver/TablePlus.
- Reconnect in place after network loss, keeping tabs and buffers.
- Errors appear inline at the failing statement, with the server's position
  marker.
- Before building the UI (phase 4), spend half a day using dbdelve against
  the dev databases and add any other friction found to this list.

## 4. Phases

Each phase ends with a tagged pre-release, so the release pipeline gets
tested from the start.

### Phase 1: Skeleton and CI (week 1–2)

1. Licence, `README`, `AGENTS.md` (product rules), `CHANGELOG.md`.
2. Cargo workspace with empty crates; pnpm workspace; Tauri 2 app showing an
   empty three-panel layout.
3. `dev/compose.yaml`: Postgres, MySQL, MariaDB, SQL Server, ClickHouse,
   MongoDB and Redis, with seed data.
4. CI on macOS, Windows and Ubuntu: `cargo fmt/clippy/test`, `cargo deny`,
   Biome lint, `tsc`, Vitest, and a debug Tauri build. A `live` job runs the
   database tests against compose.
5. **Exit:** CI builds the app on all three OSes and a `v0.0.1` pre-release
   publishes installers.

### Phase 2: Core, service and the first engines (week 2–5)

1. `qs-core` types; `qs-net` TLS that honours every `sslmode` or refuses it
   by name.
2. `qs-drivers`: Postgres and SQLite: connect, stream with cap, cancel,
   multiple statements, catalog.
3. `qs-service`: sessions, result store (columnar, spills to disk), the
   paged binary fetch, progress channel, cancellation.
4. A conformance suite every engine must pass (types round-trip, NULLs,
   unicode, big numbers, cancel, catalog shape).
5. A benchmark harness: launch time, idle memory, 1k rows, 1M rows.
6. **Exit:** streaming 1M Postgres rows keeps memory bounded, and cancel
   works within one second.

### Phase 3: Storage (week 5–6)

Profiles with projects and colours (a corrupt file is moved aside, never
overwritten), keychain passwords, password-command auth, history, saved
queries, per-tab buffers, layout state, the catalog cache for `Mod+K`, and
separate dev and release data directories.

### Phase 4: Shell, navigator, switchers (week 6–9)

1. Layout, title-bar breadcrumb, status bar, panels whose sizes persist.
2. The navigator from section 3, with context menus (Open, New query here,
   Copy name, Copy DDL, Refresh, Disconnect).
3. Connection form: connection, security (TLS, SSH, SSM) and behaviour
   (read-only, read-write, full; colour; project), plus Test and Paste URL.
4. Tabs bound to a target, restored on launch.
5. One fuzzy matcher powering `Mod+K`, `Mod+P` and `Mod+Shift+P`; a keymap
   with a rebinding page.
6. End-to-end tests for every keyboard flow.
7. **Exit:** with two Postgres servers and a SQLite file open side by side,
   switching database with `Mod+K` takes under a second.

### Phase 5: Editor and grid (week 9–13)

CodeMirror SQL editor (run the current statement, the selection or
everything; Format only on command); schema-aware completion (tables,
`alias.` columns, `JOIN … ON` from foreign keys); the canvas grid (resize,
hide and pin columns, copy as TSV/CSV/JSON/INSERT, sort, capped notice); a
filter bar on table tabs; the row inspector; an Explain plan view.
**Exit:** 1M rows scroll smoothly on all three OSes, including Linux, and the
benchmarks are recorded.

### Phase 6: Safe editing (week 13–15)

Parse-tree gates in `qs-sql`; cell edits create `UPDATE`s shown for review; a
draft mode collects insert, update and delete into one reviewed transaction;
no-PK rows named by every value with an exactly-one-match check; connection
modes enforced; insta snapshot tests for every generated statement per
dialect.

### Phase 7: More engines (week 15–21), in this order

MySQL and MariaDB, then DuckDB (plus opening a dropped CSV, Parquet, JSON or
Excel file), SQL Server, ClickHouse, MongoDB (its own gate), Redis/Valkey
(its own gate), and finally Snowflake and Turso. Each must pass the
conformance suite and the live CI job.

### Phase 8: Connectivity and import/export (week 21–23)

SSH tunnels through the system `ssh` (your config, agent and hardware keys);
AWS SSM tunnels; DBeaver and TablePlus connection import; CSV/TSV/JSON row
import with column mapping, a preview and every statement shown first; and
export to CSV, TSV, JSON or SQL.

### Phase 9: Releases (set up in phase 1, hardened here)

1. A `v*` tag triggers `release.yml`. It checks that `CHANGELOG.md` has the
   version, runs the full matrix, then `tauri-action` builds and publishes:
   - macOS: universal `.dmg`.
   - Windows: `.msi` and NSIS `.exe`.
   - Linux: `.deb`, `.rpm` and `.AppImage`.
   - Checksums and build-provenance attestations.
2. Tauri's updater plugin with signed update manifests on GitHub Releases,
   and an off switch in Settings. No telemetry.
3. macOS notarisation and Windows signing once the certificates exist.
   Until then, a Homebrew cask and a `curl | sh` installer.
4. SemVer from one version shared by `Cargo.toml`, `package.json` and
   `tauri.conf.json` (a small script keeps them in sync); Conventional
   Commits.

### Phase 10: Docs website on Cloudflare Workers (last)

The same setup as `Switchboard/apps/docs`:

1. Next.js `output: 'export'`, Fumadocs, Tailwind 4, MDX under
   `content/docs`.
2. Pages:
   - Overview, Installation (per OS), Quick start.
   - Connecting: one page per engine, plus SSH, SSM and TLS.
   - Keyboard shortcuts, generated from `apps/desktop/src/keymap`.
   - Editing data safely, Import/Export, Troubleshooting.
   - Changelog, synced from `CHANGELOG.md`.
   - `llms.txt`.
3. Landing page with screenshots and download buttons for the latest
   release.
4. `wrangler.jsonc`:
   - Static assets from `./out`.
   - `html_handling: auto-trailing-slash` and `not_found_handling: 404-page`.
   - A custom-domain route (for example `quicksilver.visvesh.dev`).
5. Cloudflare Workers Builds deploys on every push to `main`, with preview
   URLs for PRs. `docs.yml` builds and link-checks.

### Later (after 1.0)

An out-of-process plugin protocol and an ODBC bridge (Db2, Oracle, HANA,
Redshift, BigQuery); a `qs` CLI on the same crates.

## 5. Milestones

| Milestone | Contents | Rough target |
| --- | --- | --- |
| `v0.1.0` | Phases 1–4: Postgres + SQLite, navigator, `Mod+K` | ~9 weeks |
| `v0.3.0` | Phases 5–6: editor, grid, safe editing | ~15 weeks |
| `v0.6.0` | Phase 7: all engines | ~21 weeks |
| `v1.0.0` | Phases 8–10: connectivity, releases, docs live | ~25 weeks |

The timings assume one person working part-time and are only a rough guide.
