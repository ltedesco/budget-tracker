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
  location: [/city\s*\/\s*state/i, /^city$/i, /^state$/i],
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

// --- rules -----------------------------------------------------------------
//
// A budget classifies by PURPOSE — what the money was for. A card classifies
// by MERCHANT TYPE — who was paid. Those are different axes that only
// correlate, which is why one Amex category can span several budget lines
// ("Other-Utilities" covers an electricity bill, a water bill and a second
// home's energy) and why one budget line draws from several card categories.
//
// So rules are tried most-specific first:
//
//   1. merchant   — the description names the payee, which is the strongest
//                   signal available and the only one that can split a single
//                   card category across budget lines
//   2. category   — the card's own label, good for the genuinely many-to-one
//                   cases like groceries or fuel
//   3. location   — where the budget keeps one line per property, the state
//                   the merchant sits in decides which one
//
// Anything left is sent to the catch-all. That residue is not a failure: for
// a marketplace charge the purpose genuinely is not in the file, and inventing
// a category for it would be worse than admitting the gap.
//
// Targets are written "Category::Item". The separator is not "/" because both
// category and item names here contain slashes ("Health/medical",
// "Internet/Cable (Surfside)"). Qualifying by category matters: five item
// names in this budget are duplicated across categories, so a bare name like
// "Supplies" could otherwise resolve to Home, Pets or Transportation at random.

export const TARGET_SEPARATOR = '::'

export const RULES = [
  // -- merchant ------------------------------------------------------------
  { merchant: /gofundme|red\s*cross|unicef/i, target: 'Gifts::Donations (charity)' },
  // Amex "Plan It" instalment fees: finance charges, not spending.
  { merchant: /^\s*plan\s+fee\b/i, target: 'Debt::Credit cards' },
  { merchant: /\bpseg\b|national\s*grid/i, target: 'Utilities::Electricity' },
  { merchant: /grand\s*strand\s*water/i, target: 'Utilities::Water ( Surfside)' },
  { merchant: /dominion\s*energy/i, target: 'Utilities::2nd home utilities' },
  { merchant: /suffolk\s*county\s*water/i, target: 'Utilities::Water (Sayville)' },
  { merchant: /state\s*farm|geico|allstate/i, target: 'Insurance::Sayville Car/Home Insurance' },
  // Amex files streaming under "Cable & Internet", but the budget treats it as
  // a subscription, not a utility.
  { merchant: /netflix|discovery\s*digital|paramount|hulu|disney\s*plus|max\.com/i,
    target: 'Technology::Netflix/Paramount/Discovery', override: true },
  { merchant: /openai|anthropic|chatgpt|claude\.ai|cursor|perplexity/i,
    target: 'Technology::Claude/GPT' },
  // "Lowe's" needs the exclusion: Lowe's Foods is a Carolinas grocery chain,
  // unrelated to the hardware store, and without it a merchant rule quietly
  // moved $240 of groceries onto Home Supplies. Merchant rules run ahead of
  // card categories by design — which is what lets Netflix beat Amex's "Cable
  // & Internet" label — so a loose one overrides a correct classification
  // rather than merely adding to it. Keep them narrow.
  { merchant: /home\s*depot|lowe'?s(?!\s*foods)|ace\s*hardware|shoreline\s*supply|staples|menards/i,
    target: 'Home::Supplies' },
  { merchant: /floor\s*and\s*decor|fourth\s*and\s*main|wayfair|ikea|pottery\s*barn/i,
    target: 'Home::Furnishings' },
  { merchant: /\bomny\b|\blirr\b|\bmta\b|metrocard|amtrak|njtransit/i,
    target: 'Transportation::Public transit' },
  { merchant: /cinemark|\bamc\b|regal\s*cinema|fandango/i, target: 'Entertainment::Movies' },
  { merchant: /northwell|quest\s*diagnost|labcorp|cvs\s*minute/i,
    target: 'Health/medical::Doctors/dental/vision' },
  { merchant: /planet\s*fitness|lifetime\s*fitness|\bgym\b|orangetheory/i, target: 'Other::GYM' },

  // -- merchant rules from a full year's statements -------------------------
  // Written against real descriptions rather than category names. Amex's
  // category is often wrong about purpose: a lawn service files under
  // "Professional Services", heating oil under "Other-Utilities", and a bird
  // feeder under "Employment Agencies".
  { merchant: /booking\.com|bookingcom|airbnb|expedia|vrbo|hotels\.com/i, target: 'Travel::Hotels' },
  { merchant: /all\s*island\s*fuel/i, target: 'Utilities::Heating Oil' },
  { merchant: /santee\s*cooper/i, target: 'Utilities::2nd home utilities' },
  { merchant: /\bscwa\b|suffolk\s*county\s*water/i, target: 'Utilities::Water (Sayville)' },
  { merchant: /micro\s*center/i, target: 'Technology::Hardware' },
  { merchant: /netlify|google\s*\*?\s*google\s*nest|apple\.com\/bil/i, target: 'Technology::Software' },
  { merchant: /top\s*golf|topgolf/i, target: 'Entertainment::Sports' },
  { merchant: /dave\s*&\s*buster|game\s*on\s*arcade/i, target: 'Entertainment::Games' },
  { merchant: /salon\s*d.artiste/i, target: 'Everyday::Hair/beauty' },
  { merchant: /mini\s*monet/i, target: 'Children::Activities' },
  { merchant: /moves\s*app|amazon\s*prime/i, target: 'Everyday::Subscriptions' },
  { merchant: /jaks\s*lawn/i, target: 'Home::Lawn Maintenance' },
  { merchant: /enterprise\s*rent|enterprise\s*ren\d|hertz|\bavis\b|budget\s*rent/i, target: 'Travel::Transportation' },
  { merchant: /fema\s*flood/i, target: 'Insurance::Surfside Home flood  Insurance' },
  { merchant: /state\s*dmv|\bdmv\b/i, target: 'Transportation::Registration/license' },
  { merchant: /legoland|adventureland/i, target: 'Children::Activities' },
  { merchant: /autozone|advance\s*auto|pep\s*boys/i, target: 'Transportation::Repairs' },
  { merchant: /scholastic|connetquot\s*csd|\bcsd\b/i, target: 'Children::School' },
  { merchant: /michaels/i, target: 'Entertainment::Hobbies' },
  { merchant: /car\s*rental\s*protection/i, target: 'Travel::Transportation' },
  { merchant: /eractoll|carte\s*(italiane|straniere)/i, target: 'Travel::Transportation' },

  // -- location, where the budget keeps a line per property -----------------
  { category: /cable\s*&\s*internet|internet\s*comm/i,
    byState: { NY: 'Home::Internet/Cable (sayville)', SC: 'Home::Internet/Cable (Surfside)' } },
  { category: /water|sewer/i,
    byState: { NY: 'Utilities::Water (Sayville)', SC: 'Utilities::Water ( Surfside)' } },

  // -- card category --------------------------------------------------------
  { category: /groceries|supermarket|wholesale\s*stores?/i, target: 'Everyday::Groceries' },
  { category: /restaurant|bar\s*&\s*caf|fast\s*food|dining/i, target: 'Everyday::Restaurants' },
  { category: /fuel|gas\s*station|service\s*station/i, target: 'Transportation::Fuel' },
  { category: /airline|air\s*travel/i, target: 'Travel::Airfare' },
  { category: /lodging|hotel/i, target: 'Travel::Hotels' },
  { category: /clothing|apparel/i, target: 'Everyday::Clothes' },
  { category: /pharmac|drug\s*stores?/i, target: 'Everyday::Personal supplies' },
  { category: /general\s*retail/i, target: 'Everyday::Personal supplies' },
  { category: /florists?\s*&\s*garden|furnishing/i, target: 'Home::Furnishings' },
  { category: /hardware|office\s*supplies/i, target: 'Home::Supplies' },
  { category: /charit/i, target: 'Gifts::Donations (charity)' },
  { category: /rail\s*services|parking|taxis?|coach|transit/i, target: 'Transportation::Public transit' },
  { category: /theatrical|general\s*events|concert/i, target: 'Entertainment::Concerts/shows' },
  { category: /health\s*care/i, target: 'Health/medical::Doctors/dental/vision' },
  { category: /fees\s*&\s*adjustments/i, target: 'Debt::Credit cards' },
  { category: /travel\s*agenc/i, target: 'Travel::Hotels' },
  { category: /vehicle\s*rental/i, target: 'Travel::Transportation' },
  { category: /computer\s*supplies|electronics\s*stores?/i, target: 'Technology::Hardware' },
  { category: /sporting\s*goods/i, target: 'Entertainment::Sports' },
  { category: /theme\s*parks/i, target: 'Children::Activities' },
  { category: /general\s*attractions/i, target: 'Travel::Entertainment' },
  { category: /auto\s*services/i, target: 'Transportation::Repairs' },
  { category: /tolls\s*&\s*fees/i, target: 'Transportation::Other' },
  { category: /book\s*stores?|arts\s*&\s*jewelry/i, target: 'Entertainment::Hobbies' },
  { category: /other-education|^education/i, target: 'Children::School' },
  // Deliberately absent: "Internet Purchase". That is Amazon, Walmart.com and
  // Target.com, which between them can be anything at all. The purpose is not
  // in the file, so it goes to the catch-all rather than being invented.
]

/** Two-letter state from the export's "City/State" cell, e.g. "CONWAY\nSC". */
export function stateOf(location) {
  const m = String(location || '').toUpperCase().match(/\b([A-Z]{2})\b\s*$/)
  return m ? m[1] : ''
}

/**
 * The target spec a transaction maps to, or null when nothing matches.
 *
 * Merchant and category rules are both collected, and the card's own category
 * wins when it has one. That is the opposite of the obvious design, and it is
 * what the data demands: a merchant pattern is a substring test against free
 * text, so it misfires in ways that are invisible until money moves. "Lowe's"
 * matched Lowe's Foods, a grocery chain. "Avis" matched BRAVISSIMO. A rule for
 * Cinemark caught the restaurant inside the cinema, which the card had already
 * filed — correctly — as a restaurant.
 *
 * In each case the card category was right and the merchant rule was wrong, so
 * deferring to a confident category is the safer default. A rule that genuinely
 * needs to overrule the card sets `override`: streaming services are filed by
 * Amex under "Cable & Internet Comm", and belong on a subscription line.
 *
 * Merchant rules still do the heavy lifting, because most of what needs one
 * has no useful category at all — heating oil and a lawn service both arrive
 * as vague "Other" and "Professional Services" labels.
 */
export function matchRule(row) {
  let merchantHit = null
  let categoryHit = null

  for (const rule of RULES) {
    const byMerchant = Boolean(rule.merchant)
    if (byMerchant && !rule.merchant.test(row.description || '')) continue
    if (rule.category && !rule.category.test(row.category || '')) continue
    if (!byMerchant && !rule.category) continue

    let target = rule.target
    if (rule.byState) {
      target = rule.byState[row.state]
      // An unrecognised state means the rule cannot decide; fall through rather
      // than picking one property arbitrarily.
      if (!target) continue
    }

    if (byMerchant) {
      if (rule.override) return target
      if (!merchantHit) merchantHit = target
    } else if (!categoryHit) {
      categoryHit = target
    }
  }

  return categoryHit || merchantHit || null
}

/** Kept for callers that only have a category to go on. */
export const targetForCategory = (category) => matchRule({ category, description: '', state: '' })

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
    const location = String(at('location') ?? '').trim()
    const row = { year, month, amount, description, category, state: stateOf(location) }

    rows.push({
      ...row,
      target: matchRule(row),
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
/**
 * Resolve a "Category::Item" spec against the budget's own line items.
 *
 * Returns { item } on a clean hit, or { ambiguous } when a bare name matches
 * more than one expense line. Ambiguity is reported rather than resolved by
 * picking one: five item names in this budget are duplicated across
 * categories, and silently choosing would put money on a line at random.
 */
export function resolveTarget(data, spec) {
  const expense = new Set(
    data.categories.filter((c) => c.kind === 'expense').map((c) => c.id),
  )
  const catName = new Map(data.categories.map((c) => [c.id, norm(c.name)]))
  const candidates = data.items.filter((i) => expense.has(i.categoryId))

  const idx = String(spec || '').indexOf(TARGET_SEPARATOR)
  if (idx >= 0) {
    const wantCat = norm(spec.slice(0, idx))
    const wantItem = norm(spec.slice(idx + TARGET_SEPARATOR.length))
    const item = candidates.find(
      (i) => norm(i.name) === wantItem && catName.get(i.categoryId) === wantCat,
    )
    return { item: item || null }
  }

  const hits = candidates.filter((i) => norm(i.name) === norm(spec))
  if (hits.length > 1) return { item: null, ambiguous: hits.length }
  return { item: hits[0] || null }
}

export function summarise(rows, data, { catchAll = true } = {}) {

  const cells = new Map() // `${itemId}:${month}` -> total
  const unmatched = new Map() // category -> { total, count }
  const missingItem = new Map() // target name -> { total, count }
  let payments = 0
  let wrongYear = 0
  let assigned = 0
  let swept = 0
  const ambiguousTargets = new Set()

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
    const { item, ambiguous } = resolveTarget(data, targetName)
    if (ambiguous) ambiguousTargets.add(targetName)
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
    ambiguousTargets: [...ambiguousTargets],
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
