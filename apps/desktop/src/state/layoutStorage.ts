// Panel sizes, kept in the state database instead of localStorage so they
// live with the rest of the app's data (and dev builds keep their own).
//
// react-resizable-panels reads its storage synchronously, so the saved
// values are loaded once at start-up and written back shortly after each
// change.

import { getLayout, setLayout } from '../ipc/store'

const KEY = 'panels'
let values: Record<string, string> = {}
let timer: ReturnType<typeof setTimeout> | undefined

export async function loadPanelLayout() {
  values = (await getLayout<Record<string, string>>(KEY)) ?? {}
}

export const panelStorage = {
  getItem(name: string): string | null {
    return values[name] ?? null
  },
  setItem(name: string, value: string) {
    values = { ...values, [name]: value }
    clearTimeout(timer)
    timer = setTimeout(() => void setLayout(KEY, values).catch(() => {}), 300)
  },
}
