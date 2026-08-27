// Off-GitHub backups: the copy that survives losing the GitHub account.
//
// The repo's own history covers accident — a bad import, a wiped device. It
// does not cover the account going away, and it does not cover someone with
// the token, because Contents: write also grants force-push: a stolen token
// can rewrite the history the restore panel reads from. The only answer to
// either is a copy that is not on GitHub at all.
//
// A file the user forgot to make is not a backup, so the age is tracked and
// said out loud rather than left to memory.

/** A restorable copy of one year. Same shape the importer accepts. */
export const backupText = (data) =>
  JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)

export const backupFilename = (year, at = new Date()) =>
  `budget-${year}-backup-${at.toISOString().slice(0, 10)}.json`

export const STALE_DAYS = 30

const DAY = 86400000

/**
 * Tracked per year, because a backup is one year's document. Saying a budget
 * is backed up when the copy on disk is last year's would be worse than
 * saying nothing.
 */
export function backupState(prefs, year, now = Date.now()) {
  const at = (prefs?.lastBackupAt || {})[year]
  const then = at ? new Date(at).getTime() : NaN
  if (!at || Number.isNaN(then)) return { status: 'never', days: null, at: null }
  const days = Math.max(0, Math.floor((now - then) / DAY))
  return { status: days >= STALE_DAYS ? 'stale' : 'fresh', days, at }
}

/** Stamp a year as backed up. Returns the new prefs; does not mutate. */
export function recordBackup(prefs, year, at = new Date().toISOString()) {
  return { ...prefs, lastBackupAt: { ...(prefs?.lastBackupAt || {}), [year]: at } }
}

export function backupMessage(state, year) {
  if (state.status === 'never') {
    return `No off-GitHub copy of ${year} yet. If the GitHub account went away, so would this budget.`
  }
  if (state.status === 'stale') {
    const months = Math.round(state.days / 30)
    return `Last off-GitHub copy of ${year} was ${
      state.days < 45 ? `${state.days} days` : months === 1 ? 'a month' : `${months} months`
    } ago.`
  }
  return `Off-GitHub copy of ${year} saved ${state.days === 0 ? 'today' : `${state.days} day${state.days === 1 ? '' : 's'} ago`}.`
}
