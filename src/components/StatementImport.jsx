import { useRef, useState } from 'react'
import { MONTHS } from '../lib/model.js'
import { parseStatement, summarise, previewRows, applySummary, CATCH_ALL_ITEM } from '../lib/statement.js'
import { money, moneyShort } from '../lib/format.js'

/**
 * Import a card statement into the actual layer.
 *
 * Nothing is written until the preview has been seen and confirmed. The
 * preview reconciles every dollar in the file into one of five buckets, so it
 * is always visible what the import is about to do — and, just as important,
 * what it is declining to do.
 */
export default function StatementImport({ data, onApply, onPrepare }) {
  const [result, setResult] = useState(null) // { summary, rows, warnings, filename }
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  const load = (text, filename) => {
    const parsed = parseStatement(text)
    if (parsed.error) { setError(parsed.error); setResult(null); return }
    if (!parsed.rows.length) { setError('No transactions found in that file.'); setResult(null); return }
    setError('')
    // Sweeping needs the catch-all line to exist, so summarise against the
    // prepared document rather than the current one.
    const prepared = onPrepare()
    setResult({
      prepared,
      summary: summarise(parsed.rows, prepared),
      warnings: parsed.warnings,
      filename,
      statementTotal: parsed.rows.reduce((a, r) => a + r.amount, 0),
    })
  }

  const apply = () => {
    onApply(applySummary(result.prepared, result.summary), result.summary, result.filename)
    setResult(null)
  }

  const s = result?.summary
  const rows = s ? previewRows(s, result.prepared) : []

  return (
    <div className="panel">
      <h2>Import card statement</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        Reads an Amex CSV export and fills in the <strong>Actual</strong> layer, so you can see
        where real spending is landing against plan. Export from Amex as <strong>CSV</strong> with{' '}
        <em>include all additional details</em> ticked — that adds the category column this needs.
        Payments to the card are excluded; they are transfers, not spending. Anything without a
        confident category still gets recorded, on an <strong>{CATCH_ALL_ITEM}</strong> line — so
        the actual total is never quieter than what you really charged.
      </p>

      <div className="row" style={{ gap: 10 }}>
        <button onClick={() => fileRef.current?.click()}>Choose statement CSV…</button>
        <input
          ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) load(await file.text(), file.name)
          }}
        />
        {error && <span className="small err">{error}</span>}
      </div>

      {s && (
        <>
          <p className="small" style={{ marginTop: 14, marginBottom: 6 }}>
            <strong>{result.filename}</strong> — {s.rowCount} transactions
            {s.monthLabels.length > 0 && <> covering {s.monthLabels.join(', ')}</>}
          </p>

          {result.warnings.map((w) => (
            <p className="note" key={w} style={{ marginTop: 8 }}>{w}</p>
          ))}

          <table className="data-table" style={{ marginTop: 10, maxWidth: 520 }}>
            <tbody>
              <Bucket label="Will be recorded" value={s.totals.assigned} strong />
              {s.totals.swept > 0 && (
                <Bucket label="— of which unassigned" value={s.totals.swept} muted indent />
              )}
              <Bucket label="Card payments (excluded)" value={s.totals.payments} muted />
              <Bucket label={`Not in ${data.year} (skipped)`} value={s.totals.wrongYear} muted />
              {s.totals.missingItem > 0 && (
                <Bucket label="No such line item" value={s.totals.missingItem} warn />
              )}
              <tr>
                <th style={{ textAlign: 'left' }}>Statement total</th>
                <td className="num">{money(result.statementTotal)}</td>
              </tr>
            </tbody>
          </table>

          {rows.length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>What will be written</h2>
              <div className="grid-scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="name">Line item</th>
                      {s.months.map((m) => <th key={m} className="month">{MONTHS[m]}</th>)}
                      <th className="derived">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.itemId}>
                        <td className="name">
                          {r.name} <span className="muted tiny">{r.category}</span>
                        </td>
                        {s.months.map((m) => (
                          <td key={m} className="month">{r.months[m] === undefined ? '–' : moneyShort(r.months[m])}</td>
                        ))}
                        <td className="derived">{moneyShort(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                These months are <strong>replaced</strong>, not added to — importing the same file
                twice lands on the same numbers. Months not shown here keep whatever they hold.
              </p>
            </>
          )}

          {s.unmatched.length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>Not assigned</h2>
              <p className="small muted" style={{ marginTop: -6 }}>
                No confident mapping, so these are recorded on the{' '}
                <strong>{CATCH_ALL_ITEM}</strong> line rather than guessed into a category. The
                money is counted; only the breakdown is missing. Move it by hand, or say what these
                should map to and the rule can be added.
              </p>
              <table className="data-table" style={{ maxWidth: 520 }}>
                <tbody>
                  {s.unmatched.map((u) => (
                    <tr key={u.category}>
                      <th style={{ textAlign: 'left', fontWeight: 400 }}>{u.category}</th>
                      <td className="num muted tiny">{u.count}×</td>
                      <td className="num">{money(u.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {s.missingItem.length > 0 && (
            <p className="note" style={{ marginTop: 12 }}>
              {s.missingItem.map((m) => `${m.name} (${money(m.total)})`).join(', ')} —
              {' '}mapped, but no expense line item by that name exists in this budget. Add or
              rename a line item to match and import again.
            </p>
          )}

          <div className="row" style={{ marginTop: 16, gap: 10 }}>
            <button className="primary" onClick={apply} disabled={rows.length === 0}>
              Record {money(s.totals.assigned)} to Actual
            </button>
            <button onClick={() => setResult(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}

function Bucket({ label, value, strong, muted, warn, indent }) {
  return (
    <tr>
      <th
        style={{ textAlign: 'left', fontWeight: strong ? 600 : 400, paddingLeft: indent ? 22 : undefined }}
        className={muted ? 'muted' : ''}
      >
        {label}
      </th>
      <td className={`num ${warn ? 'down' : ''}`} style={{ fontWeight: strong ? 600 : 400 }}>
        {money(value)}
      </td>
    </tr>
  )
}
