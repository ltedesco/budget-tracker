import Modal from './Modal.jsx'
import { MONTHS } from '../lib/model.js'
import { money } from '../lib/format.js'
import { ISSUER_LABELS } from '../lib/statement.js'

const sourceLabel = (source) => {
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
export default function CellDetail({ data, item, category, month, onClose }) {
  const rows = (data.transactions || [])
    .filter((t) => t.itemId === item.id && t.month === month)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount))

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
        <p className="empty-state" style={{ textAlign: 'left' }}>
          {recorded === null || recorded === undefined
            ? 'Nothing recorded for this month.'
            : `${money(recorded)} is recorded here, but there are no transactions behind it — ` +
              'it was either typed in by hand or imported before transaction history was kept. ' +
              'Re-import the statement for this month to see the detail.'}
        </p>
      ) : (
        <>
          <div className="grid-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Card category</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{t.date}</td>
                    <td>{t.desc}</td>
                    <td className="tiny muted">{t.cardCategory || '—'}</td>
                    <td className={`num ${t.amount < 0 ? 'up' : ''}`}>{money(t.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <th colSpan={3} style={{ textAlign: 'left' }}>
                    {rows.length} transaction{rows.length === 1 ? '' : 's'}
                  </th>
                  <td className="num"><strong>{money(total)}</strong></td>
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

          <p className="small muted" style={{ marginBottom: 0 }}>
            Something in the wrong place? Say which merchant and where it belongs, and the rule
            can be corrected — then re-import to move every month at once.
          </p>
        </>
      )}
    </Modal>
  )
}
