import { useRef, useState } from 'react'
import { money } from '../lib/format.js'
import {
  parseBank, resolveBankTarget, summariseBank, rulesFromText, rulesToText,
} from '../lib/bank.js'
import { previewRows } from '../lib/statement.js'

/**
 * Import a current-account export.
 *
 * The panel leads with what it is NOT going to import, because on a bank feed
 * that is the larger and more surprising half. Payments to the cards are
 * typically the biggest debits of the month and every one of them is already
 * itemised by the card import; a reader who does not see them named will
 * reasonably assume they were counted.
 */
export default function BankImport({ data, actions }) {
  const [summary, setSummary] = useState(null)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState([])
  const [rulesText, setRulesText] = useState(() => rulesToText(data.bankRules))
  const [ruleErrors, setRuleErrors] = useState([])
  const [showRules, setShowRules] = useState(false)
  const fileRef = useRef(null)

  const saveRules = () => {
    const { rules, errors } = rulesFromText(rulesText)
    setRuleErrors(errors)
    if (!errors.length) { actions.setBankRules(rules); setSummary(null) }
  }

  const read = async (file) => {
    setError(''); setSummary(null); setWarnings([])
    const parsed = parseBank(await file.text())
    if (parsed.error) { setError(parsed.error); return }
    if (!parsed.rows.length) { setError('No rows with a readable date and amount.'); return }
    setFilename(file.name)
    setWarnings(parsed.warnings)
    setSummary(summariseBank(parsed.rows, data, {
      year: data.year,
      existing: data.transactions || [],
      resolve: (spec) => resolveBankTarget(data, spec),
    }))
  }

  const r = summary?.report
  const excluded = r ? r.excluded.filter((e) => e.rows) : []
  const lines = summary ? previewRows(summary, data) : []

  return (
    <div className="panel">
      <h2>Import bank account</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        Reads a current-account CSV — money in as well as out. A bank feed is not a card
        statement: most of what leaves the account is not spending, so payments to your cards,
        transfers to savings and brokerage, and person-to-person payments are{' '}
        <strong>excluded by default</strong> and shown below rather than dropped quietly. Anything
        already recorded by hand on the same day for the same amount is skipped, so a paycheck you
        typed in is not counted twice.
      </p>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button onClick={() => fileRef.current?.click()}>Choose bank file…</button>
        <input
          ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) await read(file)
          }}
        />
        {filename && <span className="small muted">{filename}</span>}
        {error && <span className="small err">{error}</span>}
      </div>

      {warnings.map((w) => <p className="small muted" key={w}>{w}</p>)}

      <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center' }}>
        <button className="link" onClick={() => setShowRules((v) => !v)}>
          {showRules ? 'Hide' : 'Edit'} rules ({(data.bankRules || []).length} of your own)
        </button>
      </div>

      {showRules && (
        <>
          <label className="field">
            <span>
              One per line: <code>pattern =&gt; Category::Item</code>, or{' '}
              <code>pattern =&gt; ignore</code> for anything that is not budget spending
            </span>
            <textarea rows={7} value={rulesText} onChange={(e) => setRulesText(e.target.value)}
              placeholder={'city water => Utilities::Water\nacme mortgage => Home::Primary mortgage\n^check \\d => ignore'} />
          </label>
          <div className="row" style={{ marginTop: 8, gap: 10, alignItems: 'center' }}>
            <button onClick={saveRules}>Save rules</button>
            {ruleErrors.map((e) => <span className="small err" key={e}>{e}</span>)}
          </div>
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            These are stored with your budget, in your private repository — never in the app's
            published code, which would put your billers and line-item names in a public place.
            The app itself ships only a few generic rules; yours are matched after them and win.
          </p>
        </>
      )}

      {summary && (
        <>
          <h3 className="tiny muted" style={{ margin: '16px 0 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Not imported
          </h3>
          <div className="table-scroll">
            <table className="data-table">
              <tbody>
                {excluded.map((e) => (
                  <tr key={e.key}>
                    <td style={{ width: '30%' }}>{e.label}</td>
                    <td className="small muted">{e.why}</td>
                    <td className="num">{e.rows}</td>
                    <td className="num">{money(e.amount)}</td>
                  </tr>
                ))}
                {r.duplicates.rows > 0 && (
                  <tr>
                    <td>Already recorded</td>
                    <td className="small muted">an entry you already have, same day and amount</td>
                    <td className="num">{r.duplicates.rows}</td>
                    <td className="num">{money(r.duplicates.amount)}</td>
                  </tr>
                )}
                {r.splits.rows > 0 && (
                  <tr>
                    <td>Already recorded, split</td>
                    <td className="small muted">
                      your entries for that day add up to the deposit — listed below
                    </td>
                    <td className="num">{r.splits.rows}</td>
                    <td className="num">{money(r.splits.amount)}</td>
                  </tr>
                )}
                {r.wrongYear.rows > 0 && (
                  <tr>
                    <td>Another year</td>
                    <td className="small muted">outside {data.year}</td>
                    <td className="num">{r.wrongYear.rows}</td>
                    <td className="num">{money(r.wrongYear.amount)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* A number this large cannot just assert itself. Skipping is the
              right default, but "$99,633 was already recorded" is only
              trustworthy if you can see what it matched against. */}
          {r.duplicates.samples.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <p className="small muted" style={{ margin: '0 0 4px' }}>
                Matched against entries you already have
                {r.duplicates.rows > r.duplicates.samples.length &&
                  ` — first ${r.duplicates.samples.length} of ${r.duplicates.rows}`}:
              </p>
              <table className="data-table">
                <thead>
                  <tr><th>Date</th><th>From the bank</th><th>Already recorded as</th><th className="num">Amount</th></tr>
                </thead>
                <tbody>
                  {r.duplicates.samples.map((d) => (
                    <tr key={d.iso + d.amount + d.desc}>
                      <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{d.iso}</td>
                      <td className="small">{d.desc.slice(0, 46)}</td>
                      <td className="small muted">{d.matched}</td>
                      <td className="num">{money(Math.abs(d.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.splits.samples.length > 0 && (
            <p className="note" style={{ marginTop: 10 }}>
              {r.splits.samples.map((s) => (
                <span key={s.iso + s.amount}>
                  <strong>{s.iso}</strong>: the bank shows {money(Math.abs(s.amount))}, and you
                  entered {s.parts.map((p) => money(p.amount)).join(' + ')} = {money(s.partsTotal)}.
                  Taken as the same money and skipped.
                </span>
              ))}
            </p>
          )}

          <h3 className="tiny muted" style={{ margin: '16px 0 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            To import
          </h3>
          {lines.length === 0 ? (
            <p className="small muted">Nothing left to import from this file.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Goes to</th><th className="num">Rows</th><th className="num">Total</th></tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.itemId}>
                      <td>{l.category} — {l.name}</td>
                      <td className="num">
                        {summary.transactions.filter((t) => t.itemId === l.itemId).length}
                      </td>
                      <td className="num">{money(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.unassigned.rows > 0 && (
            <p className="note err" style={{ marginTop: 10 }}>
              <strong>{r.unassigned.rows} rows ({money(r.unassigned.amount)}) have no rule</strong>{' '}
              and are <strong>not</strong> imported. Nothing is guessed at: a wrong line moves money
              silently, while a gap you can see is a gap you can close. Tell me what any of them
              are and I will add the rule.
            </p>
          )}

          <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
            <button
              className="primary"
              disabled={!summary.transactions.length}
              onClick={() => { actions.applyBank(summary, filename); setSummary(null) }}
            >
              Import {summary.transactions.length} transactions
            </button>
            <span className="small muted">Undoable from the toast; nothing reaches GitHub until you push.</span>
          </div>
        </>
      )}
    </div>
  )
}
