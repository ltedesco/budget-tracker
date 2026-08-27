// Sync controller: the read-merge-write cycle against the GitHub Contents API.
//
// Kept out of App.jsx and free of React so the conflict handling can be tested
// directly, with getFile/putFile stubbed.
//
// The rule: a push never writes what this device happens to hold. It reads the
// file, merges, and writes the union. That makes a 409 (someone committed
// between our read and our write) safe to retry — the retry re-reads and
// re-merges, so the other device's rows survive instead of being overwritten.

import { getFile as ghGetFile, putFile as ghPutFile } from './github.js'
import { mergeData, validateData } from './model.js'

const defaultApi = { getFile: ghGetFile, putFile: ghPutFile }

const isConflict = (e) => /\b409\b|does not match/.test(e?.message || '')

/** Parse the remote file, or null when it does not exist yet. */
function parseRemote(content) {
  if (content === null) return null
  const result = validateData(JSON.parse(content))
  if (!result.ok) throw new Error(`File is not a valid budget document: ${result.error}`)
  return result.data
}

export const serialize = (data) =>
  JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)

/** Merge the remote file into `local`. Does not write. */
export async function pullMerged(config, local, api = defaultApi) {
  const { content, sha } = await api.getFile(config)
  const remote = parseRemote(content)
  if (!remote) return { merged: local, sha: null, existed: false }
  return { merged: mergeData(local, remote), sha, existed: true }
}

/**
 * Read, merge, write. Returns the merged document that is now on GitHub, which
 * the caller should adopt as local state — it may contain rows this device had
 * never seen.
 */
export async function pushMerged(config, local, api = defaultApi, attempts = 3) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    const { content, sha } = await api.getFile(config)
    const remote = parseRemote(content)
    const merged = remote ? mergeData(local, remote) : local
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
