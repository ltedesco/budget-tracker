// The destructive-merge guard and off-GitHub backup tracking.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeLosses, pullMerged, pushMerged } from '../src/lib/sync.js'
import { backupMessage, backupState, recordBackup, STALE_DAYS } from '../src/lib/backup.js'
import { emptyData, makeCategory, makeItem, nowISO } from '../src/lib/model.js'

const cfg = { owner: 'o', repo: 'r', branch: 'main', path: 'p.json', token: 't' }

/** A document with `n` line items and `t` transactions under one category. */
function doc(n, t, year = 2026) {
  const d = emptyData(year)
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 })
  cat.id = 'cat-1'
  d.categories = [cat]
  d.items = Array.from({ length: n }, (_, i) => {
    const it = makeItem({ categoryId: 'cat-1', name: `Line ${i}`, order: i })
    it.id = `item-${i}`
    return it
  })
  d.transactions = Array.from({ length: t }, (_, i) => ({
    id: `tx-${i}`, itemId: 'item-0', date: `${year}-02-02`, month: 1,
    amount: 10, desc: `Charge ${i}`, source: 'amex', cardCategory: '',
  }))
  return d
}

/** The same document with `ids` tombstoned, as a tampered-with remote would be. */
function withDeletes(d, ids) {
  const at = nowISO()
  return {
    ...d,
    items: d.items.filter((it) => !ids.includes(it.id)),
    transactions: d.transactions.filter((t) => !ids.includes(t.itemId)),
    deleted: ids.map((id) => ({ id, at })),
  }
}

const api = (remote) => ({
  getFile: async () => ({ content: remote ? JSON.stringify(remote) : null, sha: 'sha1' }),
  putFile: async () => ({ sha: 'sha2', commit: 'c1' }),
})

// --- mergeLosses ---
test('a merge that only adds loses nothing', () => {
  assert.deepEqual(mergeLosses(doc(10, 100), doc(14, 130)), [])
})

test('a small tidy-up stays under the floor', () => {
  // 2 of 10 items is 20% but only 2 rows — below the absolute floor.
  assert.deepEqual(mergeLosses(doc(10, 100), doc(8, 100)), [])
})

test('a large loss in absolute terms but a tiny share does not trip', () => {
  // 40 transactions of 1000 is 4%: normal churn on a big ledger.
  assert.deepEqual(mergeLosses(doc(10, 1000), doc(10, 960)), [])
})

test('a meaningful loss is named with both counts', () => {
  const losses = mergeLosses(doc(20, 500), doc(12, 500))
  assert.equal(losses.length, 1)
  assert.deepEqual(losses[0], { key: 'items', lost: 8, before: 20, after: 12, label: '8 line items' })
})

test('every kind of loss is reported, not just the first', () => {
  const before = doc(20, 500)
  const after = { ...doc(4, 50), categories: [] }
  assert.deepEqual(mergeLosses(before, after).map((l) => l.key), ['categories', 'items', 'transactions'])
})

test('a first sync onto an empty device is not a loss', () => {
  assert.deepEqual(mergeLosses(emptyData(2026), doc(50, 900)), [])
})

// --- pushMerged ---
test('a destructive push is blocked BEFORE anything is written', async () => {
  const local = doc(20, 500)
  let wrote = false
  const spying = {
    ...api(withDeletes(local, local.items.slice(0, 8).map((i) => i.id))),
    putFile: async () => { wrote = true; return { sha: 's', commit: 'c' } },
  }
  const out = await pushMerged(cfg, local, spying)
  assert.equal(out.blocked, 'losses')
  assert.equal(wrote, false, 'the file must not be written before the user decides')
  assert.equal(out.losses[0].lost, 8)
})

test('confirming lets the same push through', async () => {
  const local = doc(20, 500)
  let wrote = false
  const spying = {
    ...api(withDeletes(local, local.items.slice(0, 8).map((i) => i.id))),
    putFile: async () => { wrote = true; return { sha: 's', commit: 'c' } },
  }
  const out = await pushMerged(cfg, local, spying, { allowDestructive: true })
  assert.equal(out.blocked, undefined)
  assert.equal(wrote, true)
  assert.equal(out.merged.items.length, 12)
})

test('an ordinary push is untouched by the guard', async () => {
  const local = doc(20, 500)
  const out = await pushMerged(cfg, local, api(doc(20, 500)))
  assert.equal(out.blocked, undefined)
  assert.equal(out.merged.items.length, 20)
})

test('creating the file for the first time is never blocked', async () => {
  const out = await pushMerged(cfg, doc(20, 500), api(null))
  assert.equal(out.blocked, undefined)
})

// --- pullMerged ---
test('a destructive pull is reported instead of adopted', async () => {
  const local = doc(20, 500)
  const out = await pullMerged(cfg, local, api(withDeletes(local, local.items.slice(0, 10).map((i) => i.id))))
  assert.equal(out.blocked, 'losses')
  assert.equal(out.losses[0].label, '10 line items')
  // The merged document still comes back, so the dialog can offer to take it.
  assert.equal(out.merged.items.length, 10)
})

test('an ordinary pull is untouched by the guard', async () => {
  const out = await pullMerged(cfg, doc(10, 50), api(doc(12, 60)))
  assert.equal(out.blocked, undefined)
  assert.equal(out.existed, true)
})

// --- backup tracking ---
const day = (n) => Date.UTC(2026, 7, 27) - n * 86400000
const NOW = Date.UTC(2026, 7, 27)

test('a year never backed up says so', () => {
  const state = backupState({}, 2026, NOW)
  assert.equal(state.status, 'never')
  assert.equal(state.days, null)
  assert.match(backupMessage(state, 2026), /No off-GitHub copy of 2026 yet/)
})

test('a recent copy is fresh', () => {
  const prefs = recordBackup({}, 2026, new Date(day(3)).toISOString())
  const state = backupState(prefs, 2026, NOW)
  assert.equal(state.status, 'fresh')
  assert.equal(state.days, 3)
})

test('it goes stale on the boundary, not after it', () => {
  const at = new Date(day(STALE_DAYS)).toISOString()
  assert.equal(backupState(recordBackup({}, 2026, at), 2026, NOW).status, 'stale')
  const newer = new Date(day(STALE_DAYS - 1)).toISOString()
  assert.equal(backupState(recordBackup({}, 2026, newer), 2026, NOW).status, 'fresh')
})

test('backing up one year does not vouch for another', () => {
  const prefs = recordBackup({}, 2026, new Date(day(1)).toISOString())
  assert.equal(backupState(prefs, 2026, NOW).status, 'fresh')
  assert.equal(backupState(prefs, 2027, NOW).status, 'never')
})

test('recording keeps the other years and does not mutate', () => {
  const before = recordBackup({ theme: 'dark' }, 2026, '2026-08-01T00:00:00Z')
  const after = recordBackup(before, 2027, '2026-08-20T00:00:00Z')
  assert.equal(after.theme, 'dark')
  assert.equal(after.lastBackupAt[2026], '2026-08-01T00:00:00Z')
  assert.equal(after.lastBackupAt[2027], '2026-08-20T00:00:00Z')
  assert.equal(before.lastBackupAt[2027], undefined, 'recordBackup must not mutate')
})

test('an unreadable stamp counts as no backup rather than a fresh one', () => {
  assert.equal(backupState({ lastBackupAt: { 2026: 'not a date' } }, 2026, NOW).status, 'never')
})

test('the stale message reads in days then months', () => {
  const at = (n) => recordBackup({}, 2026, new Date(day(n)).toISOString())
  assert.match(backupMessage(backupState(at(31), 2026, NOW), 2026), /31 days ago/)
  assert.match(backupMessage(backupState(at(60), 2026, NOW), 2026), /2 months ago/)
})

test('losing every one of a kind is named even below the floor', () => {
  // One category of one is below the floor of three, but "all of them" is
  // exactly the case the guard exists for.
  const before = doc(20, 500)
  const after = { ...doc(20, 500), categories: [] }
  assert.deepEqual(mergeLosses(before, after).map((l) => l.key), ['categories'])
})

test('emptying the ledger entirely is named however short it was', () => {
  assert.deepEqual(mergeLosses(doc(10, 2), doc(10, 0)).map((l) => l.key), ['transactions'])
})

// --- the year guard ---
// A legacy path with no {year} resolves every year to the same file. Merging
// two years into one document changes no row counts at all, so the loss guard
// is blind to it — this is the guard that catches it.

test('pushing one year over another is refused, and nothing is written', async () => {
  const local = { ...doc(10, 50, 2027), year: 2027 }
  const remote = { ...doc(10, 50, 2026), year: 2026 }
  let wrote = false
  const spying = { ...api(remote), putFile: async () => { wrote = true; return { sha: 's', commit: 'c' } } }
  const out = await pushMerged(cfg, local, spying)
  assert.equal(out.blocked, 'year')
  assert.equal(out.remoteYear, 2026)
  assert.equal(wrote, false)
  assert.equal(out.merged.year, 2027, 'local must come back untouched')
})

test('the year guard cannot be waved through like a row loss', async () => {
  const local = { ...doc(10, 50, 2027), year: 2027 }
  const out = await pushMerged(cfg, local, api({ ...doc(10, 50, 2026), year: 2026 }), { allowDestructive: true })
  assert.equal(out.blocked, 'year', 'a mismatched year is a misconfiguration, not a choice')
})

test('pulling a different year is refused too', async () => {
  const out = await pullMerged(cfg, { ...doc(5, 5, 2027), year: 2027 }, api({ ...doc(5, 5, 2026), year: 2026 }))
  assert.equal(out.blocked, 'year')
  assert.equal(out.merged.year, 2027)
})

test('the same year syncs normally, legacy path or not', async () => {
  const out = await pushMerged(cfg, doc(10, 50, 2026), api(doc(10, 50, 2026)))
  assert.equal(out.blocked, undefined)
})

test('creating a year that has no file yet is not a mismatch', async () => {
  const out = await pushMerged(cfg, doc(10, 50, 2027), api(null))
  assert.equal(out.blocked, undefined)
})

test('a row loss still reports as a row loss, not a year problem', async () => {
  const local = doc(20, 500)
  const out = await pushMerged(cfg, local, api(withDeletes(local, local.items.slice(0, 8).map((i) => i.id))))
  assert.equal(out.blocked, 'losses')
})

test('the merge that would have destroyed 2026 is exactly what is blocked', async () => {
  // The real shape: 2027 rolled over from 2026 keeps every id, so counts match
  // and only the values differ. Proof the loss guard alone would miss it.
  const y2026 = doc(10, 50, 2026)
  const y2027 = { ...doc(10, 50, 2027), year: 2027 }
  assert.deepEqual(mergeLosses(y2027, y2026), [], 'counts are identical — nothing to count')
  const out = await pushMerged(cfg, y2027, api(y2026))
  assert.equal(out.blocked, 'year')
})
