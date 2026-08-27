// Sync controller: the read-merge-write cycle against the GitHub Contents API.
//
// Kept out of App.jsx and free of React so the conflict handling can be tested
// directly, with getFile/putFile stubbed.
//
// The rule: a push never writes what this device happens to hold. It reads the
// file, merges, and writes the union. That makes a 409 (someone committed
// between our read and our write) safe to retry — the retry re-reads and
// re-merges, so the other device's rows survive instead of being overwritten.
//
// The union has one way to destroy: a tombstone on the remote deletes a row
// here. That is what a legitimate delete on another device looks like, and it
// is also what tampering looks like. Neither can be told apart from the file
// alone, so a merge that would drop a meaningful share of what this device
// holds stops and reports rather than proceeding — on a push it stops BEFORE
// the write, or the guard would only be describing damage already done.

import { getFile as ghGetFile, putFile as ghPutFile } from './github.js'
import { mergeData, validateData } from './model.js'

const defaultApi = { getFile: ghGetFile, putFile: ghPutFile }

const isConflict = (e) => /\b409\b|does not match/.test(e?.message || '')

/**
 * Two documents for different years must never merge. On a path with no
 * {year} in it every year resolves to the same file, so pushing a rolled-over
 * year would merge next year's plan into this year's document — same ids, same
 * row counts, so the loss guard sees nothing, while this year's actuals are
 * quietly overwritten. That is a misconfiguration, not a judgement call, so it
 * is refused outright rather than offered as a choice.
 */
const yearMismatch = (local, remote) => remote.year !== local.year

/** Parse the remote file, or null when it does not exist yet. */
function parseRemote(content) {
  if (content === null) return null
  const result = validateData(JSON.parse(content))
  if (!result.ok) throw new Error(`File is not a valid budget document: ${result.error}`)
  return result.data
}

/** What a document holds, in the three counts a wipe shows up in. */
const census = (d) => ({
  categories: d.categories.length,
  items: d.items.length,
  transactions: (d.transactions || []).length,
})

// A loss has to clear both bars to count. The absolute floor keeps a tidy-up
// of two stray rows from raising an alarm; the share keeps a loss of 200
// transactions out of 996 from slipping under a fixed threshold.
//
// Losing ALL of something bypasses the floor. Categories are few by nature —
// a budget with three of them would otherwise have to lose every one without
// the guard naming it.
const LOSS_FLOOR = 3
const LOSS_SHARE = 0.2

/**
 * What a merge would take away from `before`. Empty means the merge only ever
 * adds, which is the ordinary case and needs no confirmation.
 */
export function mergeLosses(before, after) {
  const a = census(before)
  const b = census(after)
  const losses = []
  const check = (key, one, many) => {
    const lost = a[key] - b[key]
    const enough = lost >= LOSS_FLOOR || (b[key] === 0 && lost > 0)
    if (enough && lost >= a[key] * LOSS_SHARE) {
      losses.push({ key, lost, before: a[key], after: b[key], label: `${lost} ${lost === 1 ? one : many}` })
    }
  }
  check('categories', 'category', 'categories')
  check('items', 'line item', 'line items')
  check('transactions', 'transaction', 'transactions')
  return losses
}

export const serialize = (data) =>
  JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)

/** Merge the remote file into `local`. Does not write. */
export async function pullMerged(config, local, api = defaultApi, options = {}) {
  const { content, sha } = await api.getFile(config)
  const remote = parseRemote(content)
  if (!remote) return { merged: local, sha: null, existed: false }
  if (yearMismatch(local, remote)) {
    return { merged: local, sha, existed: true, blocked: 'year', remoteYear: remote.year }
  }
  const merged = mergeData(local, remote)
  const losses = options.allowDestructive ? [] : mergeLosses(local, merged)
  if (losses.length) return { merged, sha, existed: true, blocked: 'losses', losses }
  return { merged, sha, existed: true }
}

/**
 * Read, merge, write. Returns the merged document that is now on GitHub, which
 * the caller should adopt as local state — it may contain rows this device had
 * never seen.
 */
export async function pushMerged(config, local, api = defaultApi, options = {}) {
  const { attempts = 3, allowDestructive = false } = options
  let lastError
  for (let i = 0; i < attempts; i++) {
    const { content, sha } = await api.getFile(config)
    const remote = parseRemote(content)
    if (remote && yearMismatch(local, remote)) {
      return { merged: local, blocked: 'year', remoteYear: remote.year }
    }
    const merged = remote ? mergeData(local, remote) : local

    // Before the write, not after: once putFile returns, the remote already
    // holds the merge and reporting it would be an autopsy.
    const losses = allowDestructive ? [] : mergeLosses(local, merged)
    if (losses.length) return { merged, blocked: 'losses', losses }

    try {
      const put = await api.putFile(config, serialize(merged), sha, 'Update budget data')
      return { merged, sha: put.sha }
    } catch (e) {
      // Another device committed in the gap. Re-read and merge again rather
      // than retrying the same body, which is what used to lose their rows.
      if (!isConflict(e)) throw e
      lastError = e
    }
  }
  throw lastError
}
