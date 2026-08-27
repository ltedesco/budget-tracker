// The app lock: real encryption at rest, and the rails that stop it eating
// the data it is meant to protect.
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { webcrypto } from 'node:crypto'

// A localStorage stand-in, installed before the modules under test load.
const store = new Map()
globalThis.localStorage = {
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
  clear: () => store.clear(),
}
if (!globalThis.crypto) globalThis.crypto = webcrypto

const vault = await import('../src/lib/vault.js')
const { loadLocal, saveLocal, knownYears } = await import('../src/lib/storage.js')
const { emptyData, makeCategory, makeItem } = await import('../src/lib/model.js')

const PASS = 'correct horse battery'

function doc(year, planned = 1000) {
  const d = emptyData(year)
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 }); cat.id = 'c1'
  d.categories = [cat]
  d.items = [makeItem({ categoryId: 'c1', name: 'Mortgage', order: 0, planned: Array(12).fill(planned) })]
  d.items[0].id = 'i1'
  d.startingBalance = 10500
  return d
}

const put = (year, d) => store.set(`budget:data:${year}`, JSON.stringify(d))
const raw = (year) => store.get(`budget:data:${year}`)

beforeEach(() => { store.clear(); vault.resetForTests() })

// --- enabling ---
test('enabling encrypts every year in place', async () => {
  put(2026, doc(2026)); put(2027, doc(2027, 2000))
  assert.ok(raw(2026).includes('Mortgage'), 'starts as plain text')

  await vault.enableLock(PASS)

  assert.ok(!raw(2026).includes('Mortgage'), '2026 must be ciphertext')
  assert.ok(!raw(2027).includes('Mortgage'), '2027 must be ciphertext')
  assert.ok(!raw(2026).includes('10500'), 'the balance must not be readable')
  assert.deepEqual(JSON.parse(raw(2026)).v, 1)
  assert.ok(vault.isLockEnabled() && vault.isUnlocked())
})

test('the passcode itself is never stored', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  assert.ok(!JSON.stringify([...store.entries()]).includes(PASS))
})

test('two locks with the same passcode produce different ciphertext', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  const first = raw(2026)
  vault.resetForTests(); store.delete('budget:lock'); put(2026, doc(2026))
  await vault.enableLock(PASS)
  assert.notEqual(first, raw(2026), 'a fresh salt and IV each time')
})

// --- unlocking ---
test('the right passcode returns every year intact', async () => {
  put(2026, doc(2026)); put(2027, doc(2027, 2000))
  await vault.enableLock(PASS)
  vault.lock()

  assert.equal(vault.isSealed(), true)
  const years = await vault.unlock(PASS)
  assert.deepEqual(years, [2027, 2026])
  assert.equal(vault.cachedDoc(2026).items[0].planned[0], 1000)
  assert.equal(vault.cachedDoc(2027).items[0].planned[0], 2000)
  assert.equal(vault.cachedDoc(2026).startingBalance, 10500)
})

test('a wrong passcode is refused and leaves the vault shut', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  vault.lock()
  await assert.rejects(vault.unlock('not the passcode'), /passcode is not right/)
  assert.equal(vault.isUnlocked(), false)
  assert.equal(vault.cachedDoc(2026), null)
})

test('a near-miss passcode is still a wrong passcode', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  vault.lock()
  await assert.rejects(vault.unlock(PASS + ' '), /not right/)
  await assert.rejects(vault.unlock(PASS.toUpperCase()), /not right/)
})

// --- the rails that protect the data ---
test('a sealed app cannot overwrite the ciphertext', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  const sealedCiphertext = raw(2026)
  vault.lock()

  // Exactly the sequence that would destroy everything: a sealed load hands
  // back an empty document, and something tries to save it.
  const seen = loadLocal(2026)
  assert.equal(seen.items.length, 0, 'a sealed read must not reveal anything')
  assert.equal(saveLocal(seen), false, 'and must not be writable')
  assert.equal(raw(2026), sealedCiphertext, 'the ciphertext is untouched')

  await vault.unlock(PASS)
  assert.equal(loadLocal(2026).items.length, 1, 'the real document is still there')
})

test('a sealed app reports no years rather than guessing', async () => {
  put(2026, doc(2026)); put(2027, doc(2027))
  await vault.enableLock(PASS)
  vault.lock()
  assert.deepEqual(knownYears(), [])
  await vault.unlock(PASS)
  assert.deepEqual(knownYears(), [2027, 2026])
})

test('saving while unlocked keeps storage encrypted', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)

  const next = { ...vault.cachedDoc(2026), startingBalance: 777 }
  assert.equal(saveLocal(next), true)
  await vault.persist(2026, next)

  assert.ok(!raw(2026).includes('777'), 'the new figure must not be readable either')
  vault.lock()
  await vault.unlock(PASS)
  assert.equal(vault.cachedDoc(2026).startingBalance, 777, 'but it did persist')
})

test('one unreadable year does not cost the others', async () => {
  put(2026, doc(2026)); put(2027, doc(2027))
  await vault.enableLock(PASS)
  const corrupted = JSON.parse(raw(2027))
  corrupted.ct = 'AAAA' + corrupted.ct.slice(4)
  store.set('budget:data:2027', JSON.stringify(corrupted))
  vault.lock()

  const years = await vault.unlock(PASS)
  assert.deepEqual(years, [2026], '2026 still opens')
  assert.equal(vault.cachedDoc(2026).items[0].planned[0], 1000)
  assert.ok(raw(2027), 'and the damaged year is left in place, not deleted')
})

// --- disabling ---
test('turning it off writes plain documents back', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  await vault.disableLock()
  assert.ok(raw(2026).includes('Mortgage'))
  assert.equal(vault.isLockEnabled(), false)
  assert.equal(loadLocal(2026).items[0].name, 'Mortgage')
})

test('it cannot be turned off without unlocking first', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  vault.lock()
  await assert.rejects(vault.disableLock(), /Unlock first/)
  assert.equal(vault.isLockEnabled(), true, 'a forgotten passcode is not an escape hatch')
})

test('enabling twice is refused rather than re-encrypting ciphertext', async () => {
  put(2026, doc(2026))
  await vault.enableLock(PASS)
  await assert.rejects(vault.enableLock('another one'), /already on/)
})

test('an empty passcode is refused', async () => {
  await assert.rejects(vault.enableLock(''), /Choose a passcode/)
})

test('with the lock off, storage behaves exactly as before', () => {
  const d = doc(2026)
  assert.equal(saveLocal(d), true)
  assert.ok(raw(2026).includes('Mortgage'))
  assert.equal(loadLocal(2026).items[0].name, 'Mortgage')
  assert.deepEqual(knownYears(), [2026])
})
