import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, LabelList,
} from 'recharts'
import { money, moneyShort } from '../lib/format.js'
import { categoryColors, otherColor } from '../lib/theme.js'

/**
 * One stacked bar per period, split by category — income and expenses kept as
 * two separate stacks side by side.
 *
 * They are never stacked together. Adding a salary onto a grocery bill
 * produces a taller bar that measures nothing; the two are different
 * directions of the same ledger, and the whole point of the chart is the gap
 * between them.
 */
export default function CategoryChart({
  rows, income, expense, ink, theme, xKey = 'month', height = 300, showTotals = false,
}) {
  const hues = categoryColors(theme)
  const grey = otherColor(theme)
  const fill = (s) => (s.slot < 0 ? grey : hues[s.slot])

  // Each stack's total is labelled on its topmost band, which is the last one
  // drawn. Only where the bars are few enough for the numbers not to collide.
  const topIncome = income[income.length - 1]?.id
  const topExpense = expense[expense.length - 1]?.id

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: showTotals ? 22 : 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ink.grid} vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: ink.axis }} stroke={ink.grid} />
          <YAxis
            tick={{ fontSize: 12, fill: ink.axis }} stroke={ink.grid}
            tickFormatter={moneyShort} width={70}
          />
          <Tooltip
            cursor={{ fill: 'var(--accent-soft)' }}
            content={<StackTooltip income={income} expense={expense} fill={fill} />}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />

          {income.map((s) => (
            <Bar key={s.id} dataKey={s.id} name={s.name} stackId="income" fill={fill(s)}
              stroke="var(--panel)" strokeWidth={1}>
              {showTotals && s.id === topIncome && (
                <LabelList dataKey="incomeTotal" position="top" formatter={moneyShort}
                  style={{ fontSize: 11, fill: 'var(--muted)' }} />
              )}
            </Bar>
          ))}
          {expense.map((s) => (
            <Bar key={s.id} dataKey={s.id} name={s.name} stackId="expense" fill={fill(s)}
              stroke="var(--panel)" strokeWidth={1}>
              {showTotals && s.id === topExpense && (
                <LabelList dataKey="expenseTotal" position="top" formatter={moneyShort}
                  style={{ fontSize: 11, fill: 'var(--muted)' }} />
              )}
            </Bar>
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * The totals first, then what makes them up.
 *
 * Recharts' default lists every band and leaves the addition to the reader,
 * which on a twelve-band stack is the one thing they wanted the chart for.
 * Bands worth nothing this period are dropped rather than listed as zeroes.
 */
function StackTooltip({ active, payload, label, income, expense, fill }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const part = (list) =>
    list.map((s) => ({ ...s, value: row[s.id] || 0 })).filter((s) => s.value !== 0)

  const sections = [
    ['Income', row.incomeTotal, part(income)],
    ['Expenses', row.expenseTotal, part(expense)],
  ].filter(([, total, items]) => total || items.length)

  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{label}</div>
      {sections.map(([name, total, items]) => (
        <div className="chart-tip-section" key={name}>
          <div className="chart-tip-total">
            <span>{name}</span>
            <strong>{money(total)}</strong>
          </div>
          {items.map((s) => (
            <div className="chart-tip-row" key={s.id}>
              <span className="chart-tip-swatch" style={{ background: fill(s) }} />
              <span className="chart-tip-name">{s.name}</span>
              <span className="chart-tip-value">{money(s.value)}</span>
            </div>
          ))}
        </div>
      ))}
      {sections.length === 2 && (
        <div className="chart-tip-net">
          <span>Net</span>
          <strong>{money(row.incomeTotal - row.expenseTotal)}</strong>
        </div>
      )}
    </div>
  )
}
