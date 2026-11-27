import { useState } from 'react'
import { Button, Modal } from '../../app/ui'
import { useApp } from '../../state/app'

/** Asks for a password when a connection has none saved. */
export function PasswordPrompt() {
  const request = useApp((s) => s.passwordRequest)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  if (!request) return null
  const { profile, resolve, error } = request
  const who = [profile.user, profile.host].filter(Boolean).join(' @ ')
  return (
    <Modal title={`Password for ${profile.name}`} onClose={() => resolve(null)} width={420}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          resolve({ password, remember })
          setPassword('')
        }}
      >
        {who && <p className="text-muted">{who}</p>}
        {error && (
          <p role="alert" className="m-0 text-[12px] break-words text-danger select-text">
            {error}
          </p>
        )}
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this input
          autoFocus
          type="password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Save in the OS keychain
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={() => resolve(null)}>Cancel</Button>
          <Button kind="primary" type="submit">
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  )
}
