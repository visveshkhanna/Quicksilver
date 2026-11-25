#!/usr/bin/env node
// One version for the whole repository.
//
//   node scripts/version.mjs check              all manifests agree
//   node scripts/version.mjs check v1.2.3       ...and agree with this tag, and
//                                               CHANGELOG.md has a section for it
//   node scripts/version.mjs set 1.2.3          write it everywhere
//   node scripts/version.mjs notes 1.2.3        print that CHANGELOG section
//
// The Cargo workspace version is the source of truth. tauri.conf.json reads
// the desktop package.json, so it needs no entry here.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CARGO = join(root, 'Cargo.toml')
const PACKAGES = ['package.json', 'apps/desktop/package.json'].map((p) => join(root, p))
const CHANGELOG = join(root, 'CHANGELOG.md')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CARGO_VERSION = /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/

function fail(message) {
  console.error(`version: ${message}`)
  process.exit(1)
}

function cargoVersion() {
  const match = readFileSync(CARGO, 'utf8').match(CARGO_VERSION)
  if (!match) fail('no version in [workspace.package] of Cargo.toml')
  return match[2]
}

function changelogSection(version) {
  const lines = readFileSync(CHANGELOG, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return null
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
}

const [command, arg] = process.argv.slice(2)

if (command === 'check') {
  const version = cargoVersion()
  for (const file of PACKAGES) {
    const found = JSON.parse(readFileSync(file, 'utf8')).version
    if (found !== version) fail(`${file} has ${found}, Cargo.toml has ${version}`)
  }
  if (arg) {
    if (arg !== `v${version}`) fail(`tag ${arg} does not match version ${version}`)
    if (!changelogSection(version)) fail(`CHANGELOG.md has no "## [${version}]" section`)
  }
  console.log(`version ${version} OK`)
} else if (command === 'set') {
  if (!arg || !SEMVER.test(arg)) fail('usage: set <major.minor.patch>')
  writeFileSync(CARGO, readFileSync(CARGO, 'utf8').replace(CARGO_VERSION, `$1${arg}$3`))
  for (const file of PACKAGES) {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    json.version = arg
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  }
  console.log(`set version ${arg}; run cargo check to update Cargo.lock`)
} else if (command === 'notes') {
  const section = arg && changelogSection(arg.replace(/^v/, ''))
  if (!section) fail(`CHANGELOG.md has no section for ${arg}`)
  console.log(section)
} else {
  fail('usage: check [tag] | set <version> | notes <version>')
}
