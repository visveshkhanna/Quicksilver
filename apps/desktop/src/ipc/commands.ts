import { invoke, isTauri } from '@tauri-apps/api/core'

/** One engine, as `qs-service` describes it. */
export type EngineInfo = {
  id: string
  name: string
  defaultPort: number | null
}

/** What the app reports about itself (`qs_service::AppInfo`). */
export type AppInfo = {
  name: string
  version: string
  engines: EngineInfo[]
}

/**
 * The app's name, version and known engines.
 *
 * Outside the Tauri shell (the UI opened in a plain browser with `pnpm
 * dev:web`) there is no backend, so this resolves to `null` and the UI shows
 * that it is running without one.
 */
export async function appInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null
  return invoke<AppInfo>('app_info')
}
