// Local persistence. Every change lands here first; GitHub sync is what makes
// it survive a cleared cache and follow you between devices.

import { emptyData, validateData } from './model.js'

const DATA_KEY = 'budget:data'
const SYNC_KEY = 'budget:sync'
// The unlocked token lives in sessionStorage, not localStorage: it dies with
// the tab instead of sitting on a shared origin indefinitely.
const TOKEN_KEY = 'budget:token'
const PREFS_KEY = 'budget:prefs'

export function loadLocal() {
  try {
    const raw = localStorage.getItem(DATA_KEY)
    if (!raw) return emptyData()
    const result = validateData(JSON.parse(raw))
    return result.ok ? result.data : emptyData()
  } catch {
    return emptyData()
  }
}

export function saveLocal(data) {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

export const defaultSyncConfig = () => ({
  owner: '',
  repo: '',
  branch: 'main',
  path: 'data/budget-data.json',
  // Only the encrypted envelope is persisted; the token itself never is.
  tokenEnc: null,
  autoPush: false,
})

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return defaultSyncConfig()
    const { token, ...saved } = JSON.parse(raw)
    return { ...defaultSyncConfig(), ...saved }
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
