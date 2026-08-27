import { useEffect, useId, useRef, useState } from 'react'
import { categoriesOf } from '../lib/summary.js'

/**
 * Which categories the chart is drawn from, as one dropdown.
 *
 * Not a native <select multiple>: adding a second option there needs a
 * modifier key, which an iPad does not have. This is a button that opens a
 * panel of checkboxes — one tap each, every option reachable, and seventeen
 * categories collapsed to a single control until you want them.
 *
 * An empty selection means everything, so the closed state reads "All
 * categories" and clearing is always the way back.
 */
export default function CategoryFilter({ data, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const panelId = useId()

  const chosen = new Set(selected)
  const groups = [
    ['Income', categoriesOf(data, 'income')],
    ['Expenses', categoriesOf(data, 'expense')],
  ].filter(([, cats]) => cats.length > 0)

  // Close on a click elsewhere or on Escape. Both listeners are only attached
  // while the panel is open, so a closed filter costs nothing.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!groups.length) return null

  const all = data.categories
  const names = all.filter((c) => chosen.has(c.id)).map((c) => c.name)
  // Two names fit; beyond that a count is easier to read than a truncated list.
  const summary =
    names.length === 0 || names.length === all.length ? 'All categories'
    : names.length <= 2 ? names.join(', ')
    : `${names.length} categories`

  const toggle = (id) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="cat-filter" ref={wrap}>
      <span className="tiny muted">Showing</span>
      {/* The button and its panel share a positioned wrapper, so the panel
          hangs off the button rather than off a hard-coded label width. */}
      <div className="cat-filter-menu">
        <button
          type="button"
          className="cat-filter-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span>{summary}</span>
          <span aria-hidden="true" className="cat-filter-caret">{open ? '▴' : '▾'}</span>
        </button>

        {open && (
        <div className="cat-filter-panel" id={panelId}>
          <div className="cat-filter-actions">
            <button type="button" className="link" onClick={() => onChange(all.map((c) => c.id))}>
              Select all
            </button>
            <button type="button" className="link" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          {groups.map(([label, cats]) => (
            <div key={label}>
              <div className="cat-filter-heading">{label}</div>
              {cats.map((c) => (
                <label className="cat-filter-row" key={c.id}>
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        )}
      </div>

      {chosen.size > 0 && (
        <button className="link" type="button" onClick={() => onChange([])}>Reset</button>
      )}
    </div>
  )
}
