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
  assert.match(r.error, /date and amount/i)
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

test('unmatched categories are reported with their money, not dropped silently', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  assert.equal(s.totals.unmatched, 75)
  assert.equal(s.unmatched[0].category, 'Business Services-Other')
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
