import { useEffect, useRef, useState } from 'react'
import { cellText } from '../lib/format.js'

/**
 * One month cell. Renders as a button until clicked, then swaps to an input.
 *
 * The grid can hold several hundred rows x 12 months; mounting a live <input>
 * for every cell makes typing visibly laggy on a phone. Only the cell being
 * edited is ever an input.
 *
 * Enter commits and moves down, Tab commits and moves right, Escape cancels.
 * Navigation is by `data-cell` lookup rather than a ref for every cell, which
 * keeps the grid from holding hundreds of refs it would otherwise never use.
 */
export default function MonthCell({ value, onCommit, label, cellKey, onNavigate }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef(null)

  const asText = value === null || value === undefined ? '' : String(value)

  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  const commit = (move) => {
    setEditing(false)
    if (draft !== asText) onCommit(draft)
    if (move) onNavigate?.(move)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        className="cell-input"
        inputMode="decimal"
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit('down') }
          else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'left' : 'right') }
          else if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  const blank = asText === ''
  return (
    <button
      type="button"
      data-cell={cellKey}
      className={`cell-btn${blank ? ' blank' : ''}`}
      aria-label={label}
      onClick={() => { setDraft(asText); setEditing(true) }}
    >
      {blank ? '–' : cellText(value)}
    </button>
  )
}
