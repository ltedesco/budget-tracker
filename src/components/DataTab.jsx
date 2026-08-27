import { useRef, useState } from 'react'
import Modal from './Modal.jsx'
import StatementImport from './StatementImport.jsx'
import { copyText, downloadFile, money } from '../lib/format.js'
import { configErrors } from '../lib/github.js'
import RestorePanel from './RestorePanel.jsx'
import { pathForYear } from '../lib/storage.js'
import { backupFilename, backupMessage, backupText } from '../lib/backup.js'
import { budgetCSV } from '../lib/summary.js'
import { validateData } from '../lib/model.js'

export default function DataTab({ data, sync, token, syncStatus, actions, backup }) {
  const [preview, setPreview] = useState(null)
  const [copied, setCopied] = useState(false)
  const [pasted, setPasted] = useState('')
  const [importError, setImportError] = useState('')
  const [rawToken, setRawToken] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [setupIn, setSetupIn] = useState('')
  const [balanceDraft, setBalanceDraft] = useState(String(data.startingBalance ?? 0))
  const [seed, setSeed] = useState('actual')
  const fileRef = useRef(null)

  // The file this year actually lives in — history is per-year, like sync.
  const config = { ...sync, path: pathForYear(sync.path, data.year), token }
  const missing = configErrors(config)
  const hasSaved = Boolean(sync.tokenEnc)
  const locked = hasSaved && !token
  const unsaved = Boolean(token) && !hasSaved

  const openPreview = (p) => { setPreview(p); setCopied(false) }

  const exportCSV = () => {
    const text = budgetCSV(data)
    const filename = `budget-${data.year}.csv`
    downloadFile(filename, text, 'text/csv')
    openPreview({ title: `Budget CSV — ${data.year}`, filename, text, mime: 'text/csv' })
  }

  const exportBackup = () => {
    const text = backupText(data)
    const filename = backupFilename(data.year)
    downloadFile(filename, text, 'application/json')
    // Only the full backup counts as a backup. The CSV is for reading, not
    // for restoring, and calling it one would be the lie that matters here.
    actions.recordBackup()
    openPreview({ title: `Full backup — ${data.year}`, filename, text, mime: 'application/json' })
  }

  const importFrom = (text, source) => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      setImportError('That is not valid JSON.')
      return
    }
    const result = validateData(parsed)
    if (!result.ok) {
      setImportError(result.error)
      return
    }
    setImportError('')
    setPasted('')
    actions.restore(result.data, source)
  }

  return (
    <>
      <div className="panel">
        <h2>Setup</h2>
        <div className="row">
          <label className="field">
            <span>Budget year</span>
            <input type="number" value={data.year} readOnly style={{ width: 120 }} />
          </label>
          <label className="field">
            <span>Starting balance</span>
            <input
              inputMode="decimal" value={balanceDraft} style={{ width: 160 }}
              onChange={(e) => setBalanceDraft(e.target.value)}
              onBlur={() => actions.setStartingBalance(balanceDraft)}
            />
          </label>
          <span className="small muted" style={{ paddingBottom: 10 }}>
            Currently {money(data.startingBalance)} — the ending balance on the Summary tab
            carries forward from here.
          </span>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
          <button onClick={() => actions.rollover(data.year + 1, seed)}>
            Start {data.year + 1} from {data.year}
          </button>
          <label className="field">
            <span>Next year's plan comes from</span>
            <select value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 220 }}>
              <option value="actual">what was actually spent</option>
              <option value="planned">this year's plan</option>
              <option value="blank">nothing — start empty</option>
            </select>
          </label>
        </div>
        <p className="small muted">
          Carries the categories and line items forward keeping their identities, so the years
          still line up on the Years tab after a rename. Next year opens at this year's closing
          balance. Seeding from actuals is usually right: a plan built on last year's plan
          inherits its mistakes.
        </p>

        <div className="row" style={{ marginTop: 12, gap: 10 }}>
          <button onClick={actions.loadTemplate}>Load starter categories…</button>
          <span className="small muted">
            Fills an empty budget with the standard category set. Every name can be changed,
            and this will not touch a budget that already has entries.
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Export &amp; off-GitHub backup</h2>
        <p className={`note${backup.status === 'fresh' ? '' : ' err'}`} style={{ marginTop: -6, marginBottom: 12 }}>
          {backupMessage(backup, data.year)}
        </p>
        <div className="row" style={{ gap: 10 }}>
          <button className={backup.status === 'fresh' ? '' : 'primary'} onClick={exportBackup}>
            Full backup (JSON)
          </button>
          <button onClick={exportCSV}>Budget CSV ({data.year})</button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Save the JSON somewhere that is not GitHub — Files, iCloud, a Drive folder, an email to
          yourself. The repo's history covers an accident, but not the account going away, and not
          someone holding the token: <strong>Contents: write also grants force-push</strong>, so a
          stolen token can rewrite the history that Restore reads from. A copy off GitHub is the
          only thing outside that blast radius. Import it back from the panel below. The CSV is
          for reading in a spreadsheet and cannot be restored, so it does not count as a backup.
        </p>
      </div>

      <div className="panel">
        <h2>Import</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Accepts any budget file with <code>categories</code> and <code>items</code> arrays —
          including the seed generated from your spreadsheet. Importing <strong>replaces</strong>{' '}
          everything currently loaded and can be undone from the toast.
        </p>
        <div className="row" style={{ gap: 10, marginBottom: 10 }}>
          <button onClick={() => fileRef.current?.click()}>Choose file…</button>
          <input
            ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) importFrom(await file.text(), file.name)
            }}
          />
        </div>
        <label className="field">
          <span>…or paste budget JSON</span>
          <textarea
            rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)}
            placeholder='{"year": 2026, "categories": [...], "items": [...]}'
          />
        </label>
        <div className="row" style={{ marginTop: 8, gap: 10 }}>
          <button disabled={!pasted.trim()} onClick={() => importFrom(pasted, 'pasted text')}>
            Import from pasted text
          </button>
          {importError && <span className="small err">{importError}</span>}
        </div>
      </div>

      <StatementImport data={data} onApply={actions.applyStatement} onPrepare={actions.prepareForStatement} />

      <div className="panel">
        <h2>GitHub sync</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Reads and writes one JSON file through the GitHub Contents API, so the repo is the
          source of truth and any device can pick up where another left off. Use a{' '}
          <strong>fine-grained personal access token</strong> scoped to that single repo with{' '}
          <strong>Contents: read and write</strong>. Point this at a <strong>private</strong> repo —
          the file holds your salary, mortgage and balance figures.
        </p>

        <div className="row">
          <label className="field grow">
            <span>Owner</span>
            <input value={sync.owner} placeholder="your-github-username"
              onChange={(e) => actions.setSync({ owner: e.target.value.trim() })} />
          </label>
          <label className="field grow">
            <span>Repo</span>
            <input value={sync.repo} placeholder="budget"
              onChange={(e) => actions.setSync({ repo: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Branch</span>
            <input value={sync.branch} placeholder="main" style={{ width: 110 }}
              onChange={(e) => actions.setSync({ branch: e.target.value.trim() })} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="field grow">
            <span>Path {sync.path.includes('{year}') ? `— this year: ${sync.path.replace(/\{year\}/g, data.year)}` : ''}</span>
            <input value={sync.path} placeholder="data/budget-{year}.json"
              onChange={(e) => actions.setSync({ path: e.target.value.trim() })} />
          </label>
        </div>

        <div className="token-box" style={{ marginTop: 12 }}>
          {!hasSaved && !token && (
            <form
              className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}
              onSubmit={(e) => { e.preventDefault(); if (actions.importSetup(setupIn)) setSetupIn('') }}
            >
              <label className="field grow">
                <span>Setup code from another device</span>
                <input value={setupIn} placeholder="budget-setup-v1.…" autoComplete="off"
                  onChange={(e) => setSetupIn(e.target.value)} />
              </label>
              <button type="submit" disabled={!setupIn.trim()}>Use setup code</button>
            </form>
          )}

          {locked ? (
            <>
              <span className="small"><strong>Token locked.</strong> Enter your passphrase to sync on this device.</span>
              <form
                className="row" style={{ marginTop: 8 }}
                onSubmit={(e) => { e.preventDefault(); actions.unlock(passphrase); setPassphrase('') }}
              >
                <label className="field grow">
                  <span>Passphrase</span>
                  <input type="password" value={passphrase} autoComplete="current-password"
                    onChange={(e) => setPassphrase(e.target.value)} />
                </label>
                <button className="primary" type="submit" disabled={!passphrase}>Unlock</button>
                <button type="button" onClick={actions.forgetToken}>Forget saved token</button>
              </form>
            </>
          ) : (
            <>
              <span className="small">
                {hasSaved
                  ? <><strong>Token unlocked</strong> for this browser tab. It is stored encrypted and never in plain text.</>
                  : unsaved
                    ? <><strong>Set a passphrase.</strong> Without one the token is lost on reload.</>
                    : <>Paste the token once and choose a passphrase. Only the encrypted form is stored; unlocking again is needed after the browser closes.</>}
              </span>
              <form
                className="row" style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  actions.saveToken(rawToken || token, passphrase)
                  setRawToken(''); setPassphrase('')
                }}
              >
                {!hasSaved && (
                  <label className="field grow">
                    <span>Token</span>
                    <input type="password" value={rawToken} autoComplete="off"
                      placeholder={unsaved ? '(using the token already loaded)' : 'github_pat_…'}
                      onChange={(e) => setRawToken(e.target.value.trim())} />
                  </label>
                )}
                <label className="field grow">
                  <span>{hasSaved ? 'New passphrase' : 'Passphrase'}</span>
                  <input type="password" value={passphrase} autoComplete="new-password"
                    onChange={(e) => setPassphrase(e.target.value)} />
                </label>
                <button className="primary" type="submit" disabled={!passphrase || (!rawToken && !token)}>
                  {hasSaved ? 'Re-encrypt' : 'Save encrypted'}
                </button>
                {hasSaved && <button type="button" onClick={actions.lock}>Lock now</button>}
              </form>

              {hasSaved && (
                <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        openPreview({
                          title: 'Setup code for another device',
                          filename: 'budget-setup-code.txt',
                          text: actions.setupCode(),
                          mime: 'text/plain',
                        })
                      } catch (e) {
                        setImportError(e.message)
                      }
                    }}
                  >
                    Setup code for another device…
                  </button>
                  <span className="small muted">
                    Carries these settings and the encrypted token. Send it to yourself or to
                    whoever shares the budget — then they enter the passphrase. Treat it like a
                    password: it is not safe to post publicly.
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
          <button onClick={actions.pull} disabled={missing.length > 0 || syncStatus.busy}>Pull from GitHub</button>
          <button className="primary" onClick={actions.push} disabled={missing.length > 0 || syncStatus.busy}>Push to GitHub</button>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox" checked={sync.autoPush} style={{ width: 'auto' }}
              onChange={(e) => actions.setSync({ autoPush: e.target.checked })}
            />
            Push automatically after edits
          </label>
        </div>

        <p className="small" style={{ marginBottom: 0 }}>
          {missing.length > 0 && <span className="muted">Fill in {missing.join(', ')} to enable sync.</span>}
          {syncStatus.error && <span className="err">{syncStatus.error}</span>}
          {!syncStatus.error && syncStatus.message && <span className="ok">{syncStatus.message}</span>}
        </p>

        <p className="tiny muted" style={{ marginBottom: 0 }}>
          The encrypted token is kept in this browser's localStorage and sent only to
          api.github.com. It is never written into the data file or committed. Clear it on a
          shared device.
        </p>
      </div>

      <RestorePanel data={data} config={config} onRestore={actions.restore} />

      {preview && (
        <Modal
          title={preview.title}
          subtitle="A download was attempted. If nothing arrived, copy the text below."
          onClose={() => setPreview(null)}
        >
          <textarea readOnly rows={14} value={preview.text} onFocus={(e) => e.target.select()} />
          <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center' }}>
            <button className="primary" onClick={async () => setCopied(await copyText(preview.text))}>
              Copy to clipboard
            </button>
            <button onClick={() => downloadFile(preview.filename, preview.text, preview.mime)}>
              Download again
            </button>
            {copied && <span className="small ok">Copied.</span>}
          </div>
        </Modal>
      )}
    </>
  )
}
