// GitHub Contents API client — the repo-backed store.
//
// Needs a fine-grained PAT with Contents: read & write on the single data repo.
// The token lives in this browser's localStorage and is never committed.

const API = 'https://api.github.com'

const headers = (token) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
})

const encode = (text) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const decode = (base64) => {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function configErrors({ owner, repo, path, token }) {
  const missing = []
  if (!owner) missing.push('owner')
  if (!repo) missing.push('repo')
  if (!path) missing.push('path')
  if (!token) missing.push('token')
  return missing
}

async function fail(res) {
  let detail = ''
  try {
    detail = (await res.json())?.message || ''
  } catch {
    /* non-JSON error body */
  }
  const hint =
    res.status === 401 ? ' — check the token'
    : res.status === 403 ? ' — token lacks Contents write access to this repo'
    : res.status === 404 ? ' — repo, branch, or path not found (a 404 can also mean the token cannot see this repo)'
    : res.status === 409 ? ' — the file changed on GitHub since it was last pulled'
    : ''
  throw new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ''}${hint}`)
}

/**
 * Read the data file. Returns { content, sha } — or { content: null, sha: null }
 * when the file does not exist yet, so a first push can create it.
 */
export async function getFile(config) {
  const { owner, repo, path, branch, token } = config
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch || 'main')}`
  const res = await fetch(url, { headers: headers(token) })
  if (res.status === 404) return { content: null, sha: null }
  if (!res.ok) await fail(res)
  const body = await res.json()
  if (Array.isArray(body)) throw new Error(`"${path}" is a directory, not a file.`)
  return { content: decode(body.content || ''), sha: body.sha }
}

/**
 * Write the data file. `sha` must be the sha from the last getFile/putFile for
 * an update (GitHub rejects a stale one, which is what stops a silent
 * overwrite of edits made on another device); omit it to create.
 */
export async function putFile(config, text, sha, message) {
  const { owner, repo, path, branch, token } = config
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Update budget data',
      content: encode(text),
      branch: branch || 'main',
      ...(sha ? { sha } : {}),
    }),
  })
  if (!res.ok) await fail(res)
  const body = await res.json()
  return { sha: body.content?.sha, commit: body.commit?.sha }
}

/**
 * Recent commits that touched the data file, newest first. Each entry is a
 * version of the file that can still be read back — this is what makes the
 * repo's history usable as a backup rather than something you need git for.
 *
 * An empty repo answers 409 and a missing path answers 404; neither is an
 * error here, they just mean "no history yet".
 */
export async function listVersions(config, limit = 15) {
  const { owner, repo, path, branch, token } = config
  const url =
    `${API}/repos/${owner}/${repo}/commits` +
    `?path=${encodeURIComponent(path)}` +
    `&sha=${encodeURIComponent(branch || 'main')}` +
    `&per_page=${Math.max(1, Math.min(100, limit))}`
  const res = await fetch(url, { headers: headers(token) })
  if (res.status === 404 || res.status === 409) return []
  if (!res.ok) await fail(res)
  const body = await res.json()
  if (!Array.isArray(body)) return []
  return body.map((c) => ({
    sha: c.sha,
    date: c.commit?.committer?.date || c.commit?.author?.date || '',
    message: String(c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name || c.author?.login || '',
  }))
}

/** Read the data file as it stood at one commit. */
export async function getFileAt(config, ref) {
  const { owner, repo, path, token } = config
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`
  const res = await fetch(url, { headers: headers(token) })
  if (res.status === 404) return { content: null, size: 0 }
  if (!res.ok) await fail(res)
  const body = await res.json()
  if (Array.isArray(body)) throw new Error(`"${path}" is a directory, not a file.`)
  return { content: decode(body.content || ''), size: body.size || 0 }
}

/**
 * The file's size at one commit, without downloading it. Reading each version
 * to size it would move megabytes to fill in a column, so this asks the tree
 * instead. Returns null when the size cannot be had — a missing number must
 * never be the reason the version list fails to appear.
 */
export async function fileSizeAt(config, ref) {
  const { owner, repo, path, token } = config
  const url = `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  try {
    const res = await fetch(url, { headers: headers(token) })
    if (!res.ok) return null
    const body = await res.json()
    const hit = (body.tree || []).find((n) => n.path === path)
    return typeof hit?.size === 'number' ? hit.size : null
  } catch {
    return null
  }
}
