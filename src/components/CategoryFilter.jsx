import { categoriesOf } from '../lib/summary.js'

/**
 * Which categories the chart is drawn from.
 *
 * Toggle chips rather than a <select multiple>: a native multi-select needs a
 * modifier key to add a second choice, which does not exist on an iPad, and
 * shows about four rows at a time out of seventeen. Chips are one tap each and
 * every option stays visible.
 *
 * An empty selection means everything, so the control opens showing the whole
 * budget and "Clear" is always a way back to it.
 */
export default function CategoryFilter({ data, selected, onChange }) {
  const chosen = new Set(selected)
  const groups = [
    ['Income', categoriesOf(data, 'income')],
    ['Expenses', categoriesOf(data, 'expense')],
  ].filter(([, cats]) => cats.length > 0)

  if (!groups.length) return null

  const toggle = (id) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="cat-filter">
      {groups.map(([label, cats]) => (
        <div className="cat-filter-group" key={label}>
          <span className="tiny muted cat-filter-label">{label}</span>
          <div className="filter-chips">
            {cats.map((c) => (
              <button
                key={c.id}
                type="button"
                className="filter-chip"
                aria-pressed={chosen.has(c.id)}
                onClick={() => toggle(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {chosen.size > 0 && (
        <button className="link" type="button" onClick={() => onChange([])}>
          Show all categories
        </button>
      )}
    </div>
  )
}
