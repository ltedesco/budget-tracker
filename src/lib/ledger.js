// Hand-entered transactions.
//
// Not every account exports a file worth parsing — a bank that only offers PDF
// statements leaves typing as the only route in. The point of doing it here
// rather than by overwriting the monthly figure is that a figure built from
// entries can be checked, corrected one line at a time, and still add up.
//
// A hand-entered transaction is simply another source alongside the cards, so
// it survives a card re-import untouched and the month's figure is the sum of
// what every source contributed.

import { newId, nowISO, toCell } from './model.js'

export const MANUAL_SOURCE = 'manual'

const round2 = (n) => Math.round(n * 100) / 100

/** Every transaction sitting behind one month of one line item. */
export const transactionsFor = (data, itemId, month) =>
  (data.transactions || []).filter((t) => t.itemId === itemId && t.month === month)

export const isManual = (t) => t.source === MANUAL_SOURCE

/**
 * Recompute one cell from its per-source shares.
 *
 * Hand-entered money is summed from the ledger; every other source keeps the
 * share its import recorded. Doing it this way means adding an entry takes a
 * cell that had been typed over back under the ledger's control, which is the
 * behaviour that makes a typo recoverable.
 */
export function recomputeCell(data, itemId, month, at = nowISO()) {
  const manualTotal = round2(
    transactionsFor(data, itemId, month).filter(isManual).reduce((a, t) => a + t.amount, 0),
  )

  return {
    ...data,
    items: data.items.map((item) => {
      if (item.id !== itemId) return item

      const shares = { ...(item.imported?.[String(month)] || {}) }
      if (manualTotal) shares[MANUAL_SOURCE] = manualTotal
      else delete shares[MANUAL_SOURCE]

      const actual = [...(item.actual || Array(12).fill(null))]
      actual[month] = Object.keys(shares).length
        ? round2(Object.values(shares).reduce((a, v) => a + v, 0))
        : null

      const imported = { ...(item.imported || {}) }
      if (Object.keys(shares).length) imported[String(month)] = shares
      else delete imported[String(month)]

      return {
        ...item,
        actual,
        imported,
        fieldsAt: { ...item.fieldsAt, [`actual.${month}`]: at },
        updatedAt: at,
      }
    }),
  }
}

/** Month index from an ISO date, or null when it is not readable. */
export function monthOfISO(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const month = Number(m[2]) - 1
  return month >= 0 && month <= 11 ? month : null
}

/**
 * Add a hand-entered transaction. Returns { data, error } — the date has to
 * fall inside the budget year and the amount has to be a number, and saying
 * why is more use than silently dropping the entry.
 */
export function addTransaction(data, { itemId, date, amount, desc }, at = nowISO()) {
  const item = data.items.find((i) => i.id === itemId)
  if (!item) return { data, error: 'That line item no longer exists.' }

  const iso = String(date || '').trim()
  const month = monthOfISO(iso)
  if (month === null) return { data, error: 'Enter a date as YYYY-MM-DD.' }
  if (Number(iso.slice(0, 4)) !== Number(data.year)) {
    return { data, error: `That date is not in ${data.year}.` }
  }

  const value = toCell(amount)
  if (value === null) return { data, error: 'Enter an amount.' }

  const transaction = {
    id: `m${newId()}`,
    source: MANUAL_SOURCE,
    date: iso,
    month,
    amount: value,
    desc: String(desc || '').trim().slice(0, 120) || 'Manual entry',
    cardCategory: '',
    itemId,
  }

  const withRow = { ...data, transactions: [...(data.transactions || []), transaction] }
  return { data: recomputeCell(withRow, itemId, month, at), error: '', transaction }
}

/** Remove a hand-entered transaction and recompute the month it belonged to. */
export function removeTransaction(data, id, at = nowISO()) {
  const target = (data.transactions || []).find((t) => t.id === id)
  if (!target) return data
  const without = { ...data, transactions: data.transactions.filter((t) => t.id !== id) }
  return recomputeCell(without, target.itemId, target.month, at)
}
