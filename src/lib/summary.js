// Derived totals. Pure functions over the document — no React, so the numbers
// that matter most can be tested directly.
//
// Mirrors the Summary sheet of the source workbook: monthly income, monthly
// expenses, net savings, and a running ending balance seeded from the starting
// balance. Everything is computed per layer ('planned' | 'actual') so the two
// can be shown side by side.

import { MONTHS, sumMonths } from './model.js'

const zeros = () => Array(12).fill(0)

/** Items belonging to one category, in display order. */
export const itemsOf = (data, categoryId) =>
  data.items.filter((it) => it.categoryId === categoryId).sort((a, b) => a.order - b.order)

export const categoriesOf = (data, kind) =>
  data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order)

/** Per-month totals for one category on one layer. */
export function categoryMonths(data, categoryId, layer) {
  const out = zeros()
  for (const it of data.items) {
    if (it.categoryId !== categoryId) continue
    const months = it[layer] || []
    for (let i = 0; i < 12; i++) out[i] += Number(months[i]) || 0
  }
  return out
}

/**
 * Per-month totals across every category of one kind.
 *
 * `only` narrows it to a chosen set of category ids. Null means everything —
 * deliberately not "an empty set means everything", since a caller that has
 * genuinely selected nothing should get zeros rather than the whole budget.
 */
export function kindMonths(data, kind, layer, only = null) {
  let ids = new Set(categoriesOf(data, kind).map((c) => c.id))
  if (only) ids = new Set([...ids].filter((id) => only.has(id)))
  const out = zeros()
  for (const it of data.items) {
    if (!ids.has(it.categoryId)) continue
    const months = it[layer] || []
    for (let i = 0; i < 12; i++) out[i] += Number(months[i]) || 0
  }
  return out
}

/**
 * The whole summary for one layer: income, expenses, net savings per month,
 * and the ending balance carried forward month to month.
 */
export function summaryFor(data, layer, only = null) {
  const income = kindMonths(data, 'income', layer, only)
  const expenses = kindMonths(data, 'expense', layer, only)
  const net = zeros()
  const ending = zeros()

  let balance = Number(data.startingBalance) || 0
  for (let i = 0; i < 12; i++) {
    net[i] = income[i] - expenses[i]
    balance += net[i]
    ending[i] = balance
  }

  return {
    income,
    expenses,
    net,
    ending,
    // A running balance means nothing once categories are excluded: it would
    // be the starting balance plus part of the year's movement, which is not
    // the balance of anything. Computed anyway so the shape stays constant,
    // and flagged so no caller can show it by accident.
    endingIsMeaningful: only === null,
    totals: {
      income: sumMonths(income),
      expenses: sumMonths(expenses),
      net: sumMonths(net),
      ending: ending[11],
    },
  }
}

/**
 * Planned vs actual for one row of months.
 *
 * Variance is signed so that positive always means "better than planned":
 * for income that is earning more, for expenses it is spending less. Without
 * the flip, a red number would mean opposite things on the two tabs.
 */
export function variance(planned, actual, kind) {
  const out = zeros()
  const sign = kind === 'income' ? 1 : -1
  for (let i = 0; i < 12; i++) {
    out[i] = sign * ((Number(actual[i]) || 0) - (Number(planned[i]) || 0))
  }
  return out
}

/** Monthly average across the full year — total / 12. */
export const average = (months) => sumMonths(months) / 12

/**
 * How much of the year has actual data entered. Used to avoid comparing a
 * full-year plan against three months of actuals and calling it a saving.
 */
export function monthsWithActuals(data) {
  const seen = new Set()
  for (const it of data.items) {
    const months = it.actual || []
    for (let i = 0; i < 12; i++) {
      if (months[i] !== null && months[i] !== undefined) seen.add(i)
    }
  }
  return [...seen].sort((a, b) => a - b)
}

/** Category-level rollup for the summary tables. */
export function rollup(data, kind, layer) {
  return categoriesOf(data, kind).map((cat) => {
    const months = categoryMonths(data, cat.id, layer)
    return {
      id: cat.id,
      name: cat.name,
      months,
      total: sumMonths(months),
      average: average(months),
    }
  })
}

/** Biggest expense categories for the current layer, largest first. */
export function topCategories(data, layer, limit = 6) {
  return rollup(data, 'expense', layer)
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}

/** Chart-ready series: one row per month with both layers. */
export function chartSeries(data, only = null) {
  const planned = summaryFor(data, 'planned', only)
  const actual = summaryFor(data, 'actual', only)
  return MONTHS.map((label, i) => ({
    month: label,
    plannedIncome: planned.income[i],
    plannedExpenses: planned.expenses[i],
    actualIncome: actual.income[i],
    actualExpenses: actual.expenses[i],
    plannedEnding: planned.ending[i],
    actualEnding: actual.ending[i],
  }))
}

/**
 * Turn a stored selection into something safe to compute with.
 *
 * Ids of categories that no longer exist are dropped, so a filter saved before
 * a category was deleted quietly narrows rather than silently showing nothing.
 * Returns null — meaning "no filter" — when the selection covers everything or
 * matches nothing real, because a filter that excludes nothing is not a filter.
 */
export function resolveSelection(data, ids) {
  if (!ids || !ids.length) return null
  const live = new Set(data.categories.map((c) => c.id))
  const kept = ids.filter((id) => live.has(id))
  if (!kept.length || kept.length === data.categories.length) return null
  return new Set(kept)
}

// --- per-category breakdown --------------------------------------------------

/** The most series a stacked bar can carry before the hues run out. */
export const MAX_SERIES = 8
export const OTHER_ID = '__other__'

/**
 * Which categories get their own band in a stack, and which colour slot each
 * one prefers.
 *
 * The preferred slot comes from the category's own position within its kind,
 * never from its size or its position among the selected. That is what keeps
 * Groceries the same colour when Travel is unticked: colour follows the
 * category, so unticking one never repaints the rest.
 *
 * Income counts down from the top of the palette and expenses up from the
 * bottom, so the two stacks standing side by side do not open with the same
 * hue. Where they still meet in the middle, `assignSlots` separates them.
 *
 * Past eight bands the hues would have to repeat, so the smallest are folded
 * into a single "Other" rather than cycled — an eighth and a sixteenth series
 * sharing a colour is worse than not splitting them out.
 */
export function seriesFor(data, kind, layer, only = null, budget = MAX_SERIES) {
  // The slot is taken before filtering, from the category's position among all
  // of its kind. Taking it afterwards would number the survivors 0,1,2… and
  // repaint the whole chart every time one was unticked.
  const withTotals = categoriesOf(data, kind)
    .map((c, i) => ({
      id: c.id,
      name: c.name,
      kind,
      slot: kind === 'income' ? MAX_SERIES - 1 - (i % MAX_SERIES) : i % MAX_SERIES,
      total: sumMonths(categoryMonths(data, c.id, layer)),
    }))
    .filter((c) => !only || only.has(c.id))

  if (withTotals.length <= budget) return withTotals

  const ranked = [...withTotals].sort((a, b) => b.total - a.total)
  const kept = new Set(ranked.slice(0, Math.max(0, budget - 1)).map((c) => c.id))
  const folded = withTotals.filter((c) => !kept.has(c.id))
  return [
    ...withTotals.filter((c) => kept.has(c.id)),
    {
      id: `${OTHER_ID}:${kind}`,
      name: `Other (${folded.length})`,
      kind,
      slot: -1,
      total: folded.reduce((sum, c) => sum + c.total, 0),
      // Ids, not names: two categories may legitimately share a name, and
      // matching on it would fold the wrong one.
      folds: folded.map((c) => c.id),
    },
  ]
}

/**
 * Give every visible band a colour nobody else is using.
 *
 * Preferred slots wrap at eight, so two visible categories sixteen apart — or
 * an income and an expense meeting in the middle — can ask for the same hue.
 * Two bands the same colour on one chart is a worse failure than a band moving
 * colour, so a clash is resolved by moving the later one to the next free slot.
 * Everything that does not clash keeps the slot it asked for, which is the
 * common case and the one that has to stay stable.
 */
export function assignSlots(income, expense) {
  const taken = new Set()
  const place = (s) => {
    if (s.slot < 0) return s // Other stays neutral and never takes a hue.
    let slot = s.slot
    for (let step = 0; step < MAX_SERIES && taken.has(slot); step++) {
      slot = (slot + 1) % MAX_SERIES
    }
    taken.add(slot)
    return { ...s, slot }
  }
  // Expenses first: they are the many, and the ones a reader tracks between
  // views. Income yields the slot when the two want the same hue.
  const nextExpense = expense.map(place)
  const nextIncome = income.map(place)
  return { income: nextIncome, expense: nextExpense }
}

/**
 * Both stacks, filtered, folded and coloured — what a chart needs.
 *
 * The eight hues are shared between the two stacks, not eight each: two bands
 * the same colour are just as confusing standing in different stacks as in the
 * same one. So the budget is split before either is folded. Income takes only
 * what it needs, up to half, and expenses take the rest — a budget usually has
 * two or three ways in and a dozen ways out, and it is the ways out that
 * deserve the bands.
 */
export function breakdown(data, layer, only = null) {
  const incomeCount = categoriesOf(data, 'income').filter((c) => !only || only.has(c.id)).length
  const expenseCount = categoriesOf(data, 'expense').filter((c) => !only || only.has(c.id)).length

  let incomeBudget = incomeCount
  let expenseBudget = expenseCount
  if (incomeCount + expenseCount > MAX_SERIES) {
    incomeBudget = Math.min(incomeCount, Math.max(1, Math.floor(MAX_SERIES / 2)))
    expenseBudget = MAX_SERIES - incomeBudget
  }

  return assignSlots(
    seriesFor(data, 'income', layer, only, incomeBudget),
    seriesFor(data, 'expense', layer, only, expenseBudget),
  )
}

/**
 * Chart rows with one key per series, plus each stack's total so a tooltip can
 * report it without re-adding the parts.
 */
export function categorySeries(data, layer, only = null) {
  const { income, expense } = breakdown(data, layer, only)
  const months = new Map()

  for (const s of [...income, ...expense]) {
    const ids = s.folds || [s.id]
    const totals = zeros()
    for (const id of ids) {
      const m = categoryMonths(data, id, layer)
      for (let i = 0; i < 12; i++) totals[i] += m[i]
    }
    months.set(s.id, totals)
  }

  return MONTHS.map((label, i) => {
    const row = { month: label, incomeTotal: 0, expenseTotal: 0 }
    for (const s of income) {
      row[s.id] = months.get(s.id)[i]
      row.incomeTotal += row[s.id]
    }
    for (const s of expense) {
      row[s.id] = months.get(s.id)[i]
      row.expenseTotal += row[s.id]
    }
    return row
  })
}

// --- export -----------------------------------------------------------------

const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The whole budget as a CSV laid out like the source workbook: one row per
 * line item, twelve month columns, then total and average. Both layers are
 * included so the file stands on its own outside the app.
 */
export function budgetCSV(data) {
  const rows = [['Kind', 'Category', 'Line item', 'Layer', ...MONTHS, 'Total', 'Average']]

  for (const kind of ['income', 'expense']) {
    for (const cat of categoriesOf(data, kind)) {
      for (const it of itemsOf(data, cat.id)) {
        for (const layer of ['planned', 'actual']) {
          const months = it[layer] || []
          const total = sumMonths(months)
          rows.push([
            kind, cat.name, it.name, layer,
            ...months.map((v) => (v === null || v === undefined ? '' : v)),
            total, (total / 12).toFixed(2),
          ])
        }
      }
    }
  }

  for (const layer of ['planned', 'actual']) {
    const s = summaryFor(data, layer)
    rows.push([])
    rows.push([`Summary (${layer})`, '', '', '', ...MONTHS, 'Total', ''])
    rows.push(['', '', 'Income', layer, ...s.income, s.totals.income, ''])
    rows.push(['', '', 'Expenses', layer, ...s.expenses, s.totals.expenses, ''])
    rows.push(['', '', 'Net savings', layer, ...s.net, s.totals.net, ''])
    rows.push(['', '', 'Ending balance', layer, ...s.ending, '', ''])
  }

  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}

// --- coverage ---------------------------------------------------------------
//
// A partial actual column compared against a full-year plan always looks like
// an underspend. That is the most dangerous way to misread this budget, so the
// app states plainly how much of the plan the actuals actually account for
// rather than leaving the top-line variance to speak for itself.

/**
 * How much of planned expense sits on line items that have any actual recorded.
 * Returns amounts and counts for both sides of the comparison.
 */
export function actualCoverage(data, kind = 'expense') {
  const ids = new Set(categoriesOf(data, kind).map((c) => c.id))
  let planned = 0
  let covered = 0
  let trackedItems = 0
  let plannedItems = 0

  for (const it of data.items) {
    if (!ids.has(it.categoryId)) continue
    const plan = sumMonths(it.planned)
    const hasActual = (it.actual || []).some((v) => v !== null && v !== undefined)
    if (plan > 0) {
      planned += plan
      plannedItems += 1
      if (hasActual) { covered += plan; trackedItems += 1 }
    } else if (hasActual) {
      // Spending on a line that was never budgeted still counts as tracked.
      trackedItems += 1
    }
  }

  return {
    planned,
    covered,
    uncovered: planned - covered,
    ratio: planned > 0 ? covered / planned : 0,
    trackedItems,
    plannedItems,
  }
}
