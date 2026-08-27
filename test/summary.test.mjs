import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, makeCategory, makeItem, sumMonths } from '../src/lib/model.js'
import {
  summaryFor, variance, average, monthsWithActuals, rollup, budgetCSV, chartSeries,
  kindMonths, resolveSelection, seriesFor, categorySeries, breakdown, MAX_SERIES,
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

// --- category filter on the chart -------------------------------------------

test('kindMonths narrows to the selected categories', () => {
  const d = fixture()
  const debt = d.categories.find((c) => c.name === 'Debt')
  const only = new Set([debt.id])
  const all = kindMonths(d, 'expense', 'planned')
  const some = kindMonths(d, 'expense', 'planned', only)
  assert.equal(some[0], PHONE, 'Debt holds only the phone line')
  assert.ok(sumMonths(some) < sumMonths(all), 'a filter must remove something')
})

test('selecting only expense categories zeroes the income series', () => {
  const d = fixture()
  const debt = d.categories.find((c) => c.name === 'Debt')
  const view = summaryFor(d, 'planned', new Set([debt.id]))
  assert.equal(view.totals.income, 0, 'no income category is selected, so no income')
  assert.equal(view.totals.expenses, PHONE * 12)
})

test('an empty selection means nothing, not everything', () => {
  const d = fixture()
  const view = summaryFor(d, 'planned', new Set())
  assert.equal(view.totals.income, 0)
  assert.equal(view.totals.expenses, 0)
})

test('the ending balance is flagged as meaningless once filtered', () => {
  const d = fixture()
  const debt = d.categories.find((c) => c.name === 'Debt')
  assert.equal(summaryFor(d, 'planned').endingIsMeaningful, true)
  assert.equal(summaryFor(d, 'planned', new Set([debt.id])).endingIsMeaningful, false)
})

test('the filtered chart series matches the filtered summary', () => {
  const d = fixture()
  const debt = d.categories.find((c) => c.name === 'Debt')
  const only = new Set([debt.id])
  const rows = chartSeries(d, only)
  const view = summaryFor(d, 'planned', only)
  assert.equal(rows.length, 12)
  rows.forEach((row, i) => {
    assert.equal(row.plannedExpenses, view.expenses[i])
    assert.equal(row.plannedIncome, view.income[i])
  })
})

test('an unfiltered chart is unchanged by the new argument', () => {
  const d = fixture()
  assert.deepEqual(chartSeries(d), chartSeries(d, null))
})

// --- resolveSelection --------------------------------------------------------

test('no selection resolves to no filter', () => {
  const d = fixture()
  assert.equal(resolveSelection(d, []), null)
  assert.equal(resolveSelection(d, null), null)
  assert.equal(resolveSelection(d, undefined), null)
})

test('selecting every category is not a filter', () => {
  const d = fixture()
  assert.equal(resolveSelection(d, d.categories.map((c) => c.id)), null)
})

test('ids of deleted categories are dropped rather than blanking the chart', () => {
  const d = fixture()
  const debt = d.categories.find((c) => c.name === 'Debt')
  const only = resolveSelection(d, [debt.id, 'a-category-since-deleted'])
  assert.deepEqual([...only], [debt.id], 'the live one survives on its own')
})

test('a selection of only dead ids falls back to showing everything', () => {
  // Better than an empty chart with no explanation: the filter is simply gone.
  assert.equal(resolveSelection(fixture(), ['gone-1', 'gone-2']), null)
})

// --- per-category breakdown --------------------------------------------------

/** A budget with `n` expense categories, each holding one item. */
function wide(n) {
  const d = emptyData(2026)
  const inc = makeCategory({ kind: 'income', name: 'Wages', order: 0 }, BORN)
  d.categories.push(inc)
  d.items.push(makeItem({ categoryId: inc.id, name: 'Salary', order: 0, planned: Array(12).fill(9000) }, BORN))
  for (let i = 0; i < n; i++) {
    const c = makeCategory({ kind: 'expense', name: `Cat ${i}`, order: i }, BORN)
    d.categories.push(c)
    // Ascending totals, so the smallest are the ones folded away.
    d.items.push(makeItem({ categoryId: c.id, name: `Item ${i}`, order: 0, planned: Array(12).fill(100 * (i + 1)) }, BORN))
  }
  return d
}

test('each category becomes its own series', () => {
  const d = wide(3)
  const series = seriesFor(d, 'expense', 'planned')
  assert.deepEqual(series.map((s) => s.name), ['Cat 0', 'Cat 1', 'Cat 2'])
  assert.deepEqual(series.map((s) => s.slot), [0, 1, 2])
})

test('a colour slot follows the category, not what else is selected', () => {
  const d = wide(4)
  const third = d.categories.find((c) => c.name === 'Cat 2')
  const all = seriesFor(d, 'expense', 'planned')
  const some = seriesFor(d, 'expense', 'planned', new Set([third.id]))
  // Unticking the earlier categories must not repaint this one.
  assert.equal(all.find((s) => s.name === 'Cat 2').slot, 2)
  assert.equal(some[0].slot, 2, 'the slot is the position in the budget, not in the selection')
})

test('past eight categories the smallest fold into one Other band', () => {
  const d = wide(12)
  const series = seriesFor(d, 'expense', 'planned')
  assert.equal(series.length, MAX_SERIES, 'never more bands than there are hues')
  const other = series[series.length - 1]
  assert.match(other.name, /^Other \(5\)$/)
  assert.equal(other.slot, -1, 'Other is neutral, not a ninth hue')
  // The five smallest (100..500 a month) are the ones folded.
  assert.equal(other.total, (100 + 200 + 300 + 400 + 500) * 12)
})

test('folding keeps every dollar — the bands still sum to the whole', () => {
  const d = wide(12)
  const series = seriesFor(d, 'expense', 'planned')
  const banded = series.reduce((sum, s) => sum + s.total, 0)
  const whole = sumMonths(kindMonths(d, 'expense', 'planned'))
  assert.equal(banded, whole)
})

test('exactly eight categories are not folded', () => {
  const series = seriesFor(wide(8), 'expense', 'planned')
  assert.equal(series.length, 8)
  assert.ok(!series.some((s) => s.slot < 0), 'nothing should be folded at the cap')
})

test('chart rows carry a key per series plus each stack total', () => {
  const d = wide(3)
  const rows = categorySeries(d, 'planned')
  const expense = seriesFor(d, 'expense', 'planned')
  assert.equal(rows.length, 12)
  const jan = rows[0]
  assert.equal(jan.expenseTotal, 100 + 200 + 300)
  assert.equal(jan.incomeTotal, 9000)
  for (const s of expense) assert.ok(s.id in jan, `${s.name} needs its own key`)
})

test('the stack total always equals the bands drawn in it', () => {
  const d = wide(12)
  const rows = categorySeries(d, 'planned')
  const series = seriesFor(d, 'expense', 'planned')
  // The tooltip reports expenseTotal; it must not disagree with the picture.
  for (const row of rows) {
    const drawn = series.reduce((sum, s) => sum + (row[s.id] || 0), 0)
    assert.equal(row.expenseTotal, drawn)
  }
})

test('the breakdown respects the category filter', () => {
  const d = wide(5)
  const pick = d.categories.filter((c) => c.name === 'Cat 1' || c.name === 'Cat 3')
  const only = new Set(pick.map((c) => c.id))
  const series = seriesFor(d, 'expense', 'planned', only)
  assert.deepEqual(series.map((s) => s.name), ['Cat 1', 'Cat 3'])
  assert.equal(categorySeries(d, 'planned', only)[0].expenseTotal, 200 + 400)
  assert.equal(categorySeries(d, 'planned', only)[0].incomeTotal, 0, 'no income category selected')
})

test('income and expenses are counted into separate stacks', () => {
  // Never one stack: a salary added onto a grocery bill measures nothing.
  const row = categorySeries(wide(2), 'planned')[0]
  assert.equal(row.incomeTotal, 9000)
  assert.equal(row.expenseTotal, 300)
})

test('no two visible bands share a colour, across both stacks', () => {
  // Income counts down the palette and expenses up, so with enough of each
  // they meet — and would otherwise both ask for the same hue.
  const d = wide(9)
  for (let i = 0; i < 5; i++) {
    const c = makeCategory({ kind: 'income', name: `Inc ${i}`, order: i + 1 }, BORN)
    d.categories.push(c)
    d.items.push(makeItem({ categoryId: c.id, name: `Pay ${i}`, order: 0, planned: Array(12).fill(500) }, BORN))
  }
  const { income, expense } = breakdown(d, 'planned')
  const slots = [...income, ...expense].map((s) => s.slot).filter((n) => n >= 0)
  assert.equal(new Set(slots).size, slots.length, `duplicate colour slot in ${slots}`)
})

test('a band that clashes with nothing keeps the slot it asked for', () => {
  const d = wide(3)
  const { expense } = breakdown(d, 'planned')
  assert.deepEqual(expense.map((s) => s.slot), [0, 1, 2])
})

test('filtering still does not repaint the bands that survive', () => {
  const d = wide(4)
  const keep = d.categories.filter((c) => c.name === 'Cat 1' || c.name === 'Cat 3')
  const before = breakdown(d, 'planned')
  const after = breakdown(d, 'planned', new Set(keep.map((c) => c.id)))
  for (const s of after.expense) {
    const was = before.expense.find((b) => b.id === s.id)
    assert.equal(s.slot, was.slot, `${s.name} changed colour when the filter changed`)
  }
})
