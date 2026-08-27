import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatement, parseStatementDate, parseAmount, isCardPayment,
  targetForCategory, summarise, applySummary, previewRows,
} from '../src/lib/statement.js'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'
import { summaryFor } from '../src/lib/summary.js'

const BORN = '2026-01-01T00:00:00.000Z'

function budget() {
  const d = emptyData(2026)
  const everyday = makeCategory({ kind: 'expense', name: 'Everyday', order: 0 }, BORN)
  const transport = makeCategory({ kind: 'expense', name: 'Transportation', order: 1 }, BORN)
  d.categories.push(everyday, transport)
  for (const name of ['Groceries', 'Restaurants', 'Personal supplies', 'Clothes']) {
    d.items.push(makeItem({ categoryId: everyday.id, name, order: d.items.length }, BORN))
  }
  d.items.push(makeItem({ categoryId: transport.id, name: 'Fuel', order: 0 }, BORN))
  return d
}

const CSV = `Date,Description,Amount,Category
01/04/2026,WHOLEFDS MARKET,152.40,Merchandise & Supplies-Groceries
01/11/2026,SHELL OIL 12345,61.20,Transportation-Fuel
01/18/2026,LUIGI'S TRATTORIA,88.15,Restaurant-Restaurant
02/02/2026,WHOLEFDS MARKET,204.60,Merchandise & Supplies-Groceries
02/14/2026,AUTOPAY PAYMENT - THANK YOU,-1500.00,
02/20/2026,CVS PHARMACY,34.10,Merchandise & Supplies-Pharmacies
03/03/2026,SOME OBSCURE VENDOR,75.00,Business Services-Other
12/15/2025,LAST YEAR CHARGE,999.00,Merchandise & Supplies-Groceries`

test('parses dates in Amex US and ISO form', () => {
  assert.deepEqual(parseStatementDate('01/04/2026'), [2026, 0])
  assert.deepEqual(parseStatementDate('12/31/2026'), [2026, 11])
  assert.deepEqual(parseStatementDate('2026-07-09'), [2026, 6])
  assert.deepEqual(parseStatementDate('nonsense'), [null, null])
})

test('parses amounts including currency and parenthesised negatives', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56)
  assert.equal(parseAmount('(45.00)'), -45)
  assert.equal(parseAmount('-45'), -45)
  assert.ok(Number.isNaN(parseAmount('')))
})

test('recognises card payments so they are never counted as spending', () => {
  assert.ok(isCardPayment('AUTOPAY PAYMENT - THANK YOU'))
  assert.ok(isCardPayment('ONLINE PAYMENT THANK YOU'))
  assert.ok(isCardPayment('Mobile Payment - Thank You'))
  assert.ok(!isCardPayment('WHOLEFDS MARKET'))
  assert.ok(!isCardPayment('PAYMENTS INC HARDWARE'))
})

test('maps card categories only where the mapping is unambiguous', () => {
  assert.equal(targetForCategory('Merchandise & Supplies-Groceries'), 'Groceries')
  assert.equal(targetForCategory('Restaurant-Bar & Café'), 'Restaurants')
  assert.equal(targetForCategory('Transportation-Fuel'), 'Fuel')
  assert.equal(targetForCategory('Travel-Lodging'), 'Hotels')
  // Deliberately unmapped: guessing here would move money between budget lines.
  assert.equal(targetForCategory('Business Services-Other'), null)
  assert.equal(targetForCategory(''), null)
})

test('rejects a file with no recognisable columns', () => {
  const r = parseStatement('foo,bar\n1,2')
  assert.match(r.error, /header row with a date and an amount/i)
  assert.equal(r.rows.length, 0)
})

test('warns when the category column is missing rather than silently matching nothing', () => {
  const r = parseStatement('Date,Description,Amount\n01/04/2026,X,10.00')
  assert.equal(r.error, '')
  assert.match(r.warnings.join(' '), /no category column/i)
})

test('card payments are excluded from spending', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  assert.equal(s.totals.payments, -1500)
  // The payment must not appear in any assigned cell.
  assert.equal(s.totals.assigned, 152.40 + 61.20 + 88.15 + 204.60 + 34.10)
})

test('transactions from another year are held back, not folded into January', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  assert.equal(s.totals.wrongYear, 999)
  const groceriesJan = [...s.cells.entries()].filter(([k]) => k.endsWith(':0'))
  assert.ok(groceriesJan.every(([, v]) => v !== 999))
})

test('unmatched categories are always reported by name, whatever happens to the money', () => {
  // Sweeping is on by default, so the money is destined for the catch-all —
  // but the category is still surfaced, because that is how the mapping gets
  // improved. Which bucket the money lands in depends on whether the catch-all
  // line exists yet; that it is never silently dropped does not.
  const withoutLine = summarise(parseStatement(CSV).rows, budget())
  assert.equal(withoutLine.totals.unmatched, 0, 'money is not left in limbo')
  assert.equal(withoutLine.totals.missingItem, 75, 'it is reported as needing the catch-all line')
  assert.ok(withoutLine.missingItem.some((m) => m.name === 'Unassigned card spend'))

  // With sweeping explicitly off, it is held back and named as unmatched.
  const heldBack = summarise(parseStatement(CSV).rows, budget(), { catchAll: false })
  assert.equal(heldBack.totals.unmatched, 75)
  assert.equal(heldBack.unmatched[0].category, 'Business Services-Other')
})

test('every dollar is accounted for in exactly one bucket', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  const statementTotal = rows.reduce((a, r) => a + r.amount, 0)
  const bucketed =
    s.totals.assigned + s.totals.payments + s.totals.wrongYear +
    s.totals.unmatched + s.totals.missingItem
  assert.equal(Math.round(bucketed * 100), Math.round(statementTotal * 100))
})

test('same category in the same month is summed', () => {
  const csv = `Date,Description,Amount,Category
01/04/2026,A,100.00,Merchandise & Supplies-Groceries
01/20/2026,B,50.00,Merchandise & Supplies-Groceries`
  const d = budget()
  const s = summarise(parseStatement(csv).rows, d)
  const groceries = d.items.find((i) => i.name === 'Groceries')
  assert.equal(s.cells.get(`${groceries.id}:0`), 150)
})

test('a refund nets against its category', () => {
  const csv = `Date,Description,Amount,Category
01/04/2026,A,100.00,Merchandise & Supplies-Groceries
01/20/2026,RETURN,-30.00,Merchandise & Supplies-Groceries`
  const d = budget()
  const s = summarise(parseStatement(csv).rows, d)
  const groceries = d.items.find((i) => i.name === 'Groceries')
  assert.equal(s.cells.get(`${groceries.id}:0`), 70)
})

test('applying writes the actual layer and leaves planned alone', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  groceries.planned = Array(12).fill(1000)
  const s = summarise(parseStatement(CSV).rows, d)
  const next = applySummary(d, s, '2026-09-01T00:00:00Z')
  const after = next.items.find((i) => i.id === groceries.id)
  assert.equal(after.actual[0], 152.40)
  assert.equal(after.actual[1], 204.60)
  assert.deepEqual(after.planned, Array(12).fill(1000))
  assert.equal(summaryFor(next, 'planned').totals.expenses, 12000)
})

test('importing the same statement twice does not double the numbers', () => {
  const d = budget()
  const s = summarise(parseStatement(CSV).rows, d)
  const once = applySummary(d, s, '2026-09-01T00:00:00Z')
  const twice = applySummary(once, summarise(parseStatement(CSV).rows, once), '2026-09-02T00:00:00Z')
  const a = once.items.find((i) => i.name === 'Groceries')
  const b = twice.items.find((i) => i.name === 'Groceries')
  assert.deepEqual(a.actual, b.actual)
  assert.equal(summaryFor(once, 'actual').totals.expenses, summaryFor(twice, 'actual').totals.expenses)
})

test('a month the statement says nothing about keeps its manual entry', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  groceries.actual[7] = 888   // hand-entered August
  const s = summarise(parseStatement(CSV).rows, d)
  const next = applySummary(d, s, '2026-09-01T00:00:00Z')
  assert.equal(next.items.find((i) => i.id === groceries.id).actual[7], 888)
})

test('a mapped category with no matching line item is reported, not invented', () => {
  const d = emptyData(2026)
  const cat = makeCategory({ kind: 'expense', name: 'Everyday', order: 0 }, BORN)
  d.categories.push(cat)   // no Groceries item exists
  const s = summarise(parseStatement(CSV).rows, d)
  assert.ok(s.missingItem.some((m) => m.name === 'Groceries'))
  assert.equal(s.cells.size, 0)
})

test('income line items are never a target for card spending', () => {
  const d = emptyData(2026)
  const inc = makeCategory({ kind: 'income', name: 'Wages', order: 0 }, BORN)
  d.categories.push(inc)
  d.items.push(makeItem({ categoryId: inc.id, name: 'Groceries', order: 0 }, BORN))
  const s = summarise(parseStatement(CSV).rows, d)
  assert.equal(s.cells.size, 0, 'must not write spending onto an income line')
})

test('preview rows carry the category and sort by size', () => {
  const d = budget()
  const s = summarise(parseStatement(CSV).rows, d)
  const rows = previewRows(s, d)
  assert.equal(rows[0].name, 'Groceries')
  assert.equal(rows[0].category, 'Everyday')
  assert.equal(rows[0].total, 357)
})

// --- catch-all: no card dollar may disappear --------------------------------

import { ensureCatchAll, CATCH_ALL_ITEM } from '../src/lib/statement.js'
import { actualCoverage } from '../src/lib/summary.js'
import { makeCategory as mkCat, makeItem as mkItem } from '../src/lib/model.js'

const MAKE = { category: mkCat, item: mkItem }

test('ensureCatchAll creates the line once and is idempotent', () => {
  const d = budget()
  const once = ensureCatchAll(d, MAKE, BORN)
  assert.equal(once.items.length, d.items.length + 1)
  assert.ok(once.items.some((i) => i.name === CATCH_ALL_ITEM))
  const twice = ensureCatchAll(once, MAKE, BORN)
  assert.equal(twice.items.length, once.items.length)
})

test('unmatched spending is swept into the catch-all, not dropped', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(CSV).rows, d)
  const catchAll = d.items.find((i) => i.name === CATCH_ALL_ITEM)
  // The Business Services row has no confident mapping.
  assert.equal(s.cells.get(`${catchAll.id}:2`), 75)
  assert.equal(s.totals.swept, 75)
  // Still reported by category so the mapping can be improved.
  assert.ok(s.unmatched.some((u) => u.category === 'Business Services-Other'))
})

test('with sweeping on, every non-excluded dollar is recorded', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const rows = parseStatement(CSV).rows
  const s = summarise(rows, d)
  const spendable = rows
    .filter((r) => !r.payment && r.year === d.year)
    .reduce((a, r) => a + r.amount, 0)
  assert.equal(Math.round(s.totals.assigned * 100), Math.round(spendable * 100))
  assert.equal(s.totals.missingItem, 0)
})

test('swept money is part of assigned, not a bucket beside it', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const rows = parseStatement(CSV).rows
  const s = summarise(rows, d)
  const total = rows.reduce((a, r) => a + r.amount, 0)
  const bucketed = s.totals.assigned + s.totals.payments + s.totals.wrongYear + s.totals.missingItem
  assert.equal(Math.round(bucketed * 100), Math.round(total * 100))
  assert.ok(s.totals.swept <= s.totals.assigned)
})

test('sweeping can be turned off, and then unmatched money is held back', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(CSV).rows, d, { catchAll: false })
  assert.equal(s.totals.swept, 0)
  assert.equal(s.totals.unmatched, 75)
})

// --- coverage: never compare a partial actual to a full plan ----------------

test('coverage is zero when nothing has been recorded', () => {
  const d = budget()
  d.items.find((i) => i.name === 'Groceries').planned = Array(12).fill(1000)
  const c = actualCoverage(d)
  assert.equal(c.planned, 12000)
  assert.equal(c.covered, 0)
  assert.equal(c.ratio, 0)
})

test('coverage counts planned money on lines that have any actual', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  const fuel = d.items.find((i) => i.name === 'Fuel')
  groceries.planned = Array(12).fill(1000)   // 12,000 planned
  fuel.planned = Array(12).fill(100)         //  1,200 planned
  groceries.actual[0] = 950                  // only groceries tracked
  const c = actualCoverage(d)
  assert.equal(c.planned, 13200)
  assert.equal(c.covered, 12000)
  assert.equal(c.uncovered, 1200)
  assert.equal(c.trackedItems, 1)
  assert.equal(c.plannedItems, 2)
  assert.ok(Math.abs(c.ratio - 12000 / 13200) < 1e-9)
})

test('spending on an unbudgeted line counts as tracked without inflating planned', () => {
  const d = budget()
  d.items.find((i) => i.name === 'Groceries').planned = Array(12).fill(1000)
  d.items.find((i) => i.name === 'Clothes').actual[3] = 220   // no plan for this line
  const c = actualCoverage(d)
  assert.equal(c.planned, 12000)
  assert.equal(c.trackedItems, 1)
  assert.equal(c.plannedItems, 1)
})

test('coverage ignores income lines', () => {
  const d = budget()
  const inc = mkCat({ kind: 'income', name: 'Wages', order: 9 }, BORN)
  d.categories.push(inc)
  d.items.push(mkItem({ categoryId: inc.id, name: 'Salary', order: 0, planned: Array(12).fill(9999) }, BORN))
  assert.equal(actualCoverage(d).planned, 0)
})

// --- real export shapes ------------------------------------------------------
//
// The first version of this importer assumed the header was the first row,
// which is true of a hand-written test file and false of every real Amex
// export. These pin the shapes that actually arrive.

import { findHeaderRow } from '../src/lib/statement.js'
import { columnIndex, serialToISO } from '../src/lib/xlsx.js'

const PREAMBLE_CSV = `Transaction Details,American Express Gold Card
Prepared for,
LOUIS J TEDESCO,
Account Number,
XXXX-XXXXXX-83008,
,
Date,Description,Card Member,Account #,Amount,Reference,Category
08/09/2026,WHOLEFDS MARKET,LOUIS,-83008,152.40,3202600001,Merchandise & Supplies-Groceries
08/14/2026,MOBILE PAYMENT - THANK YOU,LOUIS,-83008,-300.00,3202600002,
08/19/2026,SHELL OIL,LOUIS,-83008,61.20,3202600003,Transportation-Fuel`

test('finds the header row beneath an export preamble', () => {
  const matrix = PREAMBLE_CSV.split('\n').map((l) => l.split(','))
  assert.equal(findHeaderRow(matrix), 6)
})

test('a real-shaped CSV with preamble parses, and says what it skipped', () => {
  const r = parseStatement(PREAMBLE_CSV)
  assert.equal(r.error, '')
  assert.equal(r.headerRow, 6)
  assert.equal(r.rows.length, 3)
  assert.match(r.warnings.join(' '), /skipped 6 rows/i)
})

test('the preamble is not mistaken for transactions', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(PREAMBLE_CSV).rows, d)
  assert.equal(s.totals.payments, -300)
  // Written out rather than 152.4 + 61.2, which is 213.60000000000002 in binary
  // floating point; the code rounds to cents, and the test should assert cents.
  assert.equal(s.totals.assigned, 213.6)
})

test('a header-only file with no rows is reported, not silently empty', () => {
  const r = parseStatement('Date,Amount\n')
  assert.equal(r.error, '')
  assert.equal(r.rows.length, 0)
})

test('a file with no header at all is rejected with an explanation', () => {
  const r = parseStatement('one,two\nthree,four')
  assert.match(r.error, /header row with a date and an amount/i)
})

test('unsupported input is refused rather than parsed as nonsense', () => {
  const r = parseStatement(42)
  assert.match(r.error, /\.csv or \.xlsx/i)
})

test('column refs decode past Z', () => {
  assert.equal(columnIndex('A'), 0)
  assert.equal(columnIndex('Z'), 25)
  assert.equal(columnIndex('AA'), 26)
  assert.equal(columnIndex('BC'), 54)
})

test('Excel date serials convert, including the 1900 leap-year quirk', () => {
  assert.equal(serialToISO(45900), '2025-08-31')
  assert.equal(serialToISO(1), '1900-01-01')
  assert.equal(serialToISO(61), '1900-03-01')
  assert.equal(serialToISO(0), null)
  assert.equal(serialToISO('nope'), null)
})

test('a date held as an Excel serial is read as a date', () => {
  // Row values as a matrix is what the workbook path produces.
  const csv = 'Date,Amount,Category\n46000,100.00,Merchandise & Supplies-Groceries'
  const r = parseStatement(csv)
  // From CSV it is text "46000", which is not a date — must not silently pass.
  assert.equal(r.rows.length, 0)
})
