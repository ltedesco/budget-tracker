import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCategory, makeItem, mergeData, mergeItem, setCell, setItemField,
  fillRow, emptyData, validateData, toCell, normalizeMonths,
} from '../src/lib/model.js'

const BORN = '2026-01-01T00:00:00.000Z'

const doc = (over = {}) => ({ ...emptyData(2026), ...over })

const itemWith = (over = {}, at = BORN) =>
  ({ ...makeItem({ categoryId: 'c1', name: 'Rent', order: 0 }, at), ...over })

test('two devices editing different months both survive', () => {
  const base = itemWith()
  const phone = setCell(base, 'planned', 0, '100', '2026-02-01T00:00:00Z')
  const laptop = setCell(base, 'planned', 6, '250', '2026-03-01T00:00:00Z')

  const merged = mergeItem(phone, laptop)
  assert.equal(merged.planned[0], 100)
  assert.equal(merged.planned[6], 250)
})

test('merge is commutative', () => {
  const base = itemWith()
  const a = setCell(setCell(base, 'planned', 1, '10', '2026-02-01T00:00:00Z'), 'actual', 1, '12', '2026-02-02T00:00:00Z')
  const b = setItemField(setCell(base, 'planned', 5, '50', '2026-04-01T00:00:00Z'), 'name', 'Mortgage', '2026-05-01T00:00:00Z')

  assert.deepEqual(mergeItem(a, b), mergeItem(b, a))
})

test('an edit elsewhere in the row does not clobber untouched cells', () => {
  // The regression this whole design exists for: without a per-field baseline,
  // the later row-level updatedAt would win every cell in the row.
  const base = fillRow(itemWith(), 'planned', '500', BORN)
  const phone = setCell(base, 'planned', 0, '999', '2026-02-01T00:00:00Z')
  const laptop = setItemField(base, 'name', 'Renamed', '2026-09-01T00:00:00Z')

  const merged = mergeItem(phone, laptop)
  assert.equal(merged.name, 'Renamed')
  assert.equal(merged.planned[0], 999, 'January edit must survive a later rename')
  assert.equal(merged.planned[3], 500, 'untouched months keep their value')
})

test('later edit to the same cell wins', () => {
  const base = itemWith()
  const early = setCell(base, 'planned', 2, '10', '2026-02-01T00:00:00Z')
  const late = setCell(base, 'planned', 2, '80', '2026-08-01T00:00:00Z')
  assert.equal(mergeItem(early, late).planned[2], 80)
  assert.equal(mergeItem(late, early).planned[2], 80)
})

test('planned and actual are independent layers', () => {
  const base = itemWith()
  const a = setCell(base, 'planned', 3, '300', '2026-04-01T00:00:00Z')
  const b = setCell(base, 'actual', 3, '275', '2026-05-01T00:00:00Z')
  const merged = mergeItem(a, b)
  assert.equal(merged.planned[3], 300)
  assert.equal(merged.actual[3], 275)
})

test('a deleted line item stays deleted', () => {
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 }, BORN)
  const item = itemWith({ categoryId: cat.id })
  const local = doc({
    categories: [cat], items: [],
    deleted: [{ id: item.id, at: '2026-06-01T00:00:00Z' }],
  })
  const remote = doc({ categories: [cat], items: [item] })

  assert.equal(mergeData(local, remote).items.length, 0)
  assert.equal(mergeData(remote, local).items.length, 0)
})

test('an edit after the delete resurrects the row', () => {
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 }, BORN)
  const item = setCell(itemWith({ categoryId: cat.id }), 'planned', 0, '5', '2026-07-01T00:00:00Z')
  const local = doc({ categories: [cat], items: [], deleted: [{ id: item.id, at: '2026-06-01T00:00:00Z' }] })
  const remote = doc({ categories: [cat], items: [item] })

  assert.equal(mergeData(local, remote).items.length, 1)
})

test('deleting a category on one device removes it on both', () => {
  const cat = makeCategory({ kind: 'expense', name: 'Pets', order: 0 }, BORN)
  const local = doc({ categories: [], deleted: [{ id: cat.id, at: '2026-06-01T00:00:00Z' }] })
  const remote = doc({ categories: [cat] })
  assert.equal(mergeData(local, remote).categories.length, 0)
})

test('the later starting balance wins', () => {
  const local = doc({ startingBalance: 500, startingBalanceAt: '2026-02-01T00:00:00Z' })
  const remote = doc({ startingBalance: 4200, startingBalanceAt: '2026-05-01T00:00:00Z' })
  assert.equal(mergeData(local, remote).startingBalance, 4200)
  assert.equal(mergeData(remote, local).startingBalance, 4200)
})

test('merging is stable — merging twice changes nothing', () => {
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 }, BORN)
  const a = doc({ categories: [cat], items: [setCell(itemWith({ categoryId: cat.id }), 'planned', 0, '1', '2026-02-01T00:00:00Z')] })
  const b = doc({ categories: [cat], items: [setCell(itemWith({ categoryId: cat.id }), 'planned', 1, '2', '2026-03-01T00:00:00Z')] })
  const once = mergeData(a, b)
  assert.deepEqual(mergeData(once, once), once)
})

test('blank and zero stay different', () => {
  assert.equal(toCell(''), null)
  assert.equal(toCell('0'), 0)
  assert.equal(toCell('   '), null)
  assert.equal(normalizeMonths([null, 0, '', '5'])[0], null)
  assert.equal(normalizeMonths([null, 0, '', '5'])[1], 0)
  assert.equal(normalizeMonths([null, 0, '', '5'])[3], 5)
})

test('currency formats and negatives parse', () => {
  assert.equal(toCell('$1,200.00'), 1200)
  assert.equal(toCell('(45)'), -45)
  assert.equal(toCell('-45'), -45)
  assert.equal(toCell('nonsense'), null)
})

test('validate rejects a document with no arrays', () => {
  assert.equal(validateData({ year: 2026 }).ok, false)
  assert.equal(validateData(null).ok, false)
  assert.equal(validateData([]).ok, false)
})

test('validate rehomes items whose category is missing', () => {
  const result = validateData({
    year: 2026,
    categories: [],
    items: [{ id: 'x', categoryId: 'gone', name: 'Orphan', planned: [], actual: [] }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.categories.length, 1)
  assert.equal(result.data.categories[0].name, 'Uncategorized')
  assert.equal(result.data.items[0].categoryId, result.data.categories[0].id)
})

test('validate always produces exactly twelve months', () => {
  const result = validateData({
    year: 2026,
    categories: [{ id: 'c', kind: 'expense', name: 'X' }],
    items: [{ id: 'i', categoryId: 'c', name: 'Y', planned: [1, 2, 3], actual: null }],
  })
  assert.equal(result.data.items[0].planned.length, 12)
  assert.equal(result.data.items[0].actual.length, 12)
  assert.equal(result.data.items[0].planned[2], 3)
  assert.equal(result.data.items[0].planned[11], null)
})
