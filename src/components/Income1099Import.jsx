import { useMemo, useState } from 'react'
import { getFile } from '../lib/github.js'
import { money } from '../lib/format.js'
import { MONTHS } from '../lib/model.js'
import { categoriesOf, itemsOf } from '../lib/summary.js'
import { parse1099, payersIn, summarize1099 } from '../lib/tracker1099.js'

/**
 * Pull income straight from the 1099 tracker's data repo.
 *
 * Read-only, always: this reads one file out of that repo and never writes to
 * it. The 1099 tracker stays the record of what was earned; the budget just
 * stops needing it typed in twice.
 */
export default function Income1099Import({ data, sync, token, actions }) {
  const cfg = sync.income1099 || {}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [entries, setEntries] = useState(null)
  const [preview, setPreview] = useState(null)

  const incomeItems = useMemo(
    () => categoriesOf(data, 'income').flatMap((c) =>
      itemsOf(data, c.id).map((it) => ({ ...it, category: c.name }))),
    [data],
  )
  const target = incomeItems.find((it) => it.id === cfg.itemId) || null
  const payers = useMemo(() => (entries ? payersIn(entries, data.year) : []), [entries, data.year])

  const set = (patch) => actions.setSync({ income1099: { ...cfg, ...patch } })
  const missing = ['owner', 'repo', 'path'].filter((k) => !cfg[k])

  const fetchFile = async () => {
    setBusy(true); setError(''); setPreview(null)
    try {
      const { content } = await getFile({ ...cfg, token })
      if (content === null) {
        setError(`No file at ${cfg.path} in ${cfg.owner}/${cfg.repo} on ${cfg.branch || 'main'}.`)
        return
      }
      const parsed = parse1099(content)
      if (parsed.error) { setError(parsed.error); return }
      setEntries(parsed.entries)
      if (!parsed.entries.length) setError('That file has no dated income entries.')
    } catch (e) {
      setError(
        /\b404\b/.test(e.message)
          ? `${e.message} — a token scoped only to the budget repo cannot read ${cfg.owner}/${cfg.repo}.`
          : e.message,
      )
    } finally {
      setBusy(false)
    }
  }

  const build = () => {
    const summary = summarize1099(entries || [], {
      year: data.year, itemId: cfg.itemId, payers: cfg.payers,
    })
    if (summary.error) { setError(summary.error); return }
    setError('')
    setPreview(summary)
  }

  const togglePayer = (payer) => {
    const chosen = new Set(cfg.payers || [])
    if (chosen.has(payer)) chosen.delete(payer)
    else chosen.add(payer)
    set({ payers: [...chosen] })
    setPreview(null)
  }

  return (
    <div className="panel">
      <h2>Income from the 1099 tracker</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        Reads the 1099 tracker's data file and files its payments against one income line, month
        by month, keeping each payment as a transaction you can open. <strong>Read-only</strong> —
        nothing is ever written back to that repo. Re-importing replaces only what this source
        contributed, so a figure you typed by hand for another line, or another source's share of
        the same month, is left alone.
      </p>

      <div className="row">
        <label className="field grow">
          <span>Owner</span>
          <input value={cfg.owner || ''} placeholder={sync.owner || 'your-github-username'}
            onChange={(e) => set({ owner: e.target.value.trim() })} />
        </label>
        <label className="field grow">
          <span>Repo</span>
          <input value={cfg.repo || ''} placeholder="1099-data"
            onChange={(e) => set({ repo: e.target.value.trim() })} />
        </label>
        <label className="field">
          <span>Branch</span>
          <input value={cfg.branch || ''} placeholder="main" style={{ width: 110 }}
            onChange={(e) => set({ branch: e.target.value.trim() })} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="field grow">
          <span>Path</span>
          <input value={cfg.path || ''} placeholder="data/tracker-data.json"
            onChange={(e) => set({ path: e.target.value.trim() })} />
        </label>
        <label className="field grow">
          <span>Goes to this income line</span>
          <select value={cfg.itemId || ''} onChange={(e) => { set({ itemId: e.target.value }); setPreview(null) }}>
            <option value="">Choose a line item…</option>
            {incomeItems.map((it) => (
              <option key={it.id} value={it.id}>{it.category} — {it.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
        <button onClick={fetchFile} disabled={busy || missing.length > 0 || !token}>
          {entries ? 'Re-read the tracker' : 'Read the tracker…'}
        </button>
        {!token && <span className="small muted">Unlock the sync token first.</span>}
        {missing.length > 0 && <span className="small muted">Fill in {missing.join(', ')}.</span>}
        {busy && <span className="small muted">Reading…</span>}
        {error && <span className="small err">{error}</span>}
      </div>

      {entries && (
        <>
          <p className="small" style={{ marginBottom: 6, marginTop: 12 }}>
            {entries.length} entries in the file · {payers.length} payer{payers.length === 1 ? '' : 's'} in {data.year}
          </p>
          {payers.length > 0 && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="tiny muted">Include</span>
              {payers.map(({ payer, count }) => (
                <button
                  key={payer} type="button" className="filter-chip"
                  aria-pressed={!cfg.payers?.length || cfg.payers.includes(payer)}
                  onClick={() => togglePayer(payer)}
                >
                  {payer || '(no payer)'} · {count}
                </button>
              ))}
              {cfg.payers?.length > 0 && (
                <button className="link" onClick={() => { set({ payers: [] }); setPreview(null) }}>
                  All payers
                </button>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
            <button onClick={build} disabled={!cfg.itemId}>Preview what would change…</button>
            {!cfg.itemId && <span className="small muted">Choose the income line first.</span>}
          </div>
        </>
      )}

      {preview && target && (
        <>
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">On this line now</th>
                  <th className="num">From the tracker</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {MONTHS.map((label, m) => {
                  const now = target.actual?.[m]
                  const next = preview.cells.get(`${target.id}:${m}`)
                  const shown = next === undefined ? null : next
                  const same = (now ?? null) === (shown ?? null)
                  if (now == null && shown == null) return null
                  return (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="num">{now == null ? '—' : money(now)}</td>
                      <td className="num">{shown == null ? '—' : money(shown)}</td>
                      <td className="small muted">{same ? 'unchanged' : 'changes'}</td>
                    </tr>
                  )
                })}
                <tr className="total-row">
                  <th style={{ textAlign: 'left' }}>{data.year} total</th>
                  <td className="num">{money((target.actual || []).reduce((a, v) => a + (v || 0), 0))}</td>
                  <td className="num">{money(preview.totals.amount)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            {preview.totals.entries} payments in {data.year} land on{' '}
            <strong>{target.category} — {target.name}</strong>.
            {preview.totals.outsideYear > 0 && (
              <> {preview.totals.outsideYear} entries are for another year and are held back —
              switch the budget year to bring those in.</>
            )}
            {preview.totals.otherPayer > 0 && (
              <> {preview.totals.otherPayer} are from payers you have not included.</>
            )}
          </p>
          <div className="row" style={{ marginTop: 10, gap: 10 }}>
            <button className="primary" onClick={() => { actions.apply1099(preview, target); setPreview(null) }}>
              Apply to {target.name}
            </button>
            <span className="small muted">Undoable from the toast; nothing reaches GitHub until you push.</span>
          </div>
        </>
      )}
    </div>
  )
}
