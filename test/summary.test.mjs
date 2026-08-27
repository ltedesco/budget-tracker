import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'
import {
  summaryFor, variance, average, monthsWithActuals, rollup, budgetCSV, chartSeries,
} from '../src/lib/summary.js'

const BORN = '2026-01-01T00:00:00.000Z'

// Round, invented numbers on purpose. This repository is public, so no real
// salary, mortgage or balance belongs in it — not even as a test fixture.
const BALANCE = 1000
const SALARY = 5000      // per month -> 60,000
const MORTGAGE = 2000    // per month -> 24,000
const TAXES = [0, 0, 0, 0, 0, 3000, 0, 0, 0, 0, 1000, 0] // -> 4,000
const PHONE = 100        // per month -> 1,200

/** A small budget mirroring the shape of the source workbook. */
function fixture() {
  const d = emptyData(2026)
  d.startingBalance = BALANCE

  const wages = makeCategory({ kind: 'income', name: 'Wages', order: 0 }, BORN)
  const home = makeCategory({ kind: 'expense', name: 'Home', order: 0 }, BORN)
  const debt = makeCategory({ kind: 'expense', name: 'Debt', order: 1 }, BORN)
  d.categories.push(wages, home, debt)

  d.items.push(makeItem({ categoryId: wages.id, name: 'Salary', order: 0, planned: Array(12).fill(SALARY) }, BORN))
  d.items.push(makeItem({ categoryId: home.id, name: 'Mortgage', order: 0, planned: Array(12).fill(MORTGAGE) }, BORN))
  d.items.push(makeItem({ categoryId: home.id, name: 'Property taxes', order: 1, planned: TAXES }, BORN))
  d.items.push(makeItem({ categoryId: debt.id, name: 'Phone', order: 0, planned: Array(12).fill(PHONE) }, BORN))
  return d
}

test('yearly totals sum every line item', () => {
  const s = summaryFor(fixture(), 'planned')
  assert.equal(s.totals.income, 60000)                    // 5,000 x 12
  assert.equal(s.totals.expenses, 24000 + 4000 + 1200)
  assert.equal(s.totals.net, s.totals.income - s.totals.expenses)
})

test('ending balance carries forward from the starting balance', () => {
  const s = summaryFor(fixture(), 'planned')
  const janNet = SALARY - (MORTGAGE + 0 + PHONE)
  assert.equal(s.ending[0], BALANCE + janNet)
  assert.equal(s.ending[1], BALANCE + janNet * 2)
  // June carries a lumpy tax bill, so that month dips.
  assert.equal(s.ending[5], s.ending[4] + (SALARY - (MORTGAGE + TAXES[5] + PHONE)))
  assert.equal(s.totals.ending, s.ending[11])
})

test('a blank month counts as zero, not as a gap', () => {
  const d = emptyData(2026)
  const cat = makeCategory({ kind: 'expense', name: 'X', order: 0 }, BORN)
  d.categories.push(cat)
  d.items.push(makeItem({ categoryId: cat.id, name: 'Y', order: 0, planned: [100] }, BORN))
  const s = summaryFor(d, 'planned')
  assert.equal(s.totals.expenses, 100)
  assert.equal(s.expenses[1], 0)
})

test('variance is signed so positive always means better than plan', () => {
  // Spending less than planned is good: positive.
  const under = variance([1000, 1000], [800, 800], 'expense')
  assert.equal(under[0], 200)
  // Earning less than planned is bad: negative.
  const short = variance([1000, 1000], [800, 800], 'income')
  assert.equal(short[0], -200)
})

test('average is the twelve-month average', () => {
  assert.equal(average(Array(12).fill(100)), 100)
  assert.equal(average([1200, ...Array(11).fill(0)]), 100)
})

test('months with actuals are reported, and blanks are not counted', () => {
  const d = fixture()
  assert.deepEqual(monthsWithActuals(d), [])
  d.items[0].actual[0] = 4800
  d.items[0].actual[2] = 0            // an explicit zero IS recorded
  assert.deepEqual(monthsWithActuals(d), [0, 2])
})

test('category rollup totals each category separately', () => {
  const rows = rollup(fixture(), 'expense', 'planned')
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.total]))
  assert.equal(byName.Home, 24000 + 4000)
  assert.equal(byName.Debt, 1200)
})

test('chart series carries both layers for all twelve months', () => {
  const series = chartSeries(fixture())
  assert.equal(series.length, 12)
  assert.equal(series[0].month, 'Jan')
  assert.equal(series[0].plannedIncome, SALARY)
  assert.equal(series[0].actualIncome, 0)
})

test('CSV export quotes fields containing commas', () => {
  const d = fixture()
  d.categories[1].name = 'Home, primary'
  const csv = budgetCSV(d)
  assert.match(csv, /"Home, primary"/)
  assert.match(csv.split('\n')[0], /^Kind,Category,Line item,Layer,Jan,/)
  assert.match(csv, /Summary \(planned\)/)
})
