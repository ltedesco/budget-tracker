// Restore from history: the repo's own commits, made usable from the app.
//
// Every push leaves a complete copy of the year's file in the repo, so the
// backups already exist — what was missing was a way to see and read them back
// without git or the GitHub website. That matters most on the day it matters:
// a device wiped, a bad import, a year emptied by accident.
//
// Kept free of React so the counting and the "is this smaller?" judgement can
// be tested directly, with the API stubbed.

import { getFileAt, fileSizeAt, listVersions } from './github.js'
import { sumMonths, validateData } from './model.js'

const defaultApi = { listVersions, getFileAt, fileSizeAt }

/**
 * Recent versions of this year's file, newest first, each with its size.
 *
 * Sizes are gathered concurrently and independently: one that fails comes back
 * null and the row still lists. A version you cannot size is still a version
 * you can preview and restore.
 */
export async function loadVersions(config, limit = 15, api = defaultApi) {
  const versions = await api.listVersions(config, limit)
  const sizes = await Promise.all(
    versions.map((v) => api.fileSizeAt(config, v.sha).catch(() => null)),
  )
  return versions.map((v, i) => ({ ...v, size: sizes[i] }))
}

/**
 * What is actually inside a version — the numbers you need to tell a good
 * snapshot from the one that wiped everything. A size alone does not say
 * whether the transactions are still there.
 */
export function summarize(data) {
  const total = (kind, layer) =>
    data.items
      .filter((it) => byKind(data, it) === kind)
      .reduce((sum, it) => sum + sumMonths(it[layer]), 0)

  return {
    year: data.year,
    categories: data.categories.length,
    items: data.items.length,
    transactions: (data.transactions || []).length,
    plannedExpense: total('expense', 'planned'),
    actualExpense: total('expense', 'actual'),
    plannedIncome: total('income', 'planned'),
    actualIncome: total('income', 'actual'),
  }
}

const byKind = (data, item) =>
  data.categories.find((c) => c.id === item.categoryId)?.kind || 'expense'

/** Read one version and parse it, or explain why it cannot be used. */
export async function readVersion(config, sha, api = defaultApi) {
  const { content, size } = await api.getFileAt(config, sha)
  if (content === null) return { error: 'That version does not contain this file.' }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return { error: 'That version is not readable JSON.' }
  }
  const result = validateData(parsed)
  if (!result.ok) return { error: `That version is not a valid budget document: ${result.error}` }
  return { data: result.data, size, summary: summarize(result.data) }
}

/**
 * How a version compares with what is loaded now. The point is to make a
 * restore that would lose something say so before it happens, rather than
 * after — the counts are what a wipe shows up in.
 */
export function compareToCurrent(summary, current) {
  const now = summarize(current)
  const losses = []
  const field = (key, one, many) => {
    const delta = summary[key] - now[key]
    if (delta < 0) losses.push(`${-delta} ${-delta === 1 ? one : many}`)
  }
  field('categories', 'category', 'categories')
  field('items', 'line item', 'line items')
  field('transactions', 'transaction', 'transactions')
  return {
    now,
    losses,
    // Same year or not: restoring 2026 over 2027 would be a real mistake, and
    // nothing else in the flow would catch it.
    yearMismatch: summary.year !== current.year,
  }
}
