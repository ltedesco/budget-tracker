import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'
import { rollover, compareYears, yearTotals } from '../src/lib/years.js'
import { summaryFor } from '../src/lib/summary.js'

const BORN = '2026-01-01T00:00:00.000Z'

function year2026() {
  const d = emptyData(2026)
  d.startingBalance = 1000
  const wages = makeCategory({ kind: 'income', name: 'Wages', order: 0 }, BORN)
  const everyday = makeCategory({ kind: 'expense', name: 'Everyday', order: 1 }, BORN)
  d.categories.push(wages, everyday)
  d.items.push(makeItem({ categoryId: wages.id, name: 'Salary', order: 0, planned: Array(12).fill(5000) }, BORN))
  const groceries = makeItem({ categoryId: everyday.id, name: 'Groceries', order: 0, planned: Array(12).fill(1000) }, BORN)
  // Really spent 1,200 a month for the first six months, nothing recorded after.
  groceries.actual = [1200, 1200, 1200, 1200, 1200, 1200, null, null, null, null, null, null]
  d.items.push(groceries)
  return d
}

test('rollover keeps every id, so years line up afterwards', () => {
  const a = year2026()
  const b = rollover(a, 2027)
  assert.equal(b.year, 2027)
  assert.deepEqual(a.items.map((i) => i.id).sort(), b.items.map((i) => i.id).sort())
  assert.deepEqual(a.categories.map((c) => c.id).sort(), b.categories.map((c) => c.id).sort())
})

test('rollover seeds next year from what was really spent', () => {
  const a = year2026()
  const b = rollover(a, 2027, { seed: 'actual' })
  const groceries = b.items.find((i) => i.name === 'Groceries')
  // Tracked months carry their actual; untracked ones fall back to the plan,
  // so a part-tracked year does not roll into a budget of zeroes.
  assert.deepEqual(groceries.planned.slice(0, 6), Array(6).fill(1200))
  assert.deepEqual(groceries.planned.slice(6), Array(6).fill(1000))
})

test('rollover can copy the plan forward, or start blank', () => {
  const a = year2026()
  const copied = rollover(a, 2027, { seed: 'planned' })
  assert.deepEqual(copied.items.find((i) => i.name === 'Groceries').planned, Array(12).fill(1000))
  const blank = rollover(a, 2027, { seed: 'blank' })
  assert.deepEqual(blank.items.find((i) => i.name === 'Groceries').planned, Array(12).fill(null))
})

test('next year opens where this one closed', () => {
  const a = year2026()
  const closing = summaryFor(a, 'actual').totals.ending
  assert.equal(rollover(a, 2027).startingBalance, Math.round(closing * 100) / 100)
})

test('rollover carries no actuals or transactions into the new year', () => {
  const a = year2026()
  a.transactions = [{ id: 't1', source: 'amex:1', date: '2026-03-01', month: 2, amount: 5, desc: 'x', itemId: a.items[0].id }]
  const b = rollover(a, 2027)
  assert.equal(b.transactions.length, 0)
  assert.ok(b.items.every((i) => i.actual.every((v) => v === null)))
  assert.deepEqual(b.items.map((i) => i.imported), b.items.map(() => ({})))
})

test('years line up by line item for comparison', () => {
  const a = year2026()
  const b = rollover(a, 2027, { seed: 'planned' })
  b.items.find((i) => i.name === 'Groceries').actual = Array(12).fill(900)

  const { years, rows } = compareYears([a, b])
  assert.deepEqual(years, [2026, 2027])
  const groceries = rows.find((r) => r.name === 'Groceries')
  assert.equal(groceries.years[2026].actual, 7200)
  assert.equal(groceries.years[2027].actual, 10800)
  assert.equal(groceries.years[2026].planned, 12000)
})

test('a line only one year has still appears, with the other year blank', () => {
  const a = year2026()
  const b = rollover(a, 2027, { seed: 'planned' })
  const cat = b.categories.find((c) => c.name === 'Everyday')
  b.items.push(makeItem({ categoryId: cat.id, name: 'Streaming', order: 9, planned: Array(12).fill(20) }, BORN))

  const { rows } = compareYears([a, b])
  const streaming = rows.find((r) => r.name === 'Streaming')
  assert.ok(streaming, 'the new line is present')
  assert.equal(streaming.years[2026], undefined, 'the year without it is blank, not zero')
  assert.equal(streaming.years[2027].planned, 240)
})

test('income sorts ahead of expenses in the comparison', () => {
  const { rows } = compareYears([year2026()])
  assert.equal(rows[0].kind, 'income')
})

test('year totals give plan and actual per year', () => {
  const a = year2026()
  const b = rollover(a, 2027, { seed: 'planned' })
  const totals = yearTotals([a, b], 'expense')
  assert.equal(totals[0].year, 2026)
  assert.equal(totals[0].planned, 12000)
  assert.equal(totals[0].actual, 7200)
  assert.equal(totals[1].actual, 0)
})

test('a year with nothing recorded is marked untracked, so no change is claimed', () => {
  // The failure this prevents: comparing a finished year against one that has
  // not happened yet reported the whole of the finished year as a fall.
  const a = year2026()
  const b = rollover(a, 2027, { seed: 'planned' })
  const { rows } = compareYears([a, b])

  const salary = rows.find((r) => r.name === 'Salary')
  assert.equal(salary.years[2026].hasActual, false, 'no actuals were entered for salary in 2026')
  assert.equal(salary.years[2027].hasActual, false)

  const groceries = rows.find((r) => r.name === 'Groceries')
  assert.equal(groceries.years[2026].hasActual, true)
  assert.equal(groceries.years[2027].hasActual, false, 'the new year has not been tracked yet')
})
