import { describe, expect, it } from 'vitest'
import { BINDINGS, binding, currentPlatform, formatKeys } from './keymap'

describe('formatKeys', () => {
  it('uses symbols on macOS', () => {
    expect(formatKeys('Mod+Shift+P', 'mac')).toBe('⌘⇧P')
    expect(formatKeys('Mod+Enter', 'mac')).toBe('⌘↩')
  })

  it('spells Mod as Ctrl elsewhere', () => {
    expect(formatKeys('Mod+Shift+P', 'other')).toBe('Ctrl+Shift+P')
  })
})

describe('currentPlatform', () => {
  it('detects macOS from the user agent', () => {
    expect(currentPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac')
    expect(currentPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other')
    expect(currentPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other')
  })
})

describe('BINDINGS', () => {
  it('has unique ids and unique keys', () => {
    expect(new Set(BINDINGS.map((b) => b.id)).size).toBe(BINDINGS.length)
    expect(new Set(BINDINGS.map((b) => b.keys)).size).toBe(BINDINGS.length)
  })

  it('throws on an unknown id', () => {
    expect(() => binding('nope')).toThrow()
  })
})
