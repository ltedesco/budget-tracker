import { useState } from 'react'
import Modal from './Modal.jsx'
import { compareToCurrent, loadVersions, readVersion } from '../lib/history.js'
import { configErrors } from '../lib/github.js'
import { copyText, downloadFile, money } from '../lib/format.js'

const VERSION_LIMIT = 20

const bytes = (n) =>
  n === null || n === undefined ? '—'
  : n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB`
  : `${(n / (1024 * 1024)).toFixed(1)} MB`

const listJoin = (parts) =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

const when = (iso) => {
  if (!iso) return 'unknown date'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

const ago = (iso) => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}

/**
 * Restore from history.
 *
 * Every push already leaves a full copy of the year's file in the repo. This
 * is the part that was missing: seeing those copies and reading one back
 * without git or the GitHub website, which is the only form of backup that is
 * any use from a phone on the day something goes wrong.
 */
export default function RestorePanel({ data, config, onRestore }) {
  const [versions, setVersions] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [copied, setCopied] = useState(false)

  const missing = configErrors(config)
  const blocked = missing.length > 0

  const list = async () => {
    setBusy(true); setError('')
    try {
      const found = await loadVersions(config, VERSION_LIMIT)
      setVersions(found)
      if (!found.length) setError(`No history for ${config.path} yet — push once and this fills in.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const open = async (version) => {
    setBusy(true); setError(''); setCopied(false)
    try {
      const result = await readVersion(config, version.sha)
      if (result.error) { setError(result.error); return }
      setPreview({ version, ...result, compare: compareToCurrent(result.summary, data) })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const restore = () => {
    const { version, data: restored } = preview
    setPreview(null)
    onRestore(restored, `GitHub history (${when(version.date)})`)
  }

  return (
    <div className="panel">
      <h2>Restore from history</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        Every push leaves a complete copy of <code>{config.path || 'the data file'}</code> in the
        repo. These are those copies. Preview one to see what it holds, then restore it if it is
        the one you want — the restore lands locally first and is undoable from the toast, so
        nothing reaches GitHub until you push.
      </p>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button onClick={list} disabled={blocked || busy}>
          {versions ? 'Refresh versions' : 'Show versions…'}
        </button>
        {blocked && <span className="small muted">Fill in {missing.join(', ')} to read history.</span>}
        {busy && <span className="small muted">Reading GitHub…</span>}
        {error && <span className="small err">{error}</span>}
      </div>

      {versions && versions.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th className="num">Size</th>
                <th>Change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v, i) => {
                const prev = versions[i + 1]
                const shrank =
                  typeof v.size === 'number' && typeof prev?.size === 'number' && v.size < prev.size * 0.8
                return (
                  <tr key={v.sha}>
                    <td>
                      {when(v.date)}
                      <span className="muted"> · {ago(v.date)}</span>
                      {i === 0 && <span className="muted"> · latest</span>}
                    </td>
                    <td className="num">
                      {bytes(v.size)}
                      {/* A version much smaller than the one before it is the
                          shape a wipe has. Worth an eye before restoring. */}
                      {shrank && <span className="err" title="Much smaller than the version before it"> ↓</span>}
                    </td>
                    <td className="small muted">{v.message || '—'}</td>
                    <td className="num">
                      <button onClick={() => open(v)} disabled={busy}>Preview…</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <Modal
          title={`Version from ${when(preview.version.date)}`}
          subtitle={`${bytes(preview.size)} · commit ${preview.version.sha.slice(0, 7)}`}
          onClose={() => setPreview(null)}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>What it holds</th>
                <th className="num">This version</th>
                <th className="num">Loaded now</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Year</td><td className="num">{preview.summary.year}</td><td className="num">{preview.compare.now.year}</td></tr>
              <tr><td>Categories</td><td className="num">{preview.summary.categories}</td><td className="num">{preview.compare.now.categories}</td></tr>
              <tr><td>Line items</td><td className="num">{preview.summary.items}</td><td className="num">{preview.compare.now.items}</td></tr>
              <tr><td>Transactions</td><td className="num">{preview.summary.transactions}</td><td className="num">{preview.compare.now.transactions}</td></tr>
              <tr><td>Planned expense</td><td className="num">{money(preview.summary.plannedExpense)}</td><td className="num">{money(preview.compare.now.plannedExpense)}</td></tr>
              <tr><td>Actual expense</td><td className="num">{money(preview.summary.actualExpense)}</td><td className="num">{money(preview.compare.now.actualExpense)}</td></tr>
              <tr><td>Planned income</td><td className="num">{money(preview.summary.plannedIncome)}</td><td className="num">{money(preview.compare.now.plannedIncome)}</td></tr>
              <tr><td>Actual income</td><td className="num">{money(preview.summary.actualIncome)}</td><td className="num">{money(preview.compare.now.actualIncome)}</td></tr>
            </tbody>
          </table>

          {preview.compare.yearMismatch && (
            <p className="note err" style={{ marginTop: 12 }}>
              This version is for {preview.summary.year}, but {preview.compare.now.year} is open.
              Switch to {preview.summary.year} before restoring, or it will overwrite the wrong year.
            </p>
          )}

          {preview.compare.losses.length > 0 && (
            <p className="note" style={{ marginTop: 12 }}>
              Restoring drops {listJoin(preview.compare.losses)} that are loaded now. Undo from
              the toast puts them back, and a later pull still merges in whatever is on GitHub —
              nothing is lost there until you push.
            </p>
          )}

          <p className="small muted" style={{ marginTop: 12, marginBottom: 4 }}>
            The full file, if you would rather keep a copy than restore it:
          </p>
          <textarea
            readOnly rows={8}
            value={JSON.stringify(preview.data, null, 2)}
            onFocus={(e) => e.target.select()}
          />

          <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
            <button
              className="primary"
              disabled={preview.compare.yearMismatch}
              onClick={restore}
            >
              Restore this version
            </button>
            <button
              onClick={() =>
                downloadFile(
                  `budget-${preview.summary.year}-${(preview.version.date || '').slice(0, 10)}.json`,
                  JSON.stringify(preview.data, null, 2),
                )
              }
            >
              Download it
            </button>
            <button onClick={async () => setCopied(await copyText(JSON.stringify(preview.data, null, 2)))}>
              Copy
            </button>
            {copied && <span className="small ok">Copied.</span>}
          </div>
        </Modal>
      )}
    </div>
  )
}
