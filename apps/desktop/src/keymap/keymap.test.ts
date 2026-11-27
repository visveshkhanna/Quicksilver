import { describe, expect, it } from 'vitest'
import {
  BINDINGS,
  binding,
  bindingFor,
  conflictFor,
  currentPlatform,
  eventToKeys,
  formatKeys,
  keysFor,
  matches,
  reservedFor,
  tabJump,
} from './keymap'

describe('formatKeys', () => {
  it('uses symbols on macOS', () => {
    expect(formatKeys('Mod+Shift+P', 'mac')).toBe('⌘⇧P')
    expect(formatKeys('Mod+Enter', 'mac')).toBe('⌘↩')
    expect(formatKeys('Mod+Shift+Backspace', 'mac')).toBe('⌘⇧⌫')
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

const ev = (code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key: '',
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }) as KeyboardEvent

describe('matching key events', () => {
  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(matches('Mod+K', ev('KeyK', { metaKey: true }), 'mac')).toBe(true)
    expect(matches('Mod+K', ev('KeyK', { ctrlKey: true }), 'mac')).toBe(false)
    expect(matches('Mod+K', ev('KeyK', { ctrlKey: true }), 'other')).toBe(true)
  })

  it('needs the exact modifiers', () => {
    expect(matches('Mod+K', ev('KeyK', { ctrlKey: true, shiftKey: true }), 'other')).toBe(false)
    expect(matches('Mod+Shift+P', ev('KeyP', { ctrlKey: true, shiftKey: true }), 'other')).toBe(true)
  })

  it('uses the physical key, so Shift does not change punctuation', () => {
    expect(matches('Mod+.', { ...ev('Period', { metaKey: true }), key: '>' }, 'mac')).toBe(true)
    expect(matches('Mod+Shift+Enter', ev('NumpadEnter', { ctrlKey: true, shiftKey: true }), 'other')).toBe(
      true,
    )
  })

  it('records an event as binding keys', () => {
    expect(eventToKeys(ev('KeyY', { metaKey: true, shiftKey: true }), 'mac')).toBe('Mod+Shift+Y')
    expect(eventToKeys({ ...ev('ShiftLeft', { shiftKey: true }), key: 'Shift' }, 'mac')).toBeNull()
  })

  it('applies overrides and finds conflicts', () => {
    const overrides = { 'new-tab': 'Mod+Y', 'close-tab': '' }
    expect(bindingFor(ev('KeyY', { ctrlKey: true }), overrides, 'other')?.id).toBe('new-tab')
    expect(bindingFor(ev('KeyT', { ctrlKey: true }), overrides, 'other')).toBeUndefined()
    expect(bindingFor(ev('KeyW', { ctrlKey: true }), overrides, 'other')).toBeUndefined()
    expect(conflictFor('new-tab', 'Mod+K', overrides)?.id).toBe('switch-database')
    expect(keysFor('close-tab', overrides)).toBe('')
  })

  it('jumps to tabs with Mod+1 to Mod+9', () => {
    expect(tabJump(ev('Digit3', { metaKey: true }), 'mac')).toBe(2)
    expect(tabJump(ev('Digit0', { metaKey: true }), 'mac')).toBeNull()
    expect(tabJump(ev('Digit3', { metaKey: true, shiftKey: true }), 'mac')).toBeNull()
  })
})

describe('reserved keys', () => {
  it('keeps tab jumps, editing keys and the grid’s own keys from commands', () => {
    expect(reservedFor('Mod+3', undefined)).toMatch('tab 3')
    expect(reservedFor('Mod+Z', undefined)).toMatch('undo')
    expect(reservedFor('Enter', 'grid')).toMatch('grid')
    expect(reservedFor('Enter', undefined)).toBeNull()
    expect(reservedFor('Mod+Shift+K', undefined)).toBeNull()
  })
})
