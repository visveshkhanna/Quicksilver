// The OS file chooser.

import { open } from '@tauri-apps/plugin-dialog'

const FILTERS = {
  database: [
    { name: 'Database files', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 'duckdb'] },
    { name: 'All files', extensions: ['*'] },
  ],
  certificate: [
    { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
    { name: 'All files', extensions: ['*'] },
  ],
}

/** Asks for one existing file; `null` when the chooser was cancelled. */
export async function chooseFile(
  kind: keyof typeof FILTERS,
  title: string,
  current?: string | null,
): Promise<string | null> {
  const picked = await open({
    title,
    multiple: false,
    directory: false,
    filters: FILTERS[kind],
    defaultPath: current ?? undefined,
  })
  return typeof picked === 'string' ? picked : null
}
