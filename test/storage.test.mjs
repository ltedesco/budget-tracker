import test from 'node:test'
import assert from 'node:assert/strict'

/** A localStorage good enough to exercise the real code paths. */
function fakeStorage() {
  const store = new Map()
  return {
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  }
}

const doc = (year, items = 1) => JSON.stringify({
  version: 1,
  year,
  startingBalance: 500,
  categories: [{ id: 'c1', kind: 'expense', name: 'Everyday', order: 0 }],
  items: Array.from({ length: items }, (_, i) => ({
    id: `i${i}`, categoryId: 'c1', name: `Item ${i}`, order: i,
    planned: Array(12).fill(100), actual: Array(12).fill(null),
  })),
  transactions: [],
  deleted: [],
})

const fresh = async () => {
  globalThis.localStorage = fakeStorage()
  globalThis.sessionStorage = fakeStorage()
  // Cache-bust so each test gets a module bound to this storage.
  return import(`../src/lib/storage.js?t=${Math.random()}`)
}

test('a legacy document moves onto its year key', async () => {
  const s = await fresh()
  localStorage.setItem('budget:data', doc(2026, 3))
  assert.equal(s.migrateLegacyYear(), 2026)
  assert.equal(localStorage.getItem('budget:data'), null)
  assert.equal(s.loadLocal(2026).items.length, 3)
})

test('an empty document never creates a year key', async () => {
  const s = await fresh()
  // This is the placeholder that caused real data to be deleted: the app saved
  // an empty 2026 on first load, migration saw the key was taken, skipped the
  // copy, and removed the source anyway.
  const { emptyData } = await import('../src/lib/model.js')
  assert.equal(s.saveLocal(emptyData(2026)), false)
  assert.equal(localStorage.getItem('budget:data:2026'), null)
})

test('an empty placeholder does not block the migration', async () => {
  const s = await fresh()
  const { emptyData } = await import('../src/lib/model.js')
  // Force the placeholder in, as an older build would have written it.
  localStorage.setItem('budget:data:2026', JSON.stringify(emptyData(2026)))
  localStorage.setItem('budget:data', doc(2026, 5))

  assert.equal(s.migrateLegacyYear(), 2026)
  assert.equal(s.loadLocal(2026).items.length, 5, 'the real document wins over the placeholder')
})

test('a year holding real data is never overwritten, and the old copy is kept', async () => {
  const s = await fresh()
  localStorage.setItem('budget:data:2026', doc(2026, 9))
  localStorage.setItem('budget:data', doc(2026, 4))

  s.migrateLegacyYear()
  assert.equal(s.loadLocal(2026).items.length, 9, 'the existing year is untouched')
  assert.ok(localStorage.getItem('budget:data:legacy-backup'), 'the other document is set aside, not deleted')
  assert.equal(localStorage.getItem('budget:data'), null)
})

test('an existing year can still be emptied deliberately', async () => {
  const s = await fresh()
  const { emptyData } = await import('../src/lib/model.js')
  localStorage.setItem('budget:data:2026', doc(2026, 2))
  assert.equal(s.saveLocal(emptyData(2026)), true)
  assert.equal(s.loadLocal(2026).items.length, 0)
})

test('years are listed newest first, ignoring other keys', async () => {
  const s = await fresh()
  localStorage.setItem('budget:data:2026', doc(2026))
  localStorage.setItem('budget:data:2028', doc(2028))
  localStorage.setItem('budget:data:2027', doc(2027))
  localStorage.setItem('budget:data:legacy-backup', doc(2020))
  localStorage.setItem('budget:sync', '{}')
  assert.deepEqual(s.knownYears(), [2028, 2027, 2026])
})

test('the active year survives a reload, and falls back when unset', async () => {
  const s = await fresh()
  assert.equal(s.loadActiveYear(2026), 2026)
  s.saveActiveYear(2027)
  assert.equal(s.loadActiveYear(2026), 2027)
})

test('each year addresses its own file', async () => {
  const s = await fresh()
  assert.equal(s.pathForYear('data/budget-{year}.json', 2027), 'data/budget-2027.json')
  assert.equal(s.pathForYear('data/budget-data.json', 2027), 'data/budget-data.json')
  assert.equal(s.isSingleYearPath('data/budget-data.json'), true)
  assert.equal(s.isSingleYearPath('data/budget-{year}.json'), false)
})
