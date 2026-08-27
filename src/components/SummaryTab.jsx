import { useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { MONTHS } from '../lib/model.js'
import { summaryFor, chartSeries, topCategories, monthsWithActuals, actualCoverage } from '../lib/summary.js'
import { backupMessage } from '../lib/backup.js'
import { money, moneyShort, signed } from '../lib/format.js'
import { chartColors } from '../lib/theme.js'

// Colours carry series identity in the charts, but every series is also named
// in the legend and readable from the tables below, so nothing depends on
// colour alone — which is what makes the colour-vision separation a floor
// rather than the only safeguard.

export default function SummaryTab({ data, layer, theme = 'light', backup, onGoToBackup }) {
  const INK = useMemo(() => chartColors(theme), [theme])
  const planned = useMemo(() => summaryFor(data, 'planned'), [data])
  const actual = useMemo(() => summaryFor(data, 'actual'), [data])
  const series = useMemo(() => chartSeries(data), [data])
  const withActuals = useMemo(() => monthsWithActuals(data), [data])
  const coverage = useMemo(() => actualCoverage(data), [data])

  const view = layer === 'actual' ? actual : planned
  const label = layer === 'actual' ? 'Actual' : 'Planned'

  return (
    <div className="stack">
      <div className="cards">
        <Card label={`${label} income`} value={view.totals.income} />
        <Card label={`${label} expenses`} value={view.totals.expenses} />
        <Card label="Net savings" value={view.totals.net} tone={view.totals.net >= 0 ? 'up' : 'down'} />
        <Card label="Ending balance" value={view.totals.ending} tone={view.totals.ending >= 0 ? '' : 'down'} />
      </div>

      {/* Only when it is actually a problem. A banner shown every visit is a
          banner nobody reads on the day it matters. */}
      {backup && backup.status !== 'fresh' && data.items.length > 0 && (
        <p className="note err">
          <strong>{backupMessage(backup, data.year)}</strong>{' '}
          The GitHub copy is not enough on its own — an account lost, or a stolen token, takes the
          history with it.{' '}
          {onGoToBackup && (
            <button className="link" onClick={onGoToBackup}>Save a copy now</button>
          )}
        </p>
      )}

      {layer === 'actual' && coverage.planned > 0 && coverage.ratio < 0.95 && (
        <p className="note">
          <strong>Actuals cover {Math.round(coverage.ratio * 100)}% of planned expenses</strong> —{' '}
          {money(coverage.covered)} of {money(coverage.planned)}.{' '}
          {money(coverage.uncovered)} of the plan has nothing recorded against it, so the totals
          above are <strong>not</strong> a like-for-like comparison with the plan and will always
          look like an underspend. Read the per-category variance instead, and only for the
          categories that have actuals.
        </p>
      )}

      {layer === 'actual' && withActuals.length > 0 && withActuals.length < 12 && (
        <p className="note">
          Actuals are entered for {withActuals.length} of 12 months
          ({withActuals.map((i) => MONTHS[i]).join(', ')}). Totals above cover only what has been
          recorded, so comparing them against a full-year plan will always look like a saving.
        </p>
      )}

      <div className="panel">
        <h2>Income vs expenses — {label.toLowerCase()}</h2>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={INK.grid} vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: INK.axis }} stroke={INK.grid} />
              <YAxis tick={{ fontSize: 12, fill: INK.axis }} stroke={INK.grid} tickFormatter={moneyShort} width={70} />
              <Tooltip
                formatter={(v, n) => [money(v), n]}
                contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)' }}
                labelStyle={{ color: 'var(--muted)' }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey={layer === 'actual' ? 'actualIncome' : 'plannedIncome'}
                name="Income" fill={INK.income} radius={[3, 3, 0, 0]}
              />
              <Bar
                dataKey={layer === 'actual' ? 'actualExpenses' : 'plannedExpenses'}
                name="Expenses" fill={INK.expense} radius={[3, 3, 0, 0]}
              />
              <Line
                type="monotone"
                dataKey={layer === 'actual' ? 'actualEnding' : 'plannedEnding'}
                name="Ending balance" stroke={INK.balance} strokeWidth={2} dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h2>Monthly summary — {label.toLowerCase()}</h2>
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="name">&nbsp;</th>
                {MONTHS.map((m) => <th key={m} className="month">{m}</th>)}
                <th className="derived">Total</th>
              </tr>
            </thead>
            <tbody>
              <SummaryRow name="Income" months={view.income} total={view.totals.income} />
              <SummaryRow name="Expenses" months={view.expenses} total={view.totals.expenses} />
              <SummaryRow name="Net savings" months={view.net} total={view.totals.net} tone />
              <tr className="total-row">
                <th className="name">Ending balance</th>
                {view.ending.map((v, i) => (
                  <td key={i} className={`month ${v < 0 ? 'down' : ''}`}>{moneyShort(v)}</td>
                ))}
                <td className="derived">{moneyShort(view.totals.ending)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Ending balance carries forward from a starting balance of {money(data.startingBalance)},
          set on the Setup &amp; Sync tab.
        </p>
      </div>

      <div className="split">
        <div className="panel">
          <h2>Largest expense categories — {label.toLowerCase()}</h2>
          <TopList data={data} layer={layer} ink={INK} />
        </div>

        <div className="panel">
          <h2>Plan vs actual</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>&nbsp;</th>
                <th className="num">Planned</th>
                <th className="num">Actual</th>
                <th className="num">Variance</th>
              </tr>
            </thead>
            <tbody>
              <CompareRow label="Income" planned={planned.totals.income} actual={actual.totals.income} kind="income" />
              <CompareRow label="Expenses" planned={planned.totals.expenses} actual={actual.totals.expenses} kind="expense" />
              <CompareRow label="Net savings" planned={planned.totals.net} actual={actual.totals.net} kind="income" />
            </tbody>
          </table>
          {withActuals.length === 0 && (
            <p className="small muted" style={{ marginTop: 10 }}>
              No actuals recorded yet. Switch a tab to <strong>Actual</strong> and enter what you
              really spent to fill this in.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ label, value, tone = '' }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`value ${tone}`}>{moneyShort(value)}</div>
    </div>
  )
}

function SummaryRow({ name, months, total, tone = false }) {
  return (
    <tr>
      <th className="name">{name}</th>
      {months.map((v, i) => (
        <td key={i} className={`month ${tone && v ? (v > 0 ? 'up' : 'down') : ''}`}>
          {tone ? signed(v) : moneyShort(v)}
        </td>
      ))}
      <td className="derived">{tone ? signed(total) : moneyShort(total)}</td>
    </tr>
  )
}

function CompareRow({ label, planned, actual, kind }) {
  const sign = kind === 'income' ? 1 : -1
  const delta = sign * (actual - planned)
  return (
    <tr>
      <th style={{ textAlign: 'left' }}>{label}</th>
      <td className="num">{moneyShort(planned)}</td>
      <td className="num">{moneyShort(actual)}</td>
      <td className={`num ${delta ? (delta > 0 ? 'up' : 'down') : ''}`}>{signed(delta)}</td>
    </tr>
  )
}

function TopList({ data, layer, ink }) {
  const rows = topCategories(data, layer)
  if (!rows.length) return <p className="empty-state">Nothing recorded on this layer yet.</p>
  const max = rows[0].total
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div className="bar-row" key={r.id}>
          <span>{r.name}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${Math.max(2, (r.total / max) * 100)}%`, background: ink.expense }}
            />
          </span>
          <span className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{moneyShort(r.total)}</span>
        </div>
      ))}
    </div>
  )
}
