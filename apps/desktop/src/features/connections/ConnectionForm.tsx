import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ColorDot, Modal } from '../../app/ui'
import {
  type Auth,
  type Color,
  type Mode,
  type PasswordChange,
  type ProfileFields,
  parseUrl,
  type SslMode,
  testConnection,
} from '../../ipc/store'
import type { Engine } from '../../ipc/types'
import { chooseFile } from '../../lib/files'
import { COLORS } from '../../lib/target'
import { closeDialog, errorText, profileById, saveProfile, useApp } from '../../state/app'
import { formatUrl } from './url'

/** Engines this build has drivers for. More arrive with their drivers. */
const ENGINES: { id: Engine; name: string; port: number | null; file: boolean }[] = [
  { id: 'postgres', name: 'PostgreSQL', port: 5432, file: false },
  { id: 'sqlite', name: 'SQLite', port: null, file: true },
]

const SSL_MODES: { id: SslMode; label: string }[] = [
  { id: 'disable', label: 'disable: never use TLS' },
  { id: 'prefer', label: 'prefer: TLS if the server offers it, certificate not checked' },
  { id: 'require', label: 'require: always TLS, certificate not checked' },
  { id: 'verify-ca', label: 'verify-ca: always TLS, certificate chain checked' },
  { id: 'verify-full', label: 'verify-full: always TLS, chain and host name checked' },
]

const MODES: { id: Mode; label: string; detail: string }[] = [
  { id: 'readOnly', label: 'Read-only', detail: 'Writes are refused by the database connection itself.' },
  { id: 'readWrite', label: 'Read-write', detail: 'Reads and writes.' },
  { id: 'full', label: 'Full', detail: 'Reads, writes and schema changes, without extra prompts.' },
]

type AuthChoice = 'keychain' | 'none' | 'command'

function blank(): ProfileFields {
  return {
    name: '',
    project: null,
    color: null,
    engine: 'postgres',
    host: '127.0.0.1',
    port: null,
    user: null,
    database: null,
    path: null,
    sslMode: 'prefer',
    sslRootCert: null,
    options: {},
    auth: { kind: 'keychain' },
    mode: 'readWrite',
  }
}

/** Splits a command line into arguments, honouring "double" and 'single' quotes. */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started || current) args.push(current)
  return args
}

function joinArgs(args: string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' ')
}

const empty = (value: string) => (value.trim() === '' ? null : value.trim())

const basename = (path: string) => path.split(/[\\/]/).pop() || path

/** The new- and edit-connection dialog. */
export function ConnectionForm({
  profileId,
  pasteUrl,
  project,
}: {
  profileId: string | null
  pasteUrl?: boolean
  /** The folder a new connection goes in. */
  project?: string | null
}) {
  const existing = profileById(profileId)
  const profiles = useApp((s) => s.profiles)
  const projects = useMemo(
    () => [...new Set(profiles.flatMap((p) => (p.project ? [p.project] : [])))],
    [profiles],
  )
  const [fields, setFields] = useState<ProfileFields>(() => {
    if (!existing) return { ...blank(), project: project ?? null }
    const { id, createdMs, updatedMs, ...rest } = existing
    return rest
  })
  const [section, setSection] = useState<'connection' | 'security' | 'behaviour'>('connection')
  const [password, setPassword] = useState('')
  const [forget, setForget] = useState(false)
  const [command, setCommand] = useState(() =>
    existing?.auth.kind === 'command'
      ? [existing.auth.program, ...existing.auth.args].map((a) => joinArgs([a])).join(' ')
      : '',
  )
  /** The URL as typed, while it differs from what the fields say; `null` mirrors the fields. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether the name was typed; until it is, the name follows the URL. */
  const [named, setNamed] = useState(Boolean(existing))
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  /** The port as typed, while it is not a valid port. */
  const [badPort, setBadPort] = useState<string | null>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ;(pasteUrl ? urlInput : nameInput).current?.focus()
  }, [pasteUrl])

  const engine = ENGINES.find((e) => e.id === fields.engine) ?? ENGINES[0]
  const authChoice: AuthChoice = fields.auth.kind === 'none' ? 'none' : fields.auth.kind
  const set = <K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) =>
    setFields((f) => ({ ...f, [key]: value }))

  const auth = (): Auth => {
    if (authChoice !== 'command') return fields.auth
    const [program = '', ...args] = splitArgs(command)
    return { kind: 'command', program, args }
  }
  const final = (): ProfileFields => ({ ...fields, auth: auth(), name: fields.name.trim() })
  const typedPassword = authChoice === 'keychain' && password !== '' ? password : null

  /** Reads `text` into the fields. The text stays as typed; a bad URL is said beside it. */
  const fill = async (text: string) => {
    if (urlTimer.current) clearTimeout(urlTimer.current)
    if (text.trim() === '') {
      setUrlError(null)
      return
    }
    try {
      const parsed = await parseUrl(text)
      const known = ENGINES.find((e) => e.id === parsed.fields.engine)
      if (!known) {
        setUrlError(`This build cannot connect to ${parsed.fields.engine} yet.`)
        return
      }
      setFields((f) => ({
        ...parsed.fields,
        name: named ? f.name : parsed.fields.name,
        project: f.project,
        color: f.color,
        mode: f.mode,
        // A URL with a password saves it to the keychain; one without keeps the chosen source.
        auth: parsed.password !== null ? { kind: 'keychain' } : f.auth,
      }))
      if (parsed.password !== null) setPassword(parsed.password)
      setBadPort(null)
      setUrlError(null)
    } catch (err) {
      setUrlError(errorText(err))
    }
  }
  const typeUrl = (text: string, now: boolean) => {
    setUrlDraft(text)
    if (urlTimer.current) clearTimeout(urlTimer.current)
    if (now) void fill(text)
    else urlTimer.current = setTimeout(() => void fill(text), 300)
  }
  useEffect(
    () => () => {
      if (urlTimer.current) clearTimeout(urlTimer.current)
    },
    [],
  )

  const pick = async (kind: 'database' | 'certificate') => {
    try {
      const file =
        kind === 'database'
          ? await chooseFile('database', 'Choose the database file', fields.path)
          : await chooseFile('certificate', 'Choose the root certificate', fields.sslRootCert)
      if (file === null) return
      if (kind === 'database') {
        setFields((f) => ({ ...f, path: file, name: named ? f.name : basename(file) }))
      } else set('sslRootCert', file)
    } catch (err) {
      setStatus({ text: `Could not open the file chooser: ${errorText(err)}`, ok: false })
    }
  }

  /** What still has to be filled in, if anything; every field it names is on the Connection section. */
  const problem = (): string | null => {
    if (fields.name.trim() === '') return 'Give the connection a name.'
    if (engine?.file && !fields.path?.trim()) return 'Choose the database file.'
    if (!engine?.file && badPort !== null) return 'The port must be a number from 1 to 65535.'
    if (authChoice === 'command' && (auth() as { program?: string }).program === '')
      return 'Enter the command that prints the password.'
    return null
  }
  const check = (): boolean => {
    const text = problem()
    if (text === null) return true
    setSection('connection')
    setStatus({ text, ok: false })
    return false
  }

  const test = async () => {
    if (!check()) return
    setBusy(true)
    setStatus({ text: 'Connecting…', ok: true })
    try {
      await testConnection(final(), profileId, typedPassword)
      setStatus({ text: 'Connected successfully.', ok: true })
    } catch (err) {
      setStatus({ text: errorText(err), ok: false })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!check()) return
    setBusy(true)
    try {
      const change: PasswordChange =
        authChoice !== 'keychain'
          ? { kind: 'clear' }
          : typedPassword !== null
            ? { kind: 'set', password: typedPassword }
            : forget
              ? { kind: 'clear' }
              : { kind: 'keep' }
      await saveProfile(profileId, final(), change)
      closeDialog()
    } catch (err) {
      setStatus({ text: errorText(err), ok: false })
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'New connection'} onClose={closeDialog} width={600}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex gap-1 border-b border-border px-3 pt-2" role="tablist">
          {(['connection', 'security', 'behaviour'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={`-mb-px rounded-t border-b-2 px-3 py-1.5 capitalize ${
                section === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {id}
            </button>
          ))}
        </div>

        <div className="grid max-h-[60vh] grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2.5 overflow-auto p-4">
          {section === 'connection' && (
            <>
              <Label htmlFor="cf-url">URL</Label>
              <div className="flex min-w-0 flex-col gap-1">
                <input
                  id="cf-url"
                  ref={urlInput}
                  value={urlDraft ?? formatUrl(fields)}
                  onChange={(e) => typeUrl(e.target.value, false)}
                  onPaste={(e) => {
                    // Pasting over the whole URL replaces it; pasting into it edits it.
                    const input = e.currentTarget
                    const whole = input.selectionStart === 0 && input.selectionEnd === input.value.length
                    if (!whole && input.value !== '') return
                    e.preventDefault()
                    typeUrl(e.clipboardData.getData('text').trim(), true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void fill(e.currentTarget.value)
                    }
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    if (urlError === null) setUrlDraft(null)
                  }}
                  aria-invalid={urlError !== null}
                  aria-describedby="cf-url-help"
                  placeholder="Paste a URL: postgres://user@host:5432/database"
                  spellCheck={false}
                  autoComplete="off"
                  className={`${INPUT} font-mono text-[12px] aria-invalid:border-[#e5484d]`}
                />
                <p id="cf-url-help" className={`text-[11px] ${urlError ? 'text-[#e5484d]' : 'text-muted'}`}>
                  {urlError ?? 'Paste or edit a URL to fill in the fields below. JDBC URLs work too.'}
                </p>
              </div>
              <Label htmlFor="cf-name">Name</Label>
              <input
                id="cf-name"
                ref={nameInput}
                required
                value={fields.name}
                onChange={(e) => {
                  setNamed(e.target.value.trim() !== '')
                  set('name', e.target.value)
                }}
                placeholder="prod-pg"
                className={INPUT}
              />
              <Label htmlFor="cf-engine">Engine</Label>
              <select
                id="cf-engine"
                value={fields.engine}
                onChange={(e) => set('engine', e.target.value as Engine)}
                className={INPUT}
              >
                {ENGINES.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              {engine?.file ? (
                <>
                  <Label htmlFor="cf-path">File</Label>
                  <div className="flex gap-2">
                    <input
                      id="cf-path"
                      required
                      value={fields.path ?? ''}
                      onChange={(e) => set('path', empty(e.target.value))}
                      placeholder="/path/to/database.db"
                      spellCheck={false}
                      className={`${INPUT} flex-1`}
                    />
                    <Button onClick={() => void pick('database')}>Choose…</Button>
                  </div>
                </>
              ) : (
                <>
                  <Label htmlFor="cf-host">Host</Label>
                  <div className="flex gap-2">
                    <input
                      id="cf-host"
                      value={fields.host ?? ''}
                      onChange={(e) => set('host', empty(e.target.value))}
                      className={`${INPUT} flex-1`}
                    />
                    <input
                      aria-label="Port"
                      inputMode="numeric"
                      value={badPort ?? fields.port ?? ''}
                      aria-invalid={badPort !== null}
                      onChange={(e) => {
                        const text = e.target.value.trim()
                        const n = Number(text)
                        if (text === '' || (Number.isInteger(n) && n > 0 && n < 65536)) {
                          setBadPort(null)
                          set('port', text === '' ? null : n)
                        } else {
                          setBadPort(e.target.value)
                        }
                      }}
                      placeholder={String(engine?.port ?? '')}
                      className={`${INPUT} w-20 aria-invalid:border-[#e5484d]`}
                    />
                  </div>
                  <Label htmlFor="cf-user">User</Label>
                  <input
                    id="cf-user"
                    value={fields.user ?? ''}
                    onChange={(e) => set('user', e.target.value === '' ? null : e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className={INPUT}
                  />
                  <Label htmlFor="cf-auth">Password</Label>
                  <select
                    id="cf-auth"
                    value={authChoice}
                    onChange={(e) => {
                      const choice = e.target.value as AuthChoice
                      set(
                        'auth',
                        choice === 'command' ? { kind: 'command', program: '', args: [] } : { kind: choice },
                      )
                    }}
                    className={INPUT}
                  >
                    <option value="keychain">Saved in the OS keychain (or asked for)</option>
                    <option value="none">No password</option>
                    <option value="command">From a command (IAM token, password manager)</option>
                  </select>
                  {authChoice === 'keychain' && (
                    <>
                      <span />
                      <div className="flex flex-col gap-1">
                        <input
                          type="password"
                          aria-label="Password to save"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder={
                            existing ? 'Leave empty to keep the saved one' : 'Leave empty to be asked'
                          }
                          autoComplete="new-password"
                          className={INPUT}
                        />
                        {existing?.auth.kind === 'keychain' && (
                          <label className="flex items-center gap-1.5 text-[12px] text-muted">
                            <input
                              type="checkbox"
                              checked={forget}
                              onChange={(e) => setForget(e.target.checked)}
                            />
                            Forget the saved password
                          </label>
                        )}
                      </div>
                    </>
                  )}
                  {authChoice === 'command' && (
                    <>
                      <span />
                      <input
                        aria-label="Password command"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="aws rds generate-db-auth-token --hostname … --username …"
                        spellCheck={false}
                        className={`${INPUT} font-mono text-[12px]`}
                      />
                    </>
                  )}
                  <Label htmlFor="cf-db">Database</Label>
                  <input
                    id="cf-db"
                    value={fields.database ?? ''}
                    onChange={(e) => set('database', empty(e.target.value))}
                    placeholder="The server default"
                    className={INPUT}
                  />
                </>
              )}
            </>
          )}

          {section === 'security' && (
            <>
              <Label htmlFor="cf-ssl">TLS</Label>
              <select
                id="cf-ssl"
                value={fields.sslMode}
                onChange={(e) => set('sslMode', e.target.value as SslMode)}
                disabled={engine?.file}
                className={INPUT}
              >
                {SSL_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Label htmlFor="cf-cert">Root certificate</Label>
              <div className="flex gap-2">
                <input
                  id="cf-cert"
                  value={fields.sslRootCert ?? ''}
                  onChange={(e) => set('sslRootCert', empty(e.target.value))}
                  placeholder="PEM file; the OS trust store when empty"
                  disabled={engine?.file}
                  spellCheck={false}
                  className={`${INPUT} flex-1`}
                />
                <Button onClick={() => void pick('certificate')} disabled={engine?.file}>
                  Choose…
                </Button>
              </div>
              {engine?.file && (
                <p className="col-span-2 text-[12px] text-muted">
                  A file database has no network security settings.
                </p>
              )}
            </>
          )}

          {section === 'behaviour' && (
            <>
              <Label>Mode</Label>
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Mode">
                {MODES.map((m) => (
                  <label key={m.id} className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="mode"
                      checked={fields.mode === m.id}
                      onChange={() => set('mode', m.id)}
                      className="mt-1"
                    />
                    <span>
                      {m.label} <span className="text-[12px] text-muted">{m.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
              <Label>Colour</Label>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
                <Swatch selected={fields.color === null} onClick={() => set('color', null)} label="No colour">
                  <ColorDot color={null} className="size-3 border border-muted" />
                </Swatch>
                {(Object.keys(COLORS) as Color[]).map((c) => (
                  <Swatch key={c} selected={fields.color === c} onClick={() => set('color', c)} label={c}>
                    <ColorDot color={c} className="size-3" />
                  </Swatch>
                ))}
              </div>
              <Label htmlFor="cf-project">Project</Label>
              <input
                id="cf-project"
                list="cf-projects"
                value={fields.project ?? ''}
                onChange={(e) => set('project', empty(e.target.value))}
                placeholder="Groups connections in the navigator"
                className={INPUT}
              />
              <datalist id="cf-projects">
                {projects.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <p
            role="status"
            className={`min-w-0 flex-1 truncate text-[12px] ${status?.ok === false ? 'text-[#e5484d]' : 'text-muted'}`}
            title={status?.text}
          >
            {status?.text}
          </p>
          <Button onClick={() => void test()} disabled={busy}>
            Test
          </Button>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button kind="primary" type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}

const INPUT =
  'min-w-0 rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent disabled:opacity-50'

function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-right text-muted">
      {children}
    </label>
  )
}

function Swatch({
  selected,
  onClick,
  label,
  children,
}: {
  selected: boolean
  onClick: () => void
  label: string
  children: ReactNode
}) {
  return (
    // A swatch is a button styled as a colour, acting as one radio option.
    // biome-ignore lint/a11y/useSemanticElements: a native radio cannot show a swatch
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={`flex size-6 items-center justify-center rounded ${selected ? 'ring-2 ring-accent' : 'hover:bg-raised'}`}
    >
      {children}
    </button>
  )
}
