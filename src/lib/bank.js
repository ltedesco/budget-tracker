// Bank-account import.
//
// A current account is not a card statement, and treating it like one is the
// fastest way to a confidently wrong budget. Three differences drive
// everything here:
//
//  1. Most of what leaves a current account is not spending. Payments to the
//     credit cards are the largest debits in a typical month, and every one of
//     them is already itemised by the card import — counting them again would
//     double the whole card spend. Transfers to savings and to a brokerage are
//     not spending either; that money is still yours.
//  2. There is no category column. A card hands over its own classification,
//     which the card rules lean on heavily. A bank hands over a description and
//     a transfer type like ACH_DEBIT, so every decision rests on the payee text.
//  3. Money arrives as well as leaves, and some of it is already in the budget
//     because it was typed in by hand.
//
// So this module classifies before it sums, and reports every bucket. What is
// excluded is named and totalled rather than quietly dropped.

import { MONTHS } from './model.js'
import { parseAmount, toISODate, toMatrix, findHeaderRow, detectColumns, transactionId } from './statement.js'

export const BANK_SOURCE = 'bank'
// Matches the ledger's own name for a hand-typed entry.
const MANUAL = 'manual'
export const CATCH_ALL_ITEM = 'Unassigned bank spend'
export const CATCH_ALL_CATEGORY = 'Other'

const round2 = (n) => Math.round(n * 100) / 100

// How far a day's hand-entered parts may sit from the deposit and still be
// taken as the same money. Hand-typed figures are rounded and transposed; an
// exact-only test would re-import a deposit already recorded to the cent-ish.
const SPLIT_TOLERANCE = 0.01 // 1%

// --- what is never budget spending ------------------------------------------
//
// Each exclusion carries the reason it exists, because the preview shows them.
// A number removed without a reason is indistinguishable from a bug.

export const EXCLUSIONS = [
  {
    key: 'card',
    label: 'Credit-card payment',
    why: 'the card statement already itemises this spending — counting the payment too would double it',
    test: /amex|american express|capital one|discover|cardmember|barclay|synchrony|citi\s*(card|autopay)|chase\s*card|card ending in|\bcc pymt\b|e-payment/i,
  },
  {
    key: 'transfer',
    label: 'Transfer between your own accounts',
    why: 'moving money is not spending it',
    test: /online transfer|to (checking|sav\b|savings)|partnerfi|\bxfer\b/i,
  },
  {
    key: 'brokerage',
    label: 'Brokerage / investment transfer',
    why: 'money moved to an investment account is still yours',
    test: /robinhood|\brhs\b|brokerage|coinbase|\bschwab\b|fidelity|vanguard/i,
  },
  {
    key: 'person',
    label: 'Person-to-person payment',
    why: 'Zelle and Venmo can be anything; the budget cannot tell what without you saying',
    test: /zelle|venmo|quickpay/i,
  },
]

/** Which exclusion a description falls under, or null to keep it. */
export function excludedBy(description) {
  const text = String(description || '')
  return EXCLUSIONS.find((e) => e.test.test(text)) || null
}

// --- rules -------------------------------------------------------------------
//
// Payee text only, since a bank offers nothing else. Deliberately narrow: these
// name a specific biller each. A loose pattern here moves money between budget
// lines without ever failing, which is worse than leaving a row unassigned —
// unassigned is visible, wrong is not.

export const TARGET_SEPARATOR = '::'

/**
 * The only rules that ship with the app.
 *
 * Three, and each aims at a line the starter template actually creates. A rule
 * naming one of YOUR billers or line items lives in the document instead: this
 * repository is public, and which lender holds your loan, where your second
 * home is, and whose college fund the 529 feeds are not facts about budgeting
 * software. A rule that matches nothing simply does not fire, so shipping these
 * costs a budget that renamed its lines nothing.
 */
export const DEFAULT_RULES = [
  { match: 'payroll|direct\\s*dep', target: 'Wages::Paycheck 1' },
  { match: 'irs\\s+treas|tax\\s*ref|taxrfd', target: 'Other::Refunds' },
  { match: 'studntloan|student\\s*loan', target: 'Debt::Student loans' },
]

/** Compile the document's rules over the defaults. Later entries win. */
export function rulesFor(data) {
  const all = [...DEFAULT_RULES, ...((data && data.bankRules) || [])]
  return all
    .map((r) => {
      try {
        return { source: r.match, target: r.target, re: new RegExp(r.match, 'i') }
      } catch {
        // A rule someone mistyped must not take the whole import down with it.
        return null
      }
    })
    .filter(Boolean)
}

/**
 * Resolve a "Category::Item" spec against any line, income or expense.
 *
 * The card path only ever writes to expense lines, so its resolver looks no
 * further. A bank feed carries wages, so this one has to see both sides or
 * every credit lands unassigned.
 */
export function resolveBankTarget(data, spec) {
  const norm = (v) => String(v || '').trim().toLowerCase()
  const catName = new Map(data.categories.map((c) => [c.id, norm(c.name)]))
  const idx = String(spec || '').indexOf(TARGET_SEPARATOR)
  if (idx < 0) return null
  const wantCat = norm(spec.slice(0, idx))
  const wantItem = norm(spec.slice(idx + TARGET_SEPARATOR.length))
  const hit = data.items.find(
    (i) => norm(i.name) === wantItem && catName.get(i.categoryId) === wantCat,
  )
  return hit ? hit.id : null
}

export function matchBankRule(description, rules) {
  const text = String(description || '')
  // Last match wins, so a rule you add beats a default it overlaps with.
  let hit = null
  for (const r of rules || []) if (r.re.test(text)) hit = r.target
  return hit
}

// --- parsing -----------------------------------------------------------------

/**
 * Read a bank export into signed rows.
 *
 * The sign is the whole classification: a bank writes one Amount column where
 * negative is money out and positive is money in, unlike a card where every
 * row is spending unless it says otherwise.
 */
export function parseBank(input) {
  let matrix
  try {
    matrix = toMatrix(input)
  } catch (e) {
    return { rows: [], error: e.message, warnings: [] }
  }
  const headerRow = findHeaderRow(matrix)
  if (headerRow === -1) {
    return {
      rows: [],
      error: 'Could not find a header row naming a date and an amount. Export the account activity as CSV with its column titles.',
      warnings: [],
    }
  }
  const fields = (matrix[headerRow] || []).map((c) => String(c ?? '').trim())
  const cols = detectColumns(fields)
  const at = (cells, name) => (name ? cells[fields.indexOf(name)] : undefined)

  const rows = []
  let unreadable = 0
  for (let i = headerRow + 1; i < matrix.length; i++) {
    const cells = matrix[i] || []
    if (!cells.some((c) => String(c ?? '').trim())) continue
    const iso = toISODate(at(cells, cols.date))
    const amount = parseAmount(at(cells, cols.amount))
    if (!iso || !Number.isFinite(amount) || amount === 0) { unreadable += 1; continue }
    rows.push({
      iso,
      year: Number(iso.slice(0, 4)),
      month: Number(iso.slice(5, 7)) - 1,
      amount: round2(amount),
      desc: String(at(cells, cols.description) ?? '').replace(/\s+/g, ' ').trim(),
      // Chase's "Type" is a transfer mechanism (ACH_DEBIT), not a spending
      // category. Kept for the ledger, never used to classify.
      type: String(at(cells, cols.category) ?? '').trim(),
    })
  }
  const warnings = []
  if (unreadable) warnings.push(`${unreadable} row${unreadable === 1 ? '' : 's'} had no readable date or amount and were skipped.`)
  return { rows, error: '', warnings }
}

// --- summarising -------------------------------------------------------------

/** A row already accounted for elsewhere in the budget, matched on date and amount. */
const dupeKey = (iso, amount) => `${iso}|${Math.abs(amount).toFixed(2)}`

/**
 * Fold bank rows into per-line-item monthly totals.
 *
 * `existing` is the budget's transactions. Anything recorded from another
 * source on the same day for the same amount is treated as already in the
 * budget and skipped — that is what stops a hand-typed paycheck being counted
 * twice when the bank feed brings the same deposit in.
 */
export function summariseBank(rows, data, { year, existing = [], source = BANK_SOURCE, resolve } = {}) {
  const rules = rulesFor(data)
  const already = new Map()
  // Hand-typed entries only, grouped by day. One deposit is often entered as
  // two lines — a paycheck split into base and bonus — so an exact amount match
  // alone would miss it and import the whole deposit again on top.
  //
  // Deliberately not every transaction on the day: a card import can put a
  // dozen purchases on one date, and summing those would let an unrelated
  // afternoon's shopping look like it accounted for a deposit. The split case
  // exists because a person typed one payment as two rows, so it is that
  // person's rows that are worth adding up.
  const byDate = new Map()
  for (const t of existing) {
    if (t.source === source) continue // our own previous import; applySummary replaces it
    already.set(dupeKey(t.date, t.amount), t)
    if (t.source !== MANUAL) continue
    const day = byDate.get(t.date) || []
    day.push(t)
    byDate.set(t.date, day)
  }

  const cells = new Map()
  const transactions = []
  const seen = new Map()
  const report = {
    excluded: EXCLUSIONS.map((e) => ({ ...e, rows: 0, amount: 0 })),
    duplicates: { rows: 0, amount: 0, samples: [] },
    splits: { rows: 0, amount: 0, samples: [] },
    wrongYear: { rows: 0, amount: 0 },
    income: { rows: 0, amount: 0 },
    spending: { rows: 0, amount: 0 },
    unassigned: { rows: 0, amount: 0 },
    assigned: { rows: 0, amount: 0 },
  }
  const add = (bucket, amount) => { bucket.rows += 1; bucket.amount = round2(bucket.amount + Math.abs(amount)) }

  for (const row of rows) {
    if (row.year !== Number(year)) { add(report.wrongYear, row.amount); continue }

    const exclusion = excludedBy(row.desc)
    if (exclusion) {
      add(report.excluded.find((e) => e.key === exclusion.key), row.amount)
      continue
    }

    const key = dupeKey(row.iso, row.amount)
    if (already.has(key)) {
      add(report.duplicates, row.amount)
      if (report.duplicates.samples.length < 6) {
        report.duplicates.samples.push({ ...row, matched: already.get(key).desc })
      }
      continue
    }

    // No single entry matches, but the day's entries may add up to it. Reported
    // separately and never merged into the exact matches: this one is a
    // judgement, and a judgement shown is a judgement that can be overruled.
    const sameDay = byDate.get(row.iso) || []
    if (sameDay.length > 1) {
      const daySum = sameDay.reduce((a, t) => a + Math.abs(t.amount), 0)
      const target = Math.abs(row.amount)
      if (Math.abs(daySum - target) <= Math.max(1, target * SPLIT_TOLERANCE)) {
        add(report.splits, row.amount)
        if (report.splits.samples.length < 6) {
          report.splits.samples.push({
            ...row,
            parts: sameDay.map((t) => ({ desc: t.desc, amount: t.amount })),
            partsTotal: round2(daySum),
          })
        }
        continue
      }
    }

    const income = row.amount > 0
    add(income ? report.income : report.spending, row.amount)

    const spec = matchBankRule(row.desc, rules)
    const itemId = spec && resolve ? resolve(spec) : null
    if (!itemId) { add(report.unassigned, row.amount); continue }
    add(report.assigned, row.amount)

    const value = Math.abs(row.amount)
    const cellKey = `${itemId}:${row.month}`
    cells.set(cellKey, round2((cells.get(cellKey) || 0) + value))

    const occurrence = (seen.get(`${row.iso}|${value}|${row.desc}`) || 0) + 1
    seen.set(`${row.iso}|${value}|${row.desc}`, occurrence)
    transactions.push({
      id: transactionId(source, row.iso, value, row.desc, occurrence),
      itemId,
      date: row.iso,
      month: row.month,
      amount: value,
      desc: row.desc.slice(0, 120),
      cardCategory: row.type,
    })
  }

  return {
    cells,
    transactions,
    coveredMonths: MONTHS.map((_, i) => i),
    report,
  }
}

// --- the rule list as text ---------------------------------------------------
//
// One rule per line, `pattern => Category::Item`. A textarea rather than a
// row-by-row builder because the list is short, reads well as text, and pastes
// between devices.

export function rulesToText(rules) {
  return (rules || []).map((r) => `${r.match} => ${r.target}`).join('\n')
}

export function rulesFromText(text) {
  const rules = []
  const errors = []
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const at = line.indexOf('=>')
    if (at < 0) { errors.push(`Line ${i + 1}: expected "pattern => Category::Item".`); return }
    const match = line.slice(0, at).trim()
    const target = line.slice(at + 2).trim()
    if (!match) { errors.push(`Line ${i + 1}: no pattern before "=>".`); return }
    if (!target.includes(TARGET_SEPARATOR)) {
      errors.push(`Line ${i + 1}: "${target}" needs to name a category and a line, as Category::Item.`)
      return
    }
    try { new RegExp(match, 'i') } catch { errors.push(`Line ${i + 1}: "${match}" is not a valid pattern.`); return }
    rules.push({ match, target })
  })
  return { rules, errors }
}
