import { useState } from 'react'

/**
 * What the app is until the passcode is entered.
 *
 * There is deliberately nothing behind this but ciphertext — no figures are
 * loaded, no year is known, and the storage layer refuses to write while it is
 * showing. So this is the actual gate, not a cover over a rendered app.
 */
export default function LockScreen({ appName, onUnlock }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    const message = await onUnlock(passcode)
    setBusy(false)
    if (message) { setError(message); setPasscode('') }
  }

  return (
    <div className="lock-wrap">
      <div className="panel lock-card">
        <h1 style={{ margin: '0 0 4px', fontSize: 22, letterSpacing: '-0.01em' }}>{appName}</h1>
        <p className="small muted" style={{ marginTop: 0 }}>Locked. Enter your passcode to continue.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Passcode</span>
            {/* Named so a password manager can fill it, and autoFocus so the
                common case is type-and-enter rather than tap-then-type. */}
            <input
              type="password" name="password" autoComplete="current-password" autoFocus
              value={passcode} onChange={(e) => setPasscode(e.target.value)}
            />
          </label>
          <div className="row" style={{ marginTop: 12, alignItems: 'center', gap: 10 }}>
            <button className="primary" type="submit" disabled={!passcode || busy}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            {error && <span className="small err">{error}</span>}
          </div>
        </form>
        <p className="tiny muted" style={{ marginBottom: 0, marginTop: 16 }}>
          Your figures are stored encrypted on this device and cannot be read without this
          passcode — not from this page, and not from the browser's storage. Unlocking takes a
          moment on purpose: the key is stretched with 310,000 rounds, which is what makes
          guessing slow.
        </p>
      </div>
    </div>
  )
}
