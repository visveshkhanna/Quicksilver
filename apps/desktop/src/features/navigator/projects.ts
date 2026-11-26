// Projects are folders of connections, nested to any depth. A connection's
// `project` is its folder's path, names joined by `/` ("Work/Client A").
// Folders with no connections yet are kept in a list of their own.

import type { Profile } from '../../ipc/store'

/** How deep folders may nest. */
export const MAX_DEPTH = 8

export type Folder = {
  name: string
  path: string
  folders: Folder[]
  profiles: Profile[]
}

/** The names in `path`, without blanks: `" Work / A/"` → `["Work", "A"]`. */
export function splitPath(path: string | null | undefined): string[] {
  return (path ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** `path` tidied: trimmed names, no empty ones; `null` for the top level. */
export function normalPath(path: string | null | undefined): string | null {
  const parts = splitPath(path)
  return parts.length === 0 ? null : parts.join('/')
}

export function parentOf(path: string): string | null {
  return normalPath(splitPath(path).slice(0, -1).join('/'))
}

export function nameOf(path: string): string {
  return splitPath(path).at(-1) ?? ''
}

/** Whether `path` is `folder` or inside it. */
export function within(path: string | null, folder: string): boolean {
  return path !== null && (path === folder || path.startsWith(`${folder}/`))
}

/** `path` with its leading `from` replaced by `to` (`null` moves it to the top level). */
export function moved(path: string, from: string, to: string | null): string | null {
  if (!within(path, from)) return path
  const rest = path.slice(from.length)
  return normalPath(`${to ?? ''}${rest}`)
}

/** Why `name` cannot name a folder, or `null` when it can. */
export function badFolderName(name: string): string | null {
  if (name.trim() === '') return 'Give the folder a name.'
  if (name.includes('/')) return 'A folder name cannot contain "/".'
  return null
}

/** The folder tree for `profiles` and the saved empty `folders`, sorted by name. */
export function buildTree(profiles: Profile[], folders: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], profiles: [] }
  const index = new Map<string, Folder>([['', root]])
  const folderAt = (path: string | null): Folder => {
    const parts = splitPath(path).slice(0, MAX_DEPTH)
    let node = root
    let at = ''
    for (const part of parts) {
      at = at ? `${at}/${part}` : part
      let next = index.get(at)
      if (!next) {
        next = { name: part, path: at, folders: [], profiles: [] }
        index.set(at, next)
        node.folders.push(next)
      }
      node = next
    }
    return node
  }
  for (const path of folders) folderAt(path)
  for (const profile of profiles) folderAt(profile.project).profiles.push(profile)
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name))
    folder.profiles.sort((a, b) => a.name.localeCompare(b.name))
    folder.folders.forEach(sort)
  }
  sort(root)
  return root
}

/** Every folder path in the tree, parents before children. */
export function allPaths(folder: Folder): string[] {
  return folder.folders.flatMap((f) => [f.path, ...allPaths(f)])
}

/** How many connections are in `folder`, at any depth. */
export function countIn(folder: Folder): number {
  return folder.profiles.length + folder.folders.reduce((n, f) => n + countIn(f), 0)
}
