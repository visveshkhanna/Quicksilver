/**
 * The one fuzzy matcher behind `Mod+K`, `Mod+P` and `Mod+Shift+P`.
 *
 * Every query character must appear in the text, in order, ignoring case.
 * Matches score higher when they are consecutive, start a word, or come
 * early, so `sal` ranks `sales` above `fiscal_all`.
 */

export type Match = {
  score: number
  /** Indexes in the text of the matched characters, for highlighting. */
  positions: number[]
}

const WORD_BREAK = /[\s/._\-:]/

/** How well `query` matches `text`, or `null` when it does not. */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase()
  if (q === '') return { score: 0, positions: [] }
  const t = text.toLowerCase()
  const positions: number[] = []
  let score = 0
  let from = 0
  const chars = [...q].filter((ch) => ch !== ' ')
  for (const [n, ch] of chars.entries()) {
    const at = bestIndex(t, text, ch, from, chars.slice(n + 1))
    if (at < 0) return null
    const previous = positions[positions.length - 1]
    if (previous !== undefined && at === previous + 1) score += 8
    if (at === 0 || WORD_BREAK.test(text[at - 1] ?? '') || isCamelStart(text, at)) score += 6
    score += Math.max(0, 3 - at * 0.05)
    positions.push(at)
    from = at + 1
  }
  // Prefer shorter texts when the matches are otherwise equal.
  score -= text.length * 0.01
  return { score, positions }
}

/**
 * The next index of `ch` at or after `from`, preferring a word start nearby,
 * but only one from which the `rest` of the query can still match.
 */
function bestIndex(lower: string, text: string, ch: string, from: number, rest: string[]): number {
  const first = lower.indexOf(ch, from)
  if (first < 0) return -1
  for (let i = first; i >= 0 && i < Math.min(lower.length, first + 24); i = lower.indexOf(ch, i + 1)) {
    if ((i === 0 || WORD_BREAK.test(text[i - 1] ?? '')) && fits(lower, rest, i + 1)) return i
  }
  return first
}

/** Whether `rest` appears in order in `lower` from `from` on. */
function fits(lower: string, rest: string[], from: number): boolean {
  let at = from
  for (const ch of rest) {
    at = lower.indexOf(ch, at)
    if (at < 0) return false
    at++
  }
  return true
}

function isCamelStart(text: string, at: number): boolean {
  const c = text[at] ?? ''
  const p = text[at - 1] ?? ''
  return c !== c.toLowerCase() && p === p.toLowerCase() && p !== ''
}

/**
 * The items matching `query`, best first. Ties keep the input order, so the
 * caller decides what ranks first among equals (most recent, say).
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
): { item: T; match: Match }[] {
  const matched: { item: T; match: Match; order: number }[] = []
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, text(item))
    if (match) matched.push({ item, match, order })
  })
  if (query.trim() !== '') matched.sort((a, b) => b.match.score - a.match.score || a.order - b.order)
  return matched.map(({ item, match }) => ({ item, match }))
}
