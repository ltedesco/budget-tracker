// Restore-from-history: listing versions, reading one back, and the checks
// that stop a restore doing damage.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listVersions, getFileAt, fileSizeAt } from '../src/lib/github.js'
import { compareToCurrent, loadVersions, readVersion, summarize } from '../src/lib/history.js'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'

const cfg = { owner: 'ltedesco', repo: 'budget', branch: 'main', path: 'data/budget-2026.json', token: 'tok' }
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
let calls = []
const stub = (responder) => {
  calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return responder(url, opts) }
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const commit = (sha, date, message) => ({ sha, commit: { committer: { date }, message, author: { name: 'L' } } })

/** A small but real document: two categories, one item each, one transaction. */
function doc(year = 2026) {
  const d = emptyData(year)
  const exp = makeCategory({ kind: 'expense', name: 'Home', order: 0 })
  const inc = makeCategory({ kind: 'income', name: 'Salary', order: 1 })
  d.categories = [exp, inc]
  d.items = [
    makeItem({ categoryId: exp.id, name: 'Mortgage', order: 0, planned: Array(12).fill(100), actual: Array(12).fill(90) }),
    makeItem({ categoryId: inc.id, name: 'Pay', order: 0, planned: Array(12).fill(500), actual: Array(12).fill(500) }),
  ]
  // `month` is not decoration: validateData drops a transaction without one,
  // so a fixture missing it would quietly test an empty ledger.
  d.transactions = [{ id: 't1', itemId: d.items[0].id, date: `${year}-01-05`, month: 0, amount: 90, desc: 'Bank', source: 'manual' }]
  return d
}

// --- listVersions ---
test('asks for commits touching the path on the sync branch', async () => {
  stub(() => res(200, [commit('abc', '2026-08-01T10:00:00Z', 'Update budget data')]))
  const out = await listVersions(cfg, 5)
  assert.ok(calls[0].url.includes('/repos/ltedesco/budget/commits'), calls[0].url)
  assert.ok(calls[0].url.includes('path=data%2Fbudget-2026.json'), calls[0].url)
  assert.ok(calls[0].url.includes('sha=main'), calls[0].url)
  assert.ok(calls[0].url.includes('per_page=5'), calls[0].url)
  assert.deepEqual(out, [{ sha: 'abc', date: '2026-08-01T10:00:00Z', message: 'Update budget data', author: 'L' }])
})

test('keeps only the first line of a multi-line commit message', async () => {
  stub(() => res(200, [commit('a', '2026-01-01T00:00:00Z', 'Update budget data\n\nlong body')]))
  assert.equal((await listVersions(cfg))[0].message, 'Update budget data')
})

test('an empty repo (409) or missing path (404) is no history, not an error', async () => {
  stub(() => res(409, { message: 'Git Repository is empty.' }))
  assert.deepEqual(await listVersions(cfg), [])
  stub(() => res(404, { message: 'Not Found' }))
  assert.deepEqual(await listVersions(cfg), [])
})

test('a bad token still surfaces as an error', async () => {
  stub(() => res(401, { message: 'Bad credentials' }))
  await assert.rejects(listVersions(cfg), /401/)
})

test('per_page is clamped to what the API accepts', async () => {
  stub(() => res(200, []))
  await listVersions(cfg, 5000)
  assert.ok(calls[0].url.includes('per_page=100'), calls[0].url)
})

// --- getFileAt ---
test('reads the file at one commit', async () => {
  stub(() => res(200, { content: b64('{"a":1}'), size: 7 }))
  const out = await getFileAt(cfg, 'deadbeef')
  assert.ok(calls[0].url.endsWith('?ref=deadbeef'), calls[0].url)
  assert.deepEqual(out, { content: '{"a":1}', size: 7 })
})

test('a commit that predates the file reads as absent', async () => {
  stub(() => res(404, { message: 'Not Found' }))
  assert.deepEqual(await getFileAt(cfg, 'old'), { content: null, size: 0 })
})

// --- fileSizeAt ---
test('finds the size in the tree without downloading the file', async () => {
  stub(() => res(200, { tree: [{ path: 'README.md', size: 10 }, { path: 'data/budget-2026.json', size: 366000 }] }))
  assert.equal(await fileSizeAt(cfg, 'abc'), 366000)
  assert.ok(calls[0].url.includes('/git/trees/abc?recursive=1'), calls[0].url)
})

test('an unavailable size is null, never a thrown error', async () => {
  stub(() => res(403, { message: 'nope' }))
  assert.equal(await fileSizeAt(cfg, 'abc'), null)
  stub(() => { throw new Error('offline') })
  assert.equal(await fileSizeAt(cfg, 'abc'), null)
})

test('a path missing from that tree is null', async () => {
  stub(() => res(200, { tree: [{ path: 'README.md', size: 10 }] }))
  assert.equal(await fileSizeAt(cfg, 'abc'), null)
})

// --- loadVersions ---
test('pairs each version with its size', async () => {
  const api = {
    listVersions: async () => [{ sha: 'a', date: '2026-08-02T00:00:00Z', message: 'x' }, { sha: 'b', date: '2026-08-01T00:00:00Z', message: 'y' }],
    fileSizeAt: async (_c, ref) => (ref === 'a' ? 100 : 200),
    getFileAt: async () => ({ content: null, size: 0 }),
  }
  assert.deepEqual((await loadVersions(cfg, 10, api)).map((v) => [v.sha, v.size]), [['a', 100], ['b', 200]])
})

test('one version failing to size does not lose the list', async () => {
  const api = {
    listVersions: async () => [{ sha: 'a' }, { sha: 'b' }],
    fileSizeAt: async (_c, ref) => { if (ref === 'a') throw new Error('rate limited'); return 200 },
    getFileAt: async () => ({ content: null, size: 0 }),
  }
  const out = await loadVersions(cfg, 10, api)
  assert.equal(out.length, 2)
  assert.equal(out[0].size, null)
  assert.equal(out[1].size, 200)
})

// --- summarize ---
test('counts what is in a version and totals it by kind', () => {
  const s = summarize(doc())
  assert.equal(s.year, 2026)
  assert.equal(s.categories, 2)
  assert.equal(s.items, 2)
  assert.equal(s.transactions, 1)
  assert.equal(s.plannedExpense, 1200)
  assert.equal(s.actualExpense, 1080)
  assert.equal(s.plannedIncome, 6000)
  assert.equal(s.actualIncome, 6000)
})

test('an item whose category is gone counts as expense rather than vanishing', () => {
  const d = doc()
  d.items.push(makeItem({ categoryId: 'missing', name: 'Orphan', order: 9, planned: Array(12).fill(1) }))
  assert.equal(summarize(d).plannedExpense, 1212)
})

// --- readVersion ---
test('reads and validates a version', async () => {
  const text = JSON.stringify(doc())
  const api = { getFileAt: async () => ({ content: text, size: text.length }) }
  const out = await readVersion(cfg, 'abc', api)
  assert.equal(out.error, undefined)
  assert.equal(out.summary.items, 2)
  assert.equal(out.data.year, 2026)
})

test('unreadable or invalid versions explain themselves instead of throwing', async () => {
  const bad = await readVersion(cfg, 'a', { getFileAt: async () => ({ content: 'not json', size: 8 }) })
  assert.match(bad.error, /not readable JSON/)

  const wrong = await readVersion(cfg, 'a', { getFileAt: async () => ({ content: '{"nope":true}', size: 13 }) })
  assert.match(wrong.error, /not a valid budget document/)

  const gone = await readVersion(cfg, 'a', { getFileAt: async () => ({ content: null, size: 0 }) })
  assert.match(gone.error, /does not contain this file/)
})

// --- compareToCurrent ---
test('names what a restore would drop', () => {
  const older = summarize(doc())
  const current = doc()
  current.items.push(makeItem({ categoryId: current.categories[0].id, name: 'New', order: 5 }))
  current.transactions.push({ id: 't2', itemId: current.items[0].id, date: '2026-02-01', amount: 5, desc: 'x' })

  const cmp = compareToCurrent(older, current)
  assert.deepEqual(cmp.losses, ['1 line item', '1 transaction'])
  assert.equal(cmp.yearMismatch, false)
})

test('a version with more in it than the current document loses nothing', () => {
  const fat = summarize(doc())
  const thin = emptyData(2026)
  assert.deepEqual(compareToCurrent(fat, thin).losses, [])
})

test('pluralises the losses it names', () => {
  const older = summarize(emptyData(2026))
  const current = doc()
  assert.deepEqual(compareToCurrent(older, current).losses, ['2 categories', '2 line items', '1 transaction'])
})

test('restoring one year over another is flagged', () => {
  assert.equal(compareToCurrent(summarize(doc(2026)), doc(2027)).yearMismatch, true)
  assert.equal(compareToCurrent(summarize(doc(2026)), doc(2026)).yearMismatch, false)
})

test('a version\'s transactions survive being read back', async () => {
  const text = JSON.stringify(doc())
  const out = await readVersion(cfg, 'abc', { getFileAt: async () => ({ content: text, size: text.length }) })
  assert.equal(out.summary.transactions, 1)
  assert.equal(out.data.transactions[0].desc, 'Bank')
})
