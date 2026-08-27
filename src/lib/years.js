// Carrying a budget from one year into the next, and comparing years.
//
// The structure — the categories and line items — is the part that persists.
// What changes each year is the twelve values against each of them. So a
// rollover copies the structure and **keeps every id**, which is what lets a
// year-over-year comparison line up even after something is renamed. Diverge
// the structure later and the years still compare on what they have in common.

import { emptyData, nowISO, sumMonths } from './model.js'
import { breakdown, categoryMonths, summaryFor } from './summary.js'

export const SEED_MODES = ['actual', 'planned', 'blank']

/**
 * Build next year from this one.
 *
 * `seed` decides where the new plan comes from. Seeding from actuals is the
 * useful default: a plan written against what was really spent starts honest,
 * where copying last year's plan forward carries its errors with it. Months
 * with no actual recorded fall back to the plan, so a part-tracked year does
 * not produce a budget of zeroes.
 */
export function rollover(data, nextYear, { seed = 'actual', at = nowISO() } = {}) {
  const year = Number(nextYear)
  const closing = summaryFor(data, 'actual')
  const plannedClose = summaryFor(data, 'planned')

  // Next year opens where this one closed. If nothing was tracked, the planned
  // close is the only estimate available.
  const tracked = data.items.some((i) => (i.actual || []).some((v) => v !== null && v !== undefined))
  const startingBalance = tracked ? closing.totals.ending : plannedClose.totals.ending

  const items = data.items.map((item) => {
    const planned =
      seed === 'blank'
        ? Array(12).fill(null)
        : seed === 'planned'
          ? [...(item.planned || Array(12).fill(null))]
          : (item.actual || []).map((v, i) =>
              v === null || v === undefined ? (item.planned?.[i] ?? null) : v)

    return {
      ...item,
      planned,
      actual: Array(12).fill(null),
      imported: {},
      fieldsAt: {},
      baseAt: at,
      updatedAt: at,
    }
  })

  return {
    ...emptyData(year),
    startingBalance: Math.round(startingBalance * 100) / 100,
    startingBalanceAt: at,
    categories: data.categories.map((c) => ({ ...c, updatedAt: at })),
    items,
    transactions: [],
    deleted: [],
  }
}

/**
 * Line up several years for comparison.
 *
 * Matching is by line-item id, falling back to category and name so a year
 * created before rollover existed still lines up. A row appears if any year
 * has something for it, and years that do not are left blank rather than
 * zeroed — an absent line and a line that cost nothing are different facts.
 */
export function compareYears(docs) {
  const years = docs.map((d) => d.year).sort((a, b) => a - b)
  const byKey = new Map()

  for (const doc of docs) {
    const cats = new Map(doc.categories.map((c) => [c.id, c]))
    for (const item of doc.items) {
      const cat = cats.get(item.categoryId)
      if (cat?.kind !== 'expense' && cat?.kind !== 'income') continue
      const key = item.id
      const row = byKey.get(key) || {
        key,
        name: item.name,
        category: cat.name,
        kind: cat.kind,
        years: {},
      }
      row.years[doc.year] = {
        planned: sumMonths(item.planned),
        actual: sumMonths(item.actual),
        hasActual: (item.actual || []).some((v) => v !== null && v !== undefined),
      }
      byKey.set(key, row)
    }
  }

  const rows = [...byKey.values()].filter((r) =>
    years.some((y) => r.years[y] && (r.years[y].planned || r.years[y].actual)))

  return { years, rows: rows.sort(byCategoryThenSize(years)) }
}

const byCategoryThenSize = (years) => (a, b) => {
  if (a.kind !== b.kind) return a.kind === 'income' ? -1 : 1
  if (a.category !== b.category) return a.category.localeCompare(b.category)
  const size = (r) => Math.max(...years.map((y) => r.years[y]?.actual || r.years[y]?.planned || 0))
  return size(b) - size(a)
}

/** Totals per year for one side of the budget. */
export function yearTotals(docs, kind) {
  return docs.map((doc) => {
    const s = summaryFor(doc, kind === 'income' ? 'planned' : 'planned')
    const a = summaryFor(doc, 'actual')
    return {
      year: doc.year,
      planned: kind === 'income' ? s.totals.income : s.totals.expenses,
      actual: kind === 'income' ? a.totals.income : a.totals.expenses,
    }
  })
}

/**
 * The per-category breakdown across years: one row per year, one key per
 * category, shaped exactly like the monthly version so the same chart draws
 * both.
 *
 * Categories are matched by id, which is what rollover preserves — so a
 * category renamed between years still lines up, and its band keeps its
 * colour. The name shown is the most recent year's, since that is the one the
 * reader is currently using.
 */
export function categoryYearSeries(docs, layer, only = null) {
  const ordered = [...docs].sort((a, b) => a.year - b.year)
  const latest = ordered[ordered.length - 1]
  if (!latest) return { rows: [], income: [], expense: [] }

  const { income, expense } = breakdown(latest, layer, only)

  const rows = ordered.map((doc) => {
    const row = { year: String(doc.year), incomeTotal: 0, expenseTotal: 0 }
    for (const [list, key] of [[income, 'incomeTotal'], [expense, 'expenseTotal']]) {
      for (const s of list) {
        const ids = s.folds || [s.id]
        const total = ids.reduce((sum, id) => sum + sumMonths(categoryMonths(doc, id, layer)), 0)
        row[s.id] = total
        row[key] += total
      }
    }
    return row
  })

  return { rows, income, expense }
}
