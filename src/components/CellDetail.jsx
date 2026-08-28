import { useState } from 'react'
import Modal from './Modal.jsx'
import { MONTHS } from '../lib/model.js'
import { money } from '../lib/format.js'
import { ISSUER_LABELS } from '../lib/statement.js'
import { isManual, MANUAL_SOURCE, monthOfISO } from '../lib/ledger.js'
import { SOURCE_1099 } from '../lib/tracker1099.js'
import { BANK_SOURCE } from '../lib/bank.js'

const pad = (n) => String(n).padStart(2, '0')

/** Day count for the month, so the picker cannot offer a date outside it. */
const daysIn = (year, month) => new Date(Date.UTC(Number(year), month + 1, 0)).getUTCDate()

const sourceLabel = (source) => {
  if (source === MANUAL_SOURCE) return 'Entered by hand'
  if (source === BANK_SOURCE) return 'Bank account'
  const [issuer, account] = String(source || '').split(':')
  const name = ISSUER_LABELS[issuer] || issuer || 'Import'
  return account ? `${name} ···${account}` : name
}

/**
 * What one month's figure is actually made of.
 *
 * The point is checking, not browsing: a category that looks wrong is usually
 * one miscategorised merchant, and the fastest way to find it is to read the
 * list. Rows carry the card's own category alongside the description, because
 * that pairing is what shows whether a rule misfired.
 */
export default function CellDetail({ data, item, category, month, onClose, onAdd, onRemove }) {
  const [date, setDate] = useState(`${data.year}-${pad(month + 1)}-01`)
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')

  const submit = (e) => {
    e.preventDefault()
    // The entry has to belong to the month being looked at. Letting it land in
    // another month would be worse than an error: it would disappear from the
    // list that was open, looking as though nothing had been saved.
    if (monthOfISO(date) !== month) {
      setError(`That date is not in ${MONTHS[month]}. Open that month to add it there.`)
      return
    }
    const problem = onAdd({ date, desc, amount })
    if (problem) { setError(problem); return }
    setError('')
    setDesc('')
    setAmount('')
  }

  const rows = (data.transactions || [])
    .filter((t) => t.itemId === item.id && t.month === month)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount))

  // Every row read from the 1099 tracker means the advice below should point
  // at that tracker rather than at a card rule.
  const onlyFrom1099 = rows.length > 0 && rows.every((t) => t.source === SOURCE_1099)

  const total = rows.reduce((a, t) => a + t.amount, 0)
  const recorded = item.actual?.[month]
  const bySource = rows.reduce((acc, t) => {
    acc[t.source] = (acc[t.source] || 0) + t.amount
    return acc
  }, {})

  return (
    <Modal
      title={`${item.name} — ${MONTHS[month]}`}
      subtitle={category ? `${category.name} · actual` : 'actual'}
      onClose={onClose}
    >
      {rows.length === 0 ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          {recorded === null || recorded === undefined
            ? 'Nothing recorded for this month yet. Add what you spent below — useful where an ' +
              'account only gives you a PDF statement and there is nothing to import.'
            : `${money(recorded)} is recorded here with no transactions behind it — it was typed ` +
              'in, or imported before transaction history was kept. Adding entries below rebuilds ' +
              'the figure from them.'}
        </p>
      ) : (
        <>
          <div className="grid-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="col-source">Source</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{t.date}</td>
                    <td>{t.desc}</td>
                    <td className="tiny muted col-source">{isManual(t) ? 'by hand' : t.cardCategory || '—'}</td>
                    <td className={`num ${t.amount < 0 ? 'up' : ''}`}>{money(t.amount)}</td>
                    <td style={{ width: 28 }}>
                      {/* Only hand entries can be removed here. A card's rows are
                          the statement's record; correcting those means fixing a
                          rule and re-importing. */}
                      {isManual(t) && (
                        <button
                          className="link danger"
                          title="Remove this entry"
                          aria-label={`Remove ${t.desc}`}
                          onClick={() => onRemove(t.id)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th colSpan={3} style={{ textAlign: 'left' }}>
                    {rows.length} transaction{rows.length === 1 ? '' : 's'}
                  </th>
                  <td className="num"><strong>{money(total)}</strong></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>

          <p className="small muted" style={{ marginTop: 10 }}>
            {Object.entries(bySource).map(([s, v]) => `${sourceLabel(s)} ${money(v)}`).join(' · ')}
          </p>

          {Math.abs(total - (recorded || 0)) > 0.005 && (
            <p className="note" style={{ marginTop: 10 }}>
              These transactions come to {money(total)}, but {money(recorded || 0)} is recorded.
              The difference is a figure entered by hand, which takes precedence over the import.
            </p>
          )}

          {/* The advice has to match where the figure came from. Telling
              someone to fix a merchant rule for a 1099 payment sends them
              looking for a rule that does not exist; the correction for that
              source belongs in the tracker it was read from. */}
          <p className="small muted">
            {onlyFrom1099
              ? <>Wrong figure? These come from the 1099 tracker, so the correction belongs there —
                fix the payment in that app, then re-read it on the Setup &amp; Sync tab and this
                month follows.</>
              : <>Something in the wrong place? Say which merchant and where it belongs, and the
                rule can be corrected — then re-import to move every month at once.</>}
          </p>
        </>
      )}

      <form onSubmit={submit} style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.02em', color: 'var(--muted)' }}>
          Add a transaction
        </h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            <span>Date</span>
            <input
              type="date"
              value={date}
              min={`${data.year}-${pad(month + 1)}-01`}
              max={`${data.year}-${pad(month + 1)}-${pad(daysIn(data.year, month))}`}
              onChange={(e) => setDate(e.target.value)}
              style={{ width: 160 }}
            />
          </label>
          <label className="field grow">
            <span>Description</span>
            <input value={desc} placeholder="What was it?" onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label className="field">
            <span>Amount</span>
            <input
              inputMode="decimal" value={amount} placeholder="0.00" style={{ width: 120 }}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <button className="primary" type="submit">Add</button>
        </div>
        {error && <p className="small err" style={{ marginBottom: 0 }}>{error}</p>}
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Adds to this month's figure alongside anything imported, and survives a card
          re-import. A refund goes in as a negative amount.
        </p>
      </form>
    </Modal>
  )
}
