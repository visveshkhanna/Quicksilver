/**
 * Just enough understanding of SQL for completion: which tables a statement
 * reads (with their aliases), and what kind of name belongs at the cursor.
 *
 * This is a tokenizer and a few patterns, not a parser. It skips strings and
 * comments, so a `FROM` inside a literal never counts, and it is forgiving:
 * half-typed SQL is the normal case.
 */

export type Token = {
  kind: 'word' | 'quoted' | 'punct' | 'string' | 'number'
  /** The name for words and quoted identifiers (unquoted), the text otherwise. */
  text: string
  start: number
  end: number
}

/** Splits `sql` into tokens, dropping whitespace and comments. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i] as string
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? n : close + 2
    } else if (c === "'") {
      const start = i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") {
          i++
          break
        } else i++
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i })
    } else if (c === '$' && /[A-Za-z_$]/.test(sql[i + 1] ?? '')) {
      // A Postgres dollar quote: $$ … $$ or $tag$ … $tag$.
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0]
      if (!tag) {
        tokens.push({ kind: 'punct', text: c, start: i, end: ++i })
        continue
      }
      const start = i
      const close = sql.indexOf(tag, i + tag.length)
      i = close < 0 ? n : close + tag.length
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i })
    } else if (c === '"' || c === '`' || c === '[') {
      const closeChar = c === '[' ? ']' : c
      const start = i++
      let name = ''
      while (i < n) {
        if (sql[i] === closeChar && sql[i + 1] === closeChar && c !== '[') {
          name += closeChar
          i += 2
        } else if (sql[i] === closeChar) {
          i++
          break
        } else name += sql[i++]
      }
      tokens.push({ kind: 'quoted', text: name, start, end: i })
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i] as string)) i++
      tokens.push({ kind: 'word', text: sql.slice(start, i), start, end: i })
    } else if (/[0-9]/.test(c)) {
      const start = i
      while (i < n && /[0-9.eE]/.test(sql[i] as string)) i++
      tokens.push({ kind: 'number', text: sql.slice(start, i), start, end: i })
    } else {
      tokens.push({ kind: 'punct', text: c, start: i, end: ++i })
    }
  }
  return tokens
}

const isName = (t: Token | undefined): t is Token =>
  t !== undefined && (t.kind === 'word' || t.kind === 'quoted')
const isWord = (t: Token | undefined, ...words: string[]) =>
  t?.kind === 'word' && words.includes(t.text.toUpperCase())

/** Words that end a table reference, so they are never taken for an alias. */
const CLAUSE_WORDS = new Set(
  [
    'WHERE',
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'FULL',
    'CROSS',
    'NATURAL',
    'OUTER',
    'ON',
    'USING',
    'GROUP',
    'ORDER',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UNION',
    'EXCEPT',
    'INTERSECT',
    'SET',
    'VALUES',
    'RETURNING',
    'WINDOW',
    'FETCH',
    'FOR',
    'LATERAL',
    'AS',
    'SELECT',
    'FROM',
    'DEFAULT',
    'TABLESAMPLE',
    'WITH',
  ].map((w) => w.toUpperCase()),
)

export type TableRef = {
  schema: string | null
  name: string
  alias: string | null
  /** Where the reference starts in the statement. */
  start: number
}

/** The tokens of the statement around `cursor` (statements end at `;`). */
export function statementTokens(sql: string, cursor: number): Token[] {
  const tokens = tokenize(sql)
  let from = 0
  let to = tokens.length
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token
    if (t.kind !== 'punct' || t.text !== ';') continue
    if (t.end <= cursor) from = i + 1
    else {
      to = i
      break
    }
  }
  return tokens.slice(from, to)
}

/** Reads `name`, `schema.name` (or longer) at `i`; returns the parts and the next index. */
function readQualified(tokens: Token[], i: number): { parts: string[]; next: number } | null {
  if (!isName(tokens[i])) return null
  const parts = [(tokens[i] as Token).text]
  let j = i + 1
  while (tokens[j]?.text === '.' && isName(tokens[j + 1])) {
    parts.push((tokens[j + 1] as Token).text)
    j += 2
  }
  return { parts, next: j }
}

/** Every table a statement names after FROM, JOIN, UPDATE or INTO, with its alias. */
export function tablesInScope(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], 'FROM', 'JOIN', 'UPDATE', 'INTO')) continue
    let j = i + 1
    for (;;) {
      if (isWord(tokens[j], 'ONLY', 'LATERAL')) j++
      const read = readQualified(tokens, j)
      if (
        !read ||
        (tokens[j]?.kind === 'word' && CLAUSE_WORDS.has((tokens[j] as Token).text.toUpperCase()))
      ) {
        break
      }
      const name = read.parts[read.parts.length - 1] as string
      const schema = read.parts.length > 1 ? (read.parts[read.parts.length - 2] as string) : null
      j = read.next
      let alias: string | null = null
      if (isWord(tokens[j], 'AS')) j++
      const candidate = tokens[j]
      if (
        isName(candidate) &&
        !(candidate.kind === 'word' && CLAUSE_WORDS.has(candidate.text.toUpperCase())) &&
        tokens[j + 1]?.text !== '('
      ) {
        alias = candidate.text
        j++
      }
      refs.push({ schema, name, alias, start: tokens[i + 1]?.start ?? 0 })
      // `FROM a, b` lists more than one.
      if (tokens[j]?.text === ',' && isWord(tokens[i], 'FROM')) {
        j++
        continue
      }
      break
    }
  }
  return refs
}

/** What belongs at the cursor. */
export type Want =
  /** After `name.`: a column of that table or alias, or a table of that schema. */
  | { kind: 'member'; qualifier: string; from: number }
  /** A table name (after FROM, JOIN, UPDATE, INTO). */
  | { kind: 'table'; from: number }
  /** After `JOIN t [alias] ON`: a join condition. */
  | { kind: 'joinCondition'; table: TableRef; from: number }
  /** Anything: a column in scope, a table, a keyword. */
  | { kind: 'any'; from: number }

/**
 * What kind of name the cursor at `cursor` in `sql` is completing, and where
 * the half-typed word starts.
 */
export function wantAt(sql: string, cursor: number): { want: Want; scope: TableRef[] } {
  const tokens = statementTokens(sql, cursor)
  const before = tokens.filter((t) => t.end <= cursor)
  const scope = tablesInScope(tokens)

  // The word being typed, if the cursor is at its end.
  let last = before[before.length - 1]
  let from = cursor
  let prev = before.length - 1
  if (isName(last) && last.end === cursor) {
    from = last.start
    prev--
    last = before[prev]
  }

  if (last?.text === '.' && last.end === from) {
    const qualifier = before[prev - 1]
    if (isName(qualifier)) return { want: { kind: 'member', qualifier: qualifier.text, from }, scope }
  }
  if (
    isWord(last, 'FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE') ||
    (last?.text === ',' && inFromList(before, prev))
  ) {
    return { want: { kind: 'table', from }, scope }
  }
  if (isWord(last, 'ON')) {
    const table = joinedBefore(before, prev)
    if (table) return { want: { kind: 'joinCondition', table, from }, scope }
  }
  return { want: { kind: 'any', from }, scope }
}

/** Whether the comma at `index` separates tables in a FROM list. */
function inFromList(tokens: Token[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const t = tokens[i] as Token
    if (t.text === '(' || t.text === ')') return false
    if (t.kind === 'word') {
      const word = t.text.toUpperCase()
      if (word === 'FROM') return true
      if (CLAUSE_WORDS.has(word)) return false
    }
  }
  return false
}

/** The table joined by the `JOIN … ON` whose ON is at `index`. */
function joinedBefore(tokens: Token[], index: number): TableRef | null {
  for (let i = index - 1; i >= 0 && i >= index - 6; i--) {
    if (isWord(tokens[i], 'JOIN')) {
      return tablesInScope(tokens.slice(i, index))[0] ?? null
    }
  }
  return null
}

/** How a table reference is written in SQL: its alias, or its name. */
export function refName(ref: TableRef): string {
  return ref.alias ?? ref.name
}

/** Reserved words that must be quoted to be used as names. */
const RESERVED = new Set(
  (
    'all and any array as asc between both case cast check collate column constraint create cross ' +
    'current_date current_time current_timestamp current_user default deferrable desc distinct do ' +
    'else end except false fetch for foreign from full grant group having in index inner insert ' +
    'intersect into is join key leading left like limit natural not null offset on only or order ' +
    'outer primary references returning right select session_user set some table then to trailing ' +
    'true union unique update user using values when where window with'
  ).split(' '),
)

/**
 * Quotes an identifier when it needs it: anything but lower-case letters,
 * digits and `_`, or a reserved word.
 */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`
}
