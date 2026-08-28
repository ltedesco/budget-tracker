// Local persistence. Every change lands here first; GitHub sync is what makes
// it survive a cleared cache and follow you between devices.

import { emptyData, validateData } from './model.js'
import * as vault from './vault.js'

// One key per year. Each year is its own document, mirroring the one-file-per-
// year layout on GitHub: a year stays about 100 KB however many accumulate, and
// an edit only ever rewrites the year being edited rather than all of history.
const DATA_KEY = 'budget:data'
const dataKey = (year) => `${DATA_KEY}:${year}`
const YEAR_KEY = 'budget:year'
const SYNC_KEY = 'budget:sync'
// The unlocked token lives in sessionStorage, not localStorage: it dies with
// the tab instead of sitting on a shared origin indefinitely.
const TOKEN_KEY = 'budget:token'
const PREFS_KEY = 'budget:prefs'

export function loadLocal(year) {
  // With the lock on, localStorage holds ciphertext. Reading it here would
  // fail validation and hand back an empty document, which the next save would
  // then write over the real one — so the cache is the only source while
  // locked, and a sealed app must never get this far.
  if (vault.isLockEnabled()) {
    if (!vault.isUnlocked()) return emptyData(year)
    return vault.cachedDoc(year) || emptyData(year)
  }
  try {
    const raw = localStorage.getItem(dataKey(year))
    if (!raw) return emptyData(year)
    const result = validateData(JSON.parse(raw))
    return result.ok ? result.data : emptyData(year)
  } catch {
    return emptyData(year)
  }
}

const isEmptyDoc = (d) =>
  !d.categories?.length && !d.items?.length && !(d.transactions || []).length && !d.startingBalance

export function saveLocal(data) {
  try {
    // Never CREATE a key holding an empty document. An empty placeholder at a
    // year's key is what made a legacy migration think that year was already
    // taken, skip the copy, and then delete the source — losing everything.
    // Emptying a year that already exists is still allowed.
    if (isEmptyDoc(data) && !localStorage.getItem(dataKey(data.year))) return false

    if (vault.isLockEnabled()) {
      // The hard rail. A sealed app holds no key, so anything it thinks it
      // has is empty state — writing that would encrypt nothing over
      // everything. Refuse rather than destroy.
      if (!vault.isUnlocked()) return false
      vault.putCached(data.year, data)
      vault.persist(data.year, data).catch(() => {})
      return true
    }

    localStorage.setItem(dataKey(data.year), JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/** Which years this browser holds, newest first. */
export function knownYears() {
  if (vault.isLockEnabled()) return vault.isUnlocked() ? vault.cachedYears() : []
  try {
    const years = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      const match = key && key.match(new RegExp(`^${DATA_KEY}:(\\d{4})$`))
      if (match) years.push(Number(match[1]))
    }
    return years.sort((a, b) => b - a)
  } catch {
    return []
  }
}

export function loadActiveYear(fallback) {
  try {
    const stored = Number(localStorage.getItem(YEAR_KEY))
    if (Number.isInteger(stored) && stored > 1970) return stored
  } catch { /* no storage */ }
  return fallback
}

export function saveActiveYear(year) {
  try {
    localStorage.setItem(YEAR_KEY, String(year))
    return true
  } catch {
    return false
  }
}

/**
 * Move a pre-multi-year document onto its year's key. Without this the first
 * load after the upgrade would look like every figure had vanished.
 */
export function migrateLegacyYear() {
  try {
    const raw = localStorage.getItem(DATA_KEY)
    if (!raw) return null
    const result = validateData(JSON.parse(raw))
    if (!result.ok) return null
    const year = result.data.year

    let occupied = false
    const existingRaw = localStorage.getItem(dataKey(year))
    if (existingRaw) {
      try {
        const existing = validateData(JSON.parse(existingRaw))
        occupied = existing.ok && !isEmptyDoc(existing.data)
      } catch {
        occupied = false
      }
    }

    if (!occupied) {
      localStorage.setItem(dataKey(year), raw)
      localStorage.removeItem(DATA_KEY)
      return year
    }

    // The year already holds real data. Rather than choose between two
    // documents — or delete one, which is what a careless version of this did —
    // set the old one aside under a name that says what it is.
    localStorage.setItem(`${DATA_KEY}:legacy-backup`, raw)
    localStorage.removeItem(DATA_KEY)
    return year
  } catch {
    return null
  }
}

export const defaultSyncConfig = () => ({
  owner: '',
  repo: '',
  branch: 'main',
  // {year} is substituted per year, keeping each year in its own file. A path
  // without it still works and addresses a single year, which is what every
  // setup created before multi-year support looks like.
  path: 'data/budget-{year}.json',
  // Only the encrypted envelope is persisted; the token itself never is.
  tokenEnc: null,
  autoPush: false,
  // Where the 1099 tracker keeps its data, and which budget line its payments
  // belong to. Read-only: this app never writes to that repo.
  income1099: {
    owner: '',
    repo: '',
    branch: 'main',
    path: 'data/tracker-data.json',
    itemId: '',
    payers: [],
  },
})

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return defaultSyncConfig()
    const { token, ...saved } = JSON.parse(raw)
    const base = defaultSyncConfig()
    // Merged one level down too, so a config saved before this block existed
    // still comes back with every field present.
    return { ...base, ...saved, income1099: { ...base.income1099, ...(saved.income1099 || {}) } }
  } catch {
    return defaultSyncConfig()
  }
}

export function saveSyncConfig(config) {
  try {
    // Belt and braces: strip any plaintext token before it can be written.
    const { token, ...safe } = config
    localStorage.setItem(SYNC_KEY, JSON.stringify(safe))
    return true
  } catch {
    return false
  }
}

/** UI preferences (active layer, collapsed categories). Not synced. */
export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    return true
  } catch {
    return false
  }
}

/** Unlocked token for this tab only. Cleared when the browser session ends. */
export function loadSessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function saveSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
    return true
  } catch {
    return false
  }
}

/** The file this year lives in. `{year}` is optional, for legacy single-year setups. */
export const pathForYear = (path, year) =>
  String(path || '').replace(/\{year\}/g, String(year))

/** Whether a path addresses one fixed file rather than one file per year. */
export const isSingleYearPath = (path) => !String(path || '').includes('{year}')
