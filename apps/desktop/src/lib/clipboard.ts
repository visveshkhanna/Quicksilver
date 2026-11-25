/**
 * Puts text on the clipboard. The text may still be on its way (from the
 * Rust side): WebKit only allows a clipboard write during the click or key
 * press that asked for it, so the write starts at once with a promise for
 * the content where the webview supports that.
 */
export async function copyText(text: string | Promise<string>): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard) throw new Error('the clipboard is not available')
  if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined' && clipboard.write) {
    try {
      const blob = text.then((t) => new Blob([t], { type: 'text/plain' }))
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      return
    } catch {
      // Some webviews take only finished content; fall back below.
    }
  }
  await clipboard.writeText(await text)
}
