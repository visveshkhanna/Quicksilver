# Quicksilver

A fast, cross-platform, multi-engine database client, with a DBeaver-style
layout and keyboard-first navigation.

> Early development. See [PLAN.md](PLAN.md) for the roadmap and
> [CHANGELOG.md](CHANGELOG.md) for what has shipped.

## Planned engines

PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, SQL Server, ClickHouse, MongoDB,
Redis (and Valkey), Snowflake and Turso.

## Building from source

You need [Rust](https://rustup.rs) (stable), Node.js 24 and pnpm 10. On Linux,
also install the system packages in
[`scripts/install-linux-deps.sh`](scripts/install-linux-deps.sh).

```sh
pnpm install
pnpm dev          # run the app with hot reload
pnpm build        # build installers into target/release/bundle
```

## Development databases

```sh
docker compose -f dev/compose.yaml up -d postgres   # or leave the name off for all
```

The connection details are in [AGENTS.md](AGENTS.md#development-databases).

## Licence

[Apache-2.0](LICENSE).
