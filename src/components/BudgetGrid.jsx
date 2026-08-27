import { useMemo } from 'react'
import { useState } from 'react'
import MonthCell from './MonthCell.jsx'
import CellDetail from './CellDetail.jsx'
import EditableText from './EditableText.jsx'
import { MONTHS, sumMonths } from '../lib/model.js'
import { categoriesOf, itemsOf, categoryMonths, kindMonths, variance } from '../lib/summary.js'
import { moneyShort, signed } from '../lib/format.js'

/**
 * The 12-month grid for one side of the budget (expenses or income).
 *
 * `layer` selects which set of numbers is editable: the plan, or what actually
 * happened. Showing one layer at a time keeps the table 12 columns wide rather
 * than 24 — on a phone, a 24-column grid is unusable.
 *
 * The 'variance' layer is read-only: it is derived, so there is nothing to
 * type into it.
 */
export default function BudgetGrid({ data, kind, layer, actions, collapsed, onToggleCategory, inspectMode, onInspectMode }) {
  const cats = useMemo(() => categoriesOf(data, kind), [data, kind])
  // { item, category, month } while a figure is opened up.
  const [detail, setDetail] = useState(null)
  const readOnly = layer === 'variance'

  const totals = useMemo(() => {
    if (layer === 'variance') {
      return variance(kindMonths(data, kind, 'planned'), kindMonths(data, kind, 'actual'), kind)
    }
    return kindMonths(data, kind, layer)
  }, [data, kind, layer])

  /** Move focus after Enter/Tab. Cells are addressed by `itemId:index`. */
  const navigate = (itemId, index, direction) => {
    const flat = cats.flatMap((c) => (collapsed[c.id] ? [] : itemsOf(data, c.id)))
    const rowIndex = flat.findIndex((it) => it.id === itemId)
    if (rowIndex < 0) return
    let nextRow = rowIndex
    let nextCol = index
    if (direction === 'down') nextRow = Math.min(rowIndex + 1, flat.length - 1)
    if (direction === 'right') nextCol = Math.min(index + 1, 11)
    if (direction === 'left') nextCol = Math.max(index - 1, 0)
    const target = document.querySelector(`[data-cell="${flat[nextRow]?.id}:${nextCol}"]`)
    if (target) { target.focus(); target.click() }
  }

  const rowValues = (item) =>
    layer === 'variance'
      ? variance(item.planned, item.actual, kind)
      : item[layer]

  if (!cats.length) {
    return (
      <div className="empty-state">
        No {kind === 'income' ? 'income' : 'expense'} categories yet.
        <div style={{ marginTop: 10 }}>
          <button className="primary" onClick={() => actions.addCategory(kind)}>Add a category</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="name">{kind === 'income' ? 'Income' : 'Expense'}</th>
              {MONTHS.map((m) => <th key={m} className="month">{m}</th>)}
              <th className="derived">Total</th>
              <th className="derived">Avg</th>
              <th />
            </tr>
          </thead>

          {cats.map((cat) => {
            const items = itemsOf(data, cat.id)
            const catMonths =
              layer === 'variance'
                ? variance(categoryMonths(data, cat.id, 'planned'), categoryMonths(data, cat.id, 'actual'), kind)
                : categoryMonths(data, cat.id, layer)
            const catTotal = sumMonths(catMonths)
            const isCollapsed = collapsed[cat.id]

            return (
              <tbody key={cat.id}>
                <tr className="cat-row">
                  <th className="name" scope="rowgroup">
                    <button
                      className="link"
                      style={{ color: 'inherit', textDecoration: 'none', paddingLeft: 0 }}
                      aria-expanded={!isCollapsed}
                      onClick={() => onToggleCategory(cat.id)}
                      title={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <EditableText
                      value={cat.name}
                      placeholder="Category"
                      ariaLabel={`Category name, ${cat.name}`}
                      onCommit={(v) => actions.renameCategory(cat.id, v)}
                    />
                    <span className="cat-actions">
                      <button title="Add line item" onClick={() => actions.addItem(cat.id)}>+ item</button>
                      <button className="danger" title="Delete category" onClick={() => actions.deleteCategory(cat.id)}>×</button>
                    </span>
                  </th>
                  {catMonths.map((v, i) => (
                    <td key={i} className={`month ${varianceClass(layer, v)}`}>
                      {layer === 'variance' ? signed(v) : moneyShort(v)}
                    </td>
                  ))}
                  <td className="derived">{layer === 'variance' ? signed(catTotal) : moneyShort(catTotal)}</td>
                  <td className="derived">{moneyShort(catTotal / 12)}</td>
                  <td />
                </tr>

                {!isCollapsed && items.map((item) => {
                  const values = rowValues(item)
                  const total = sumMonths(values)
                  return (
                    <tr key={item.id}>
                      <td className="name">
                        <EditableText
                          value={item.name}
                          placeholder="Line item"
                          ariaLabel={`Line item name, ${item.name}`}
                          onCommit={(v) => actions.renameItem(item.id, v)}
                        />
                      </td>
                      {values.map((v, i) => (
                        <td key={i} className={`month ${varianceClass(layer, v)}`}>
                          {readOnly ? (
                            <span className="cell-btn">{signed(v)}</span>
                          ) : (
                            <MonthCell
                              value={v}
                              cellKey={`${item.id}:${i}`}
                              label={`${item.name}, ${MONTHS[i]}, ${layer}`}
                              onCommit={(val) => actions.setCell(item.id, layer, i, val)}
                              onNavigate={(dir) => navigate(item.id, i, dir)}
                              inspectMode={inspectMode}
                              onInspect={
                                // In inspect mode every actual cell opens, including
                                // empty ones — that is where a hand-entered month
                                // starts. Outside it, only cells with something to
                                // show carry the alt-click affordance.
                                layer === 'actual' && (inspectMode || hasDetail(data, item.id, i))
                                  ? () => setDetail({ item, category: cat, month: i })
                                  : undefined
                              }
                            />
                          )}
                        </td>
                      ))}
                      <td className="derived">{layer === 'variance' ? signed(total) : moneyShort(total)}</td>
                      <td className="derived">{moneyShort(total / 12)}</td>
                      <td className="cat-actions">
                        {!readOnly && (
                          <button
                            title={`Copy ${MONTHS[0]} across all 12 months`}
                            onClick={() => actions.fillRow(item.id, layer, values[0])}
                          >
                            fill →
                          </button>
                        )}
                        <button className="danger" title="Delete line item" onClick={() => actions.deleteItem(item.id)}>×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            )
          })}

          <tbody>
            <tr className="total-row">
              <th className="name">Total {kind === 'income' ? 'income' : 'expenses'}</th>
              {totals.map((v, i) => (
                <td key={i} className={`month ${varianceClass(layer, v)}`}>
                  {layer === 'variance' ? signed(v) : moneyShort(v)}
                </td>
              ))}
              <td className="derived">
                {layer === 'variance' ? signed(sumMonths(totals)) : moneyShort(sumMonths(totals))}
              </td>
              <td className="derived">{moneyShort(sumMonths(totals) / 12)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => actions.addCategory(kind)}>+ Add category</button>
      </div>

      {detail && (
        <CellDetail
          data={data}
          item={data.items.find((i) => i.id === detail.item.id) || detail.item}
          category={detail.category}
          month={detail.month}
          onClose={() => setDetail(null)}
          onAdd={(entry) => actions.addTransaction({ ...entry, itemId: detail.item.id })}
          onRemove={(id) => actions.removeTransaction(id)}
        />
      )}

      {layer === 'variance' && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Variance is actual minus planned, signed so a positive number is always better than plan —
          {kind === 'income' ? ' earning more than budgeted.' : ' spending less than budgeted.'}
          {' '}Months with no actual entered count as zero.
        </p>
      )}
    </>
  )
}

/** Whether a figure has transactions recorded behind it, so it can be opened. */
const hasDetail = (data, itemId, month) =>
  (data.transactions || []).some((t) => t.itemId === itemId && t.month === month)

/** Colour is a hint only — the sign is always printed alongside it. */
function varianceClass(layer, v) {
  if (layer !== 'variance' || !v) return ''
  return v > 0 ? 'up' : 'down'
}
