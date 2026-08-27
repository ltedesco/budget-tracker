import { useEffect, useRef, useState } from 'react'

/** Click-to-edit text. Commits on blur or Enter, cancels on Escape. */
export default function EditableText({ value, placeholder = 'unnamed', onCommit, ariaLabel }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const ref = useRef(null)

  useEffect(() => { if (!editing) setDraft(value ?? '') }, [value, editing])
  useEffect(() => { if (editing) ref.current?.select() }, [editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== (value ?? '')) onCommit(next)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false) }
        }}
        style={{ padding: '2px 6px', fontSize: 13 }}
      />
    )
  }

  return (
    <span
      className={`editable${value ? '' : ' empty'}`}
      role="button"
      tabIndex={0}
      title="Click to rename"
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setEditing(true))}
    >
      {value || placeholder}
    </span>
  )
}
