import { Fragment, useMemo } from 'react'
import { compareYears, yearTotals } from '../lib/years.js'
import { moneyShort, signed } from '../lib/format.js'

/**
 * Year against year.
 *
 * The comparison worth reading is actual-to-actual: two plans compared tell you
 * only how your intentions changed. Plan is shown beside it because the gap
 * between them is the thing a budget exists to surface, but the change column
 * tracks what really happened.
 */
export default function YearsTab({ docs, onLoadYear, knownYears, activeYear }) {
  const { years, rows } = useMemo(() => compareYears(docs), [docs])
  const income = useMemo(() => yearTotals(docs, 'income'), [docs])
  const expense = useMemo(() => yearTotals(docs, 'expense'), [docs])

  if (docs.length < 2) {
    return (
      <div className="panel">
        <h2>Year over year</h2>
        <p className="small muted">
          Only {years.join(', ') || 'one year'} is loaded on this device, so there is nothing to
          compare against yet. Pull another year from GitHub, or roll this one forward from
          Setup &amp; Sync to start {activeYear + 1}.
        </p>
        {knownYears.length > 1 && (
          <div className="row" style={{ gap: 8 }}>
            {knownYears.filter((y) => !years.includes(y)).map((y) => (
              <button key={y} onClick={() => onLoadYear(y)}>Load {y}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const change = (row) => {
    const first = row.years[years[0]]
    const last = row.years[years[years.length - 1]]
    // Both years have to have been tracked. Comparing a finished year against
    // one that has not happened yet produces a large, confident, meaningless
    // number — the whole of last year shown as a fall.
    if (!first?.hasActual || !last?.hasActual) return null
    const delta = (last.actual || 0) - (first.actual || 0)
    // Positive is better for income, worse for expenses — the same convention
    // the variance view uses, so green never means two different things.
    return { delta, good: row.kind === 'income' ? delta > 0 : delta < 0 }
  }

  return (
    <div className="stack">
      <div className="cards">
        {years.map((y) => {
          const inc = income.find((t) => t.year === y)
          const exp = expense.find((t) => t.year === y)
          return (
            <div className="card" key={y}>
              <div className="label">{y} actual</div>
              <div className="value">{moneyShort((inc?.actual || 0) - (exp?.actual || 0))}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>
                {moneyShort(inc?.actual || 0)} in · {moneyShort(exp?.actual || 0)} out
              </div>
            </div>
          )
        })}
      </div>

      <div className="panel">
        <h2>By line item</h2>
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="name">Line item</th>
                {years.map((y) => (
                  <th key={y} className="month" colSpan={2} style={{ textAlign: 'center' }}>{y}</th>
                ))}
                <th className="derived">Change</th>
              </tr>
              <tr>
                <th className="name" />
                {years.map((y) => (
                  <Fragment key={y}>
                    <th className="month tiny muted">plan</th>
                    <th className="month tiny muted">actual</th>
                  </Fragment>
                ))}
                <th className="derived tiny muted">actual</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const c = change(row)
                return (
                  <tr key={row.key}>
                    <td className="name">
                      {row.name} <span className="muted tiny">{row.category}</span>
                    </td>
                    {years.map((y) => (
                      <Fragment key={y}>
                        <td className="month muted">{row.years[y] ? moneyShort(row.years[y].planned) : '–'}</td>
                        <td className="month">{row.years[y]?.hasActual ? moneyShort(row.years[y].actual) : '–'}</td>
                      </Fragment>
                    ))}
                    <td className={`derived ${c && c.delta ? (c.good ? 'up' : 'down') : ''}`}>
                      {c && c.delta ? signed(c.delta) : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          A dash means that year has nothing recorded for the line — which is not the same as it
          costing nothing. Change compares {years[0]} and {years[years.length - 1]} actuals, and is
          only shown where both years were actually tracked; it is signed so a positive number is
          the better outcome.
        </p>
      </div>
    </div>
  )
}
