// Token encryption + the storage guarantee that plaintext never persists.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decryptToken, encryptToken, hasEncryptedToken } from '../src/lib/crypto.js'

const TOKEN = 'github_pat_11ABCDEF0123456789_secretvalue'

test('round-trips a token', async () => {
  const env = await encryptToken(TOKEN, 'correct horse battery staple')
  assert.equal(await decryptToken(env, 'correct horse battery staple'), TOKEN)
})

test('the envelope does not contain the token', async () => {
  const env = await encryptToken(TOKEN, 'pw')
  assert.ok(!JSON.stringify(env).includes('secretvalue'))
  assert.ok(!JSON.stringify(env).includes('github_pat'))
})

test('wrong passphrase is rejected, not silently wrong', async () => {
  const env = await encryptToken(TOKEN, 'right')
  await assert.rejects(() => decryptToken(env, 'wrong'), /Wrong passphrase/)
})

test('a fresh salt and iv each time, so the same input differs', async () => {
  const a = await encryptToken(TOKEN, 'pw')
  const b = await encryptToken(TOKEN, 'pw')
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ct, b.ct)
})

test('a tampered ciphertext fails the tag check', async () => {
  const env = await encryptToken(TOKEN, 'pw')
  const bytes = Buffer.from(env.ct, 'base64')
  bytes[0] ^= 0xff
  await assert.rejects(() => decryptToken({ ...env, ct: bytes.toString('base64') }, 'pw'), /Wrong passphrase/)
})

test('refuses an empty token or passphrase', async () => {
  await assert.rejects(() => encryptToken('', 'pw'), /No token/)
  await assert.rejects(() => encryptToken(TOKEN, ''), /passphrase/)
})

test('rejects an unknown envelope version', async () => {
  await assert.rejects(() => decryptToken({ v: 99 }, 'pw'), /unknown format/)
  await assert.rejects(() => decryptToken(null, 'pw'), /missing/)
})

test('hasEncryptedToken reflects a saved envelope', async () => {
  assert.equal(hasEncryptedToken({}), false)
  assert.equal(hasEncryptedToken({ tokenEnc: null }), false)
  assert.equal(hasEncryptedToken({ tokenEnc: await encryptToken(TOKEN, 'pw') }), true)
})

// --- storage must never write the token to localStorage ---

test('saveSyncConfig strips a plaintext token, and loadSyncConfig ignores one', async () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { loadSyncConfig, saveSyncConfig } = await import('../src/lib/storage.js')

  saveSyncConfig({ owner: 'o', repo: 'r', path: 'p', token: 'github_pat_leak', tokenEnc: { v: 1 } })
  const written = store.get('budget:sync')
  assert.ok(!written.includes('github_pat_leak'), 'plaintext token must not reach localStorage')
  assert.ok(written.includes('tokenEnc'))
  assert.equal(loadSyncConfig().token, undefined)

  // Even if a config on disk somehow carries one, loading must drop it.
  store.set('budget:sync', JSON.stringify({ owner: 'o', token: 'github_pat_old' }))
  assert.equal(loadSyncConfig().token, undefined)
  assert.equal(loadSyncConfig().owner, 'o')
})

// --- setup code (moving sync to a new device) ---

import { makeSetupCode, readSetupCode } from '../src/lib/crypto.js'

const syncWith = async () => ({
  owner: 'ltedesco', repo: 'budget', branch: 'main', path: 'data/budget-data.json',
  tokenEnc: await encryptToken(TOKEN, 'four random words here'),
})

test('setup code round-trips the settings', async () => {
  const code = makeSetupCode(await syncWith())
  const back = readSetupCode(code)
  assert.equal(back.owner, 'ltedesco')
  assert.equal(back.repo, 'budget')
  assert.equal(back.branch, 'main')
  assert.equal(back.path, 'data/budget-data.json')
})

test('setup code carries the token only in encrypted form', async () => {
  const code = makeSetupCode(await syncWith())
  assert.ok(!code.includes('github_pat'))
  assert.ok(!code.includes('secretvalue'))
  // Still needs the passphrase on the other side.
  const back = readSetupCode(code)
  assert.equal(await decryptToken(back.tokenEnc, 'four random words here'), TOKEN)
  await assert.rejects(() => decryptToken(back.tokenEnc, 'guess'), /Wrong passphrase/)
})

test('setup code is one line, so it survives being messaged', async () => {
  const code = makeSetupCode(await syncWith())
  assert.ok(!/\s/.test(code), 'must contain no whitespace')
})

test('tolerates surrounding whitespace from a paste', async () => {
  const code = makeSetupCode(await syncWith())
  assert.equal(readSetupCode(`\n  ${code}  \n`).repo, 'budget')
})

test('refuses junk, a wrong prefix, and a damaged body', async () => {
  assert.throws(() => readSetupCode('hello'), /does not look like/)
  assert.throws(() => readSetupCode(''), /does not look like/)
  assert.throws(() => readSetupCode('budget-setup-v1.!!!not-base64!!!'), /damaged/)
})

test('refuses a code missing settings', () => {
  const bad = 'budget-setup-v1.' + Buffer.from(JSON.stringify({ owner: 'x' })).toString('base64')
  assert.throws(() => readSetupCode(bad), /missing some settings/)
})

test('cannot make a setup code before a token is saved', () => {
  assert.throws(() => makeSetupCode({ owner: 'o', repo: 'r', path: 'p' }), /Save an encrypted token first/)
})
