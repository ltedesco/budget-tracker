// Reading the 1099 tracker as a budget income source.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse1099, payersIn, summarize1099, SOURCE_1099 } from '../src/lib/tracker1099.js'
import { applySummary } from '../src/lib/statement.js'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'

const file = (income) => JSON.stringify({ income, expenses: [], tags: [], deleted: [] })
const entry = (id, date, amount, payer = 'Acme Clinic', note = '') => ({ id, date, amount, payer, note })

/** A budget with one income line to file the payments against. */
function budget(year = 2026) {
  const d = emptyData(year)
  const cat = makeCategory({ kind: 'income', name: 'Wages', order: 0 }); cat.id = 'cat-inc'
  d.categories = [cat]
  const item = makeItem({ categoryId: 'cat-inc', name: 'Contract work', order: 0 })
  item.id = 'item-1099'
  d.items = [item]
  return d
}

// --- parsing ---
test('reads the tracker export', () => {
  const { entries } = parse1099(file([entry('a', '2026-03-04', 500), entry('b', '2026-03-18', 250)]))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].amount, 500)
})

test('a file without an income array is refused by name', () => {
  assert.match(parse1099('{"foo":1}').error, /no "income" array/)
  assert.match(parse1099('not json').error, /not valid JSON/)
})

test('entries without a usable date are dropped rather than guessed at', () => {
  const { entries } = parse1099(file([
    entry('a', '2026-03-04', 500), entry('b', '', 250), { id: 'c', date: 'March', amount: 9 },
  ]))
  assert.deepEqual(entries.map((e) => e.id), ['a'])
})

// --- payers ---
test('lists payers for the year, commonest first', () => {
  const { entries } = parse1099(file([
    entry('a', '2026-01-02', 100, 'Clinic A'), entry('b', '2026-02-02', 100, 'Clinic B'),
    entry('c', '2026-03-02', 100, 'Clinic A'), entry('d', '2025-04-02', 100, 'Old Payer'),
  ]))
  assert.deepEqual(payersIn(entries, 2026), [
    { payer: 'Clinic A', count: 2 }, { payer: 'Clinic B', count: 1 },
  ])
})

// --- summarising ---
test('sums payments into the month they fall in', () => {
  const { entries } = parse1099(file([
    entry('a', '2026-01-05', 300), entry('b', '2026-01-27', 540), entry('c', '2026-02-14', 1015),
  ]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  assert.equal(s.cells.get('item-1099:0'), 840)
  assert.equal(s.cells.get('item-1099:1'), 1015)
  assert.equal(s.totals.amount, 1855)
  assert.equal(s.totals.entries, 3)
})

test('another year is held back, not folded into January', () => {
  const { entries } = parse1099(file([entry('a', '2025-12-30', 900), entry('b', '2026-01-05', 100)]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  assert.equal(s.totals.amount, 100)
  assert.equal(s.totals.outsideYear, 1)
  assert.equal(s.cells.get('item-1099:0'), 100)
})

test('a payer filter excludes the rest and says how many', () => {
  const { entries } = parse1099(file([
    entry('a', '2026-01-05', 100, 'Wanted'), entry('b', '2026-01-06', 900, 'Not wanted'),
  ]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099', payers: ['Wanted'] })
  assert.equal(s.totals.amount, 100)
  assert.equal(s.totals.otherPayer, 1)
})

test('no payer filter means every payer', () => {
  const { entries } = parse1099(file([
    entry('a', '2026-01-05', 100, 'One'), entry('b', '2026-01-06', 900, 'Two'),
  ]))
  assert.equal(summarize1099(entries, { year: 2026, itemId: 'item-1099', payers: [] }).totals.amount, 1000)
})

test('it refuses to guess which line the money belongs to', () => {
  assert.match(summarize1099([], { year: 2026, itemId: '' }).error, /Choose which income line/)
})

test('transaction ids come from the tracker, so re-importing cannot double', () => {
  const { entries } = parse1099(file([entry('abc123', '2026-01-05', 100)]))
  const a = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  const b = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  assert.equal(a.transactions[0].id, `${SOURCE_1099}:abc123`)
  assert.deepEqual(a.transactions, b.transactions)
})

test('the payer, and any note, ride along on the transaction', () => {
  const { entries } = parse1099(file([entry('a', '2026-01-05', 100, 'Acme Clinic', 'March invoice')]))
  const t = summarize1099(entries, { year: 2026, itemId: 'item-1099' }).transactions[0]
  assert.equal(t.desc, 'Acme Clinic — March invoice')
  assert.equal(t.month, 0)
  assert.equal(t.date, '2026-01-05')
})

// --- applying, through the same path a card statement uses ---
test('the figures land on the chosen line', () => {
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840), entry('b', '2026-02-05', 1015)]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  const next = applySummary(budget(), s, '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(next.items[0].actual[0], 840)
  assert.equal(next.items[0].actual[1], 1015)
  assert.equal(next.items[0].imported['0'][SOURCE_1099], 840)
})

test('a hand-typed figure is replaced by the imported one, not added to it', () => {
  // The whole point: these months were being typed in by hand.
  const d = budget()
  d.items[0].actual = [840, null, null, null, null, null, null, null, null, null, null, null]
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840)]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  const next = applySummary(d, s, '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(next.items[0].actual[0], 840, 'not 1680')
})

test('re-importing is idempotent', () => {
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840)]))
  const s = summarize1099(entries, { year: 2026, itemId: 'item-1099' })
  const once = applySummary(budget(), s, '2026-08-27T00:00:00Z', SOURCE_1099)
  const twice = applySummary(once, s, '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.deepEqual(twice.items[0].actual, once.items[0].actual)
  assert.equal(twice.transactions.length, 1, 'the same payment must not appear twice')
})

test('a payment deleted in the 1099 tracker clears the share it left here', () => {
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840), entry('b', '2026-02-05', 1015)]))
  const full = applySummary(budget(), summarize1099(entries, { year: 2026, itemId: 'item-1099' }),
    '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(full.items[0].actual[1], 1015)

  const { entries: fewer } = parse1099(file([entry('a', '2026-01-05', 840)]))
  const after = applySummary(full, summarize1099(fewer, { year: 2026, itemId: 'item-1099' }),
    '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(after.items[0].actual[1], null, 'February must not keep a figure nothing supports')
  assert.equal(after.items[0].actual[0], 840)
  assert.equal(after.transactions.length, 1)
})

test('another source sharing the month keeps its own share', () => {
  const d = budget()
  const withCard = applySummary(d, {
    cells: new Map([['item-1099:0', 200]]), transactions: [], coveredMonths: [0],
  }, '2026-08-27T00:00:00Z', 'amex')
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840)]))
  const next = applySummary(withCard, summarize1099(entries, { year: 2026, itemId: 'item-1099' }),
    '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(next.items[0].actual[0], 1040, 'the two sources sum')
  assert.equal(next.items[0].imported['0'].amex, 200)
  assert.equal(next.items[0].imported['0'][SOURCE_1099], 840)
})

test('months the tracker says nothing about are left alone', () => {
  const d = budget()
  d.items[0].actual = [null, null, null, null, null, null, null, null, null, null, null, 5000]
  const { entries } = parse1099(file([entry('a', '2026-01-05', 840)]))
  const next = applySummary(d, summarize1099(entries, { year: 2026, itemId: 'item-1099' }),
    '2026-08-27T00:00:00Z', SOURCE_1099)
  assert.equal(next.items[0].actual[11], 5000, 'December was never the tracker\'s to touch')
})
