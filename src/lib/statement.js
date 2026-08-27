// Card-statement import.
//
// Turns an Amex CSV export into monthly totals on the `actual` layer, so the
// budget can be read as "where is spending actually landing against plan".
//
// Scope is deliberately narrow: it maps the card's OWN category field onto
// budget line items and sums by month. No merchant rules, no learning, no
// per-transaction ledger. Anything it cannot place with confidence is reported
// as unmatched rather than guessed at — a wrong category is worse than a
// visible gap, because it silently moves money between budget lines.

import Papa from 'papaparse'
import { MONTHS } from './model.js'
import { readWorkbook, serialToISO } from './xlsx.js'

// --- column detection -------------------------------------------------------
//
// Amex has shipped several CSV shapes over the years, and the "include all
// additional details" toggle changes the column set. Rather than pin one
// layout, find each field by matching the header text.

const HEADER_PATTERNS = {
  date: [/^date$/i, /transaction date/i, /^posted date/i],
  description: [/^description$/i, /^merchant/i, /appears on your statement as/i, /extended details/i],
  amount: [/^amount$/i, /^debit/i],
  category: [/^category$/i, /^type$/i],
  reference: [/^reference$/i, /^transaction id/i],
}

/**
 * Locate the header row in a matrix.
 *
 * Real exports do not start with the header. An Amex workbook opens with six
 * rows of preamble — the card name, who it is prepared for, the account
 * number — before the column titles appear. Assuming row 1 is why a genuine
 * export was rejected while a hand-made test file parsed cleanly, so the row
 * is found by looking for one that names both a date and an amount.
 */
export function findHeaderRow(matrix) {
  const limit = Math.min(matrix.length, 40)
  for (let i = 0; i < limit; i++) {
    const cells = (matrix[i] || []).map((c) => String(c ?? '').trim())
    if (!cells.some(Boolean)) continue
    const hasDate = cells.some((c) => HEADER_PATTERNS.date.some((p) => p.test(c)))
    const hasAmount = cells.some((c) => HEADER_PATTERNS.amount.some((p) => p.test(c)))
    if (hasDate && hasAmount) return i
  }
  return -1
}

function findColumn(fields, patterns) {
  for (const pattern of patterns) {
    const hit = fields.find((f) => pattern.test(String(f || '').trim()))
    if (hit) return hit
  }
  return null
}

/** A statement with no usable header row is rejected rather than guessed at. */
export function detectColumns(fields = []) {
  const found = {}
  for (const [key, patterns] of Object.entries(HEADER_PATTERNS)) {
    found[key] = findColumn(fields, patterns)
  }
  return found
}

// --- value parsing ----------------------------------------------------------

/** Amex US writes MM/DD/YYYY; ISO is accepted too. Returns [year, monthIndex]. */
export function parseStatementDate(raw) {
  const s = String(raw || '').trim()
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (us) {
    const [, mm, , yy] = us
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm) - 1
    if (month >= 0 && month <= 11) return [year, month]
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const month = Number(iso[2]) - 1
    if (month >= 0 && month <= 11) return [Number(iso[1]), month]
  }
  return [null, null]
}

/** "$1,234.56", "(45.00)" and "-45.00" all mean what they look like. */
export function parseAmount(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return NaN
  const negated = /^\(.*\)$/.test(s)
  const n = parseFloat(s.replace(/[$,\s()]/g, ''))
  if (!Number.isFinite(n)) return NaN
  return negated ? -n : n
}

// A payment to the card is a transfer, not spending. Counting it would double
// every dollar: once as the purchase, once as paying for the purchase.
const PAYMENT_PATTERNS = [
  /payment\s*[-–]?\s*thank\s*you/i,
  /\bautopay\b/i,
  /online\s+payment/i,
  /\bpayment\s+received\b/i,
  /\bthank\s+you\b/i,
  /mobile\s+payment/i,
]

export const isCardPayment = (description) =>
  PAYMENT_PATTERNS.some((p) => p.test(String(description || '')))

// --- category mapping -------------------------------------------------------
//
// Matched against the card's category, lowercased, first hit wins. The target
// is a line-item NAME, resolved against the budget's own items — so renaming a
// line item in the app is all it takes to re-point a rule.
//
// Kept short on purpose. Every rule here is one I would defend as unambiguous;
// everything else belongs in the unmatched list where it can be seen.

export const CATEGORY_RULES = [
  [/groceries|supermarket|wholesale\s*stores?/, 'Groceries'],
  [/restaurant|bar\s*&\s*caf|fast\s*food|dining/, 'Restaurants'],
  [/fuel|gas\s*station|service\s*station/, 'Fuel'],
  [/airline|air\s*travel/, 'Airfare'],
  [/lodging|hotel/, 'Hotels'],
  [/clothing|apparel/, 'Clothes'],
  [/pharmac|drug\s*stores?/, 'Personal supplies'],
  [/general\s*retail|merchandise\s*&\s*supplies-general/, 'Personal supplies'],
]

/** The line-item name a card category maps to, or null when unmatched. */
export function targetForCategory(category) {
  const c = String(category || '').toLowerCase()
  if (!c) return null
  for (const [pattern, target] of CATEGORY_RULES) {
    if (pattern.test(c)) return target
  }
  return null
}

// --- parse ------------------------------------------------------------------

/**
 * Parse a statement into normalised rows. Returns { rows, error, warnings }.
 * Rows carry everything the caller needs to explain itself in the preview.
 */
/**
 * Parse a statement into normalised rows. Accepts CSV text or the bytes of an
 * .xlsx workbook — the card's own download, with no conversion step.
 *
 * Returns { rows, error, warnings }. Rows carry everything the caller needs to
 * explain itself in the preview.
 */
export function parseStatement(input) {
  let matrix
  try {
    matrix = toMatrix(input)
  } catch (e) {
    return { rows: [], error: e.message, warnings: [], columns: {} }
  }

  const headerRow = findHeaderRow(matrix)
  if (headerRow === -1) {
    return {
      rows: [],
      error:
        'Could not find a header row with a date and an amount. Export from Amex as ' +
        'Excel or CSV with "include all additional details" ticked, and keep the ' +
        'column titles in the file.',
      warnings: [],
      columns: {},
    }
  }

  const fields = (matrix[headerRow] || []).map((c) => String(c ?? '').trim())
  const cols = detectColumns(fields)
  const index = {}
  for (const [key, name] of Object.entries(cols)) {
    index[key] = name ? fields.indexOf(name) : -1
  }

  const warnings = []
  if (headerRow > 0) {
    warnings.push(`Skipped ${headerRow} row${headerRow === 1 ? '' : 's'} of header information above the column titles.`)
  }
  if (index.category === -1) {
    warnings.push(
      'No category column found, so everything will be recorded as unassigned. ' +
        'Re-export with "include all additional details" ticked.',
    )
  }

  const rows = []
  for (let i = headerRow + 1; i < matrix.length; i++) {
    const cells = matrix[i] || []
    const at = (k) => (index[k] >= 0 ? cells[index[k]] : undefined)

    const [year, month] = parseCellDate(at('date'))
    const amount = parseAmount(at('amount'))
    if (year === null || !Number.isFinite(amount)) continue

    const description = String(at('description') ?? '').trim()
    const category = String(at('category') ?? '').trim()

    rows.push({
      year,
      month,
      amount,
      description,
      category,
      target: targetForCategory(category),
      payment: isCardPayment(description),
    })
  }

  return { rows, error: '', warnings, columns: cols, headerRow }
}

/** CSV text or workbook bytes, both to the same matrix shape. */
function toMatrix(input) {
  if (typeof input === 'string') {
    const parsed = Papa.parse(input.replace(/^\uFEFF/, '').trim(), {
      header: false,
      skipEmptyLines: false,
    })
    return parsed.data
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const buffer = input instanceof ArrayBuffer ? input : input.buffer
    return readWorkbook(buffer)
  }
  throw new Error('Unsupported file. Give it a .csv or .xlsx export.')
}

/** A cell may hold a date string or an Excel serial number. */
function parseCellDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const iso = serialToISO(value)
    return iso ? parseStatementDate(iso) : [null, null]
  }
  return parseStatementDate(value)
}

// --- aggregate --------------------------------------------------------------

const norm = (s) => String(s || '').trim().toLowerCase()

// Where card spending goes when no confident category mapping exists.
//
// The alternative — dropping it — is what makes an import dangerous: actual
// totals come out lower than reality and the budget reads as an underspend.
// A visible bucket keeps the invariant that matters: every dollar charged to
// the card appears somewhere in the actual column.
export const CATCH_ALL_ITEM = 'Unassigned card spend'
export const CATCH_ALL_CATEGORY = 'Other'

/**
 * Fold rows into per-line-item monthly totals for one budget year.
 *
 * Returns everything the preview needs to be honest about what it is doing:
 * what will be written, what was skipped and why, and how much money each
 * bucket accounts for. The totals must reconcile — assigned + unmatched +
 * payments + wrongYear should equal the statement.
 */
export function summarise(rows, data, { catchAll = true } = {}) {
  const byName = new Map()
  for (const item of data.items) {
    const cat = data.categories.find((c) => c.id === item.categoryId)
    if (cat?.kind === 'expense') byName.set(norm(item.name), item)
  }

  const cells = new Map() // `${itemId}:${month}` -> total
  const unmatched = new Map() // category -> { total, count }
  const missingItem = new Map() // target name -> { total, count }
  let payments = 0
  let wrongYear = 0
  let assigned = 0
  let swept = 0

  for (const row of rows) {
    if (row.payment || row.amount < 0) {
      // Negative amounts are credits and refunds. Netting them into a category
      // is right; treating them as spending is not.
      if (row.payment) { payments += row.amount; continue }
    }
    if (row.year !== data.year) { wrongYear += row.amount; continue }

    // Unmatched rows are still reported by category — knowing WHAT is
    // unassigned is how the mapping gets improved — but the money itself is
    // swept into the catch-all rather than dropped.
    if (!row.target) {
      const key = row.category || '(no category)'
      const prev = unmatched.get(key) || { total: 0, count: 0 }
      unmatched.set(key, { total: prev.total + row.amount, count: prev.count + 1 })
      if (!catchAll) continue
    }

    const targetName = row.target || CATCH_ALL_ITEM
    const item = byName.get(norm(targetName))
    if (!item) {
      const prev = missingItem.get(targetName) || { total: 0, count: 0 }
      missingItem.set(targetName, { total: prev.total + row.amount, count: prev.count + 1 })
      if (!row.target) unmatched.delete(row.category || '(no category)')
      continue
    }

    const key = `${item.id}:${row.month}`
    cells.set(key, round2((cells.get(key) || 0) + row.amount))
    assigned += row.amount
    if (!row.target) swept += row.amount
  }

  const months = [...new Set([...cells.keys()].map((k) => Number(k.split(':')[1])))].sort((a, b) => a - b)

  return {
    cells,
    months,
    monthLabels: months.map((m) => MONTHS[m]),
    unmatched: [...unmatched.entries()]
      .map(([category, v]) => ({ category, ...v, total: round2(v.total) }))
      .sort((a, b) => b.total - a.total),
    missingItem: [...missingItem.entries()]
      .map(([name, v]) => ({ name, ...v, total: round2(v.total) }))
      .sort((a, b) => b.total - a.total),
    // `swept` is a subset of `assigned`, not a bucket beside it: it says how
    // much of what will be recorded landed in the catch-all rather than a real
    // category. Reconciliation is assigned + payments + wrongYear + missingItem
    // (+ unmatched only when sweeping is off).
    catchAll,
    totals: {
      assigned: round2(assigned),
      payments: round2(payments),
      wrongYear: round2(wrongYear),
      swept: round2(swept),
      unmatched: round2([...unmatched.values()].reduce((a, v) => a + v.total, 0)),
      missingItem: round2([...missingItem.values()].reduce((a, v) => a + v.total, 0)),
    },
    rowCount: rows.length,
  }
}

const round2 = (n) => Math.round(n * 100) / 100

/** Per-line-item rows for the preview table, largest first. */
export function previewRows(summary, data) {
  const byItem = new Map()
  for (const [key, total] of summary.cells) {
    const [itemId, month] = key.split(':')
    const entry = byItem.get(itemId) || { months: {}, total: 0 }
    entry.months[Number(month)] = total
    entry.total = round2(entry.total + total)
    byItem.set(itemId, entry)
  }
  return [...byItem.entries()]
    .map(([itemId, entry]) => {
      const item = data.items.find((i) => i.id === itemId)
      const cat = data.categories.find((c) => c.id === item?.categoryId)
      return { itemId, name: item?.name || '(deleted)', category: cat?.name || '', ...entry }
    })
    .sort((a, b) => b.total - a.total)
}

/**
 * Apply the summary to the document.
 *
 * Semantics are REPLACE for the cells the statement covers, not add: importing
 * the same file twice must land on the same numbers rather than doubling them.
 * Cells the statement says nothing about are left alone, so a manual entry in
 * an untouched month survives.
 */
export function applySummary(data, summary, at) {
  const stamp = at || new Date().toISOString()
  const items = data.items.map((item) => {
    let next = item
    for (let month = 0; month < 12; month++) {
      const key = `${item.id}:${month}`
      if (!summary.cells.has(key)) continue
      const actual = [...(next.actual || Array(12).fill(null))]
      actual[month] = summary.cells.get(key)
      next = {
        ...next,
        actual,
        fieldsAt: { ...next.fieldsAt, [`actual.${month}`]: stamp },
        updatedAt: stamp,
      }
    }
    return next
  })
  return { ...data, items }
}

/**
 * Ensure the catch-all line item exists, creating its category if needed.
 * Returns the document unchanged when it is already there, so this is safe to
 * call before every import.
 */
export function ensureCatchAll(data, make, at) {
  const stamp = at || new Date().toISOString()
  const existing = data.items.find(
    (i) => norm(i.name) === norm(CATCH_ALL_ITEM) &&
      data.categories.find((c) => c.id === i.categoryId)?.kind === 'expense',
  )
  if (existing) return data

  let category = data.categories.find(
    (c) => c.kind === 'expense' && norm(c.name) === norm(CATCH_ALL_CATEGORY),
  )
  const categories = [...data.categories]
  if (!category) {
    category = make.category(
      { kind: 'expense', name: CATCH_ALL_CATEGORY, order: categories.length },
      stamp,
    )
    categories.push(category)
  }

  const order = data.items.filter((i) => i.categoryId === category.id).length
  const item = make.item({ categoryId: category.id, name: CATCH_ALL_ITEM, order }, stamp)
  return { ...data, categories, items: [...data.items, item] }
}
