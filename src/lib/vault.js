// App lock: the passcode gate in front of the whole app.
//
// The point of a lock screen is that there is nothing behind it to show. A
// screen that merely hides a rendered app is a curtain — the figures still sit
// in localStorage in the clear, and anyone who opens devtools, or types the
// storage key into a console, walks straight past it. So the lock is the
// encryption, not the screen: while it is on, every year's document is stored
// as an AES-GCM envelope and the app genuinely has nothing to render until the
// passcode decrypts one.
//
// The key is derived once at unlock (310,000 PBKDF2 rounds) and kept in memory
// for the tab. Documents are held decrypted in a cache so the rest of the app
// can keep reading them synchronously; only the write back to localStorage is
// asynchronous, and it is serialised per year so two quick edits cannot land
// out of order.

import { decryptWith, encryptWith, isEnvelope, keyFor, randomSaltB64 } from './crypto.js'

const LOCK_KEY = 'budget:lock'
// Encrypting a known string gives a passcode check that needs no document:
// AES-GCM is authenticated, so a wrong passphrase fails to decrypt rather than
// returning rubbish.
const CANARY = 'trueline-lock-v1'

let key = null // CryptoKey once unlocked; never persisted
let cache = null // { [year]: document } in the clear, in memory only
let writing = Promise.resolve() // serialises writes so saves cannot race

export function lockConfig() {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const isLockEnabled = () => Boolean(lockConfig()?.salt)
export const isUnlocked = () => key !== null
/** True when the app must show the lock screen instead of the budget. */
export const isSealed = () => isLockEnabled() && !isUnlocked()

export const cachedYears = () =>
  cache ? Object.keys(cache).map(Number).sort((a, b) => b - a) : []

export const cachedDoc = (year) => cache?.[year] ?? null

export function putCached(year, doc) {
  if (!cache) return false
  cache[year] = doc
  return true
}

const dataKeys = () => {
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && /^budget:data:\d{4}$/.test(k)) keys.push(k)
  }
  return keys
}

const yearOf = (storageKey) => Number(storageKey.split(':').pop())

/** Encrypt one year back to localStorage. Serialised; failures surface. */
export function persist(year, doc) {
  if (!key) return Promise.reject(new Error('The app is locked.'))
  writing = writing.then(async () => {
    const envelope = await encryptWith(key, JSON.stringify(doc))
    localStorage.setItem(`budget:data:${year}`, JSON.stringify(envelope))
  })
  return writing
}

/**
 * Turn the lock on: derive a key, encrypt every year in place, and leave the
 * app unlocked. Any year that fails to encrypt aborts the whole thing with
 * the plaintext untouched — a half-encrypted store is the one outcome worth
 * more than the inconvenience of refusing.
 */
export async function enableLock(passphrase) {
  if (!passphrase) throw new Error('Choose a passcode first.')
  if (isLockEnabled()) throw new Error('The app lock is already on.')

  const salt = randomSaltB64()
  const derived = await keyFor(passphrase, salt)

  const docs = []
  for (const storageKey of dataKeys()) {
    const raw = localStorage.getItem(storageKey)
    if (!raw) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Could not read ${storageKey}, so the lock was not turned on.`)
    }
    if (isEnvelope(parsed)) continue // already encrypted; nothing to do
    docs.push([storageKey, parsed, await encryptWith(derived, JSON.stringify(parsed))])
  }

  // Every document encrypted successfully. Only now write anything.
  const check = await encryptWith(derived, CANARY)
  for (const [storageKey, , envelope] of docs) {
    localStorage.setItem(storageKey, JSON.stringify(envelope))
  }
  localStorage.setItem(LOCK_KEY, JSON.stringify({ v: 1, salt, check }))

  key = derived
  cache = Object.fromEntries(docs.map(([storageKey, doc]) => [yearOf(storageKey), doc]))
  return cachedYears()
}

/**
 * Unlock. Throws on a wrong passcode, which is the authenticated decryption
 * failing rather than a string comparison.
 */
export async function unlock(passphrase) {
  const config = lockConfig()
  if (!config?.salt) throw new Error('The app lock is not on.')
  const derived = await keyFor(passphrase, config.salt)
  try {
    const opened = await decryptWith(derived, config.check)
    if (opened !== CANARY) throw new Error('bad canary')
  } catch {
    throw new Error('That passcode is not right.')
  }

  const next = {}
  for (const storageKey of dataKeys()) {
    const raw = localStorage.getItem(storageKey)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      // A plaintext document here means the lock was turned on while this
      // year was not present. Take it as it is; the next save encrypts it.
      next[yearOf(storageKey)] = isEnvelope(parsed)
        ? JSON.parse(await decryptWith(derived, parsed))
        : parsed
    } catch {
      // One unreadable year must not cost the others. Leave its ciphertext
      // exactly where it is rather than dropping it.
      continue
    }
  }
  key = derived
  cache = next
  return cachedYears()
}

/** Forget the key and every decrypted document. The ciphertext stays put. */
export function lock() {
  key = null
  cache = null
}

/**
 * Turn the lock off: decrypt everything back to plain documents. Needs to be
 * unlocked already, so a forgotten passcode cannot be escaped this way.
 */
export async function disableLock() {
  if (!key) throw new Error('Unlock first.')
  for (const [year, doc] of Object.entries(cache || {})) {
    localStorage.setItem(`budget:data:${year}`, JSON.stringify(doc))
  }
  localStorage.removeItem(LOCK_KEY)
  key = null
  cache = null
  return true
}

/** Test seam: drop all in-memory state without touching storage. */
export function resetForTests() {
  key = null
  cache = null
  writing = Promise.resolve()
}
