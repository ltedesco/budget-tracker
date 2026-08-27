// Data model, validation and merge for the annual budget.
//
// The document is a 12-month grid, not a transaction list:
//
//   { version, year, startingBalance, startingBalanceAt,
//     categories: [{ id, kind, name, order, updatedAt }],
//     items:      [{ id, categoryId, name, order,
//                    planned: [12], actual: [12], fieldsAt: {}, updatedAt }],
//     deleted:    [{ id, at }] }
//
// A month cell is `null` (nothing entered) or a number. The distinction is
// real: a blank actual means "not recorded yet", a 0 means "spent nothing",
// and variance should not treat those the same.
//
// `fieldsAt` is a SPARSE map of field key -> ISO timestamp. Only fields that
// were actually edited appear in it. This is what lets two devices edit the
// same row without one clobbering the other: change January on a phone and
// March on a laptop, and the merge keeps both, because the unit of conflict
// is the cell rather than the row.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const KINDS = ['expense', 'income']

/** The layer being edited/shown. Kept here so tests and UI agree on spelling. */
export const LAYERS = ['planned', 'actual']

export const nowISO = () => new Date().toISOString()

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 8)
  return Math.random().toString(36).slice(2, 10)
}

export const emptyMonths = () => Array(12).fill(null)

/**
 * Parse a cell. Empty/blank -> null. Accepts "$1,200.50", "(45)" for negative,
 * and bare numbers. Returns null for anything unparseable so a typo clears the
 * cell rather than writing NaN into the document.
 */
export function toCell(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (raw === '') return null
  const negated = /^\(.*\)$/.test(raw)
  const n = parseFloat(raw.replace(/[$,\s()]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round((negated ? -n : n) * 100) / 100
}

/** Sum a month array, treating blanks as zero. */
export const sumMonths = (months = []) =>
  months.reduce((acc, v) => acc + (Number(v) || 0), 0)

export const currentYear = () => new Date().getFullYear()

// --- construction -----------------------------------------------------------

export const emptyData = (year = currentYear()) => ({
  version: 1,
  year: Number(year),
  startingBalance: 0,
  startingBalanceAt: '',
  categories: [],
  items: [],
  deleted: [],
})

export function makeCategory({ kind, name, order }, at = nowISO()) {
  return { id: newId(), kind, name, order, updatedAt: at }
}

export function makeItem({ categoryId, name, order, planned, actual }, at = nowISO()) {
  return {
    id: newId(),
    categoryId,
    name,
    order,
    planned: normalizeMonths(planned),
    actual: normalizeMonths(actual),
    // What each import source contributed to each month, as
    // { "<monthIndex>": { "<source>": amount } }. `actual` stays the single
    // authoritative figure — this only records how it was arrived at, so one
    // card's re-import can replace its own share without touching another's.
    imported: {},
    fieldsAt: {},
    // Baseline stamp for every field never edited individually. Distinct from
    // updatedAt on purpose — see `stamp()` in the merge section.
    baseAt: at,
    updatedAt: at,
  }
}

/** Coerce anything into exactly 12 cells. */
export function normalizeMonths(input) {
  const out = emptyMonths()
  if (!Array.isArray(input)) return out
  for (let i = 0; i < 12; i++) out[i] = toCell(input[i])
  return out
}

// --- edits ------------------------------------------------------------------
//
// Every write goes through these so `fieldsAt` is always stamped. A write that
// forgets the stamp degrades to row-level last-write-wins, which is exactly the
// clobbering the sparse map exists to prevent.

/** Set a scalar field (name, order, categoryId) on an item. */
export function setItemField(item, key, value, at = nowISO()) {
  return {
    ...item,
    [key]: value,
    fieldsAt: { ...item.fieldsAt, [key]: at },
    updatedAt: at,
  }
}

/** Set one month cell on one layer. */
export function setCell(item, layer, index, value, at = nowISO()) {
  const months = [...normalizeMonths(item[layer])]
  months[index] = toCell(value)
  const next = {
    ...item,
    [layer]: months,
    fieldsAt: { ...item.fieldsAt, [`${layer}.${index}`]: at },
    updatedAt: at,
  }
  // A hand-typed figure replaces whatever the importers had contributed to
  // that cell, rather than being added to it. The next import for a source
  // re-establishes that source's share.
  if (layer === 'actual' && next.imported?.[index] !== undefined) {
    const { [String(index)]: _dropped, ...rest } = next.imported
    next.imported = rest
  }
  return next
}

/** Write the same value across all 12 months of a layer — the common case. */
export function fillRow(item, layer, value, at = nowISO()) {
  const cell = toCell(value)
  const fieldsAt = { ...item.fieldsAt }
  for (let i = 0; i < 12; i++) fieldsAt[`${layer}.${i}`] = at
  return { ...item, [layer]: Array(12).fill(cell), fieldsAt, updatedAt: at }
}

/** Copy a layer onto the other one (e.g. seed actuals from the plan). */
export function copyLayer(item, from, to, at = nowISO()) {
  const months = normalizeMonths(item[from])
  const fieldsAt = { ...item.fieldsAt }
  for (let i = 0; i < 12; i++) fieldsAt[`${to}.${i}`] = at
  return { ...item, [to]: [...months], fieldsAt, updatedAt: at }
}

export const tombstone = (id, at = nowISO()) => ({ id, at })

// --- validation -------------------------------------------------------------

/**
 * Coerce arbitrary parsed JSON into the canonical shape. Returns
 * { ok, data, error }. Import refuses anything without categories[] + items[]
 * rather than silently producing an empty budget.
 */
export function validateData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Not a JSON object.' }
  }
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.items)) {
    return { ok: false, error: 'Missing "categories" and/or "items" arrays.' }
  }

  const categories = raw.categories.map((c, i) => ({
    id: String(c?.id || newId()),
    kind: KINDS.includes(c?.kind) ? c.kind : 'expense',
    name: String(c?.name ?? '').trim(),
    order: Number.isFinite(Number(c?.order)) ? Number(c.order) : i,
    updatedAt: String(c?.updatedAt ?? ''),
  }))

  const known = new Set(categories.map((c) => c.id))

  const items = raw.items.map((it, i) => ({
    id: String(it?.id || newId()),
    categoryId: String(it?.categoryId ?? ''),
    name: String(it?.name ?? '').trim(),
    order: Number.isFinite(Number(it?.order)) ? Number(it.order) : i,
    planned: normalizeMonths(it?.planned),
    actual: normalizeMonths(it?.actual),
    imported: sanitizeImported(it?.imported),
    fieldsAt: sanitizeFieldsAt(it?.fieldsAt),
    baseAt: String(it?.baseAt ?? it?.updatedAt ?? ''),
    updatedAt: String(it?.updatedAt ?? ''),
  }))

  // An item pointing at a category that does not exist would be invisible in
  // every view. Park those in a recovery category instead of dropping them.
  const orphans = items.filter((it) => !known.has(it.categoryId))
  if (orphans.length) {
    const bucket = {
      id: newId(),
      kind: 'expense',
      name: 'Uncategorized',
      order: categories.length,
      updatedAt: '',
    }
    categories.push(bucket)
    for (const o of orphans) o.categoryId = bucket.id
  }

  const deleted = Array.isArray(raw.deleted)
    ? raw.deleted
        .map((t) => ({ id: String(t?.id ?? ''), at: String(t?.at ?? '') }))
        .filter((t) => t.id)
    : []

  const year = Number(raw.year)

  return {
    ok: true,
    data: {
      version: 1,
      year: Number.isFinite(year) && year > 1970 ? year : currentYear(),
      startingBalance: toCell(raw.startingBalance) ?? 0,
      startingBalanceAt: String(raw.startingBalanceAt ?? ''),
      categories,
      items,
      deleted,
    },
  }
}

/** Month -> source -> amount, with anything malformed dropped. */
function sanitizeImported(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [month, sources] of Object.entries(raw)) {
    const idx = Number(month)
    if (!Number.isInteger(idx) || idx < 0 || idx > 11) continue
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) continue
    const clean = {}
    for (const [source, amount] of Object.entries(sources)) {
      const n = Number(amount)
      if (source && Number.isFinite(n)) clean[String(source)] = Math.round(n * 100) / 100
    }
    if (Object.keys(clean).length) out[String(idx)] = clean
  }
  return out
}

/** Keep only string-valued keys; a malformed map must not poison the merge. */
function sanitizeFieldsAt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v) out[String(k)] = v
  }
  return out
}

// --- merge ------------------------------------------------------------------
//
// Two devices write the same file, so a push must never be "whatever I hold".
// Every merge is per-field and commutative: the same two documents produce the
// same result whichever device runs it, and whichever order they arrive in.
//
//   - a row on one side only is kept
//   - a row on both sides merges field by field, later timestamp winning
//   - a tombstone removes a row unless the row was edited after the delete
//
// Ties (identical timestamps, different values) are broken by comparing the
// serialized values. Arbitrary, but deterministic and order-independent, which
// is what actually matters — otherwise two devices could disagree forever.

// The stamp that governs one field. A field with no explicit entry in
// `fieldsAt` has never been edited on its own, so it carries the row's
// baseline stamp — NOT `updatedAt`. Falling back to `updatedAt` would let an
// edit to January win the merge for every other month in the row, which is
// precisely the clobbering `fieldsAt` exists to prevent.
const stamp = (row, key) => row.fieldsAt?.[key] || row.baseAt || ''

function pickField(a, b, key, read) {
  const at = stamp(a, key)
  const bt = stamp(b, key)
  if (at > bt) return read(a)
  if (bt > at) return read(b)
  const av = read(a)
  const bv = read(b)
  if (av === bv) return av
  return JSON.stringify(av) >= JSON.stringify(bv) ? av : bv
}

const SCALAR_ITEM_FIELDS = ['categoryId', 'name', 'order']

/** Merge two versions of the same item, cell by cell. */
export function mergeItem(a, b) {
  const out = {
    id: a.id,
    fieldsAt: {},
    planned: emptyMonths(),
    actual: emptyMonths(),
    baseAt: (a.baseAt || '') >= (b.baseAt || '') ? a.baseAt || '' : b.baseAt || '',
  }

  for (const key of SCALAR_ITEM_FIELDS) {
    out[key] = pickField(a, b, key, (r) => r[key])
    const at = maxStamp(a, b, key)
    if (at) out.fieldsAt[key] = at
  }

  out.imported = {}
  for (const layer of LAYERS) {
    for (let i = 0; i < 12; i++) {
      const key = `${layer}.${i}`
      out[layer][i] = pickField(a, b, key, (r) => normalizeMonths(r[layer])[i])
      const at = maxStamp(a, b, key)
      if (at) out.fieldsAt[key] = at
      // The per-source breakdown belongs to the side that won the figure;
      // taking it from the other one would leave a cell whose parts do not
      // add up to its total.
      if (layer === 'actual') {
        const winner = pickField(a, b, key, (r) => r.imported?.[i])
        if (winner && Object.keys(winner).length) out.imported[String(i)] = { ...winner }
      }
    }
  }

  out.updatedAt = (a.updatedAt || '') >= (b.updatedAt || '') ? a.updatedAt : b.updatedAt
  return out
}

/**
 * The surviving stamp for a field. Only recorded when at least one side had an
 * explicit per-field stamp — otherwise the row-level `updatedAt` still covers
 * it and writing it out would bloat the file with redundant timestamps.
 */
function maxStamp(a, b, key) {
  const av = a.fieldsAt?.[key] || ''
  const bv = b.fieldsAt?.[key] || ''
  const winner = av >= bv ? av : bv
  return winner || ''
}

/** Latest tombstone per id, from both sides. */
function mergeTombstones(a = [], b = []) {
  const latest = new Map()
  for (const t of [...a, ...b]) {
    const prev = latest.get(t.id)
    if (!prev || t.at > prev.at) latest.set(t.id, { id: t.id, at: t.at })
  }
  return [...latest.values()]
}

/**
 * Union by id with a caller-supplied combiner, tombstones applied last.
 * Remote order is preserved and local-only rows append, so both devices
 * converge on the same ordering after one round trip.
 */
function mergeRows(localRows = [], remoteRows = [], tombstones = [], combine) {
  const graves = new Map(tombstones.map((t) => [t.id, t.at]))
  const byId = new Map()
  const order = []

  for (const row of [...remoteRows, ...localRows]) {
    const seen = byId.get(row.id)
    if (!seen) {
      order.push(row.id)
      byId.set(row.id, row)
    } else {
      byId.set(row.id, combine(seen, row))
    }
  }

  return order
    .map((id) => byId.get(id))
    .filter((row) => {
      const at = graves.get(row.id)
      // An edit landing after the delete wins: the row was resurrected on
      // purpose. Equal timestamps favour the delete.
      return at === undefined || (row.updatedAt || '') > at
    })
}

/** Categories are small; whole-row last-write-wins is enough for them. */
function mergeCategory(a, b) {
  if ((a.updatedAt || '') > (b.updatedAt || '')) return a
  if ((b.updatedAt || '') > (a.updatedAt || '')) return b
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b
}

/** Merge two whole documents. Commutative in content; order follows `remote`. */
export function mergeData(local, remote) {
  const deleted = mergeTombstones(local.deleted, remote.deleted)
  const balanceFromLocal =
    (local.startingBalanceAt || '') >= (remote.startingBalanceAt || '')
  const balanceSource =
    (local.startingBalanceAt || '') === (remote.startingBalanceAt || '')
      ? Math.max(local.startingBalance || 0, remote.startingBalance || 0)
      : (balanceFromLocal ? local : remote).startingBalance

  return {
    version: 1,
    // The later-edited document decides the year; equal stamps keep remote's.
    year: remote.year || local.year,
    startingBalance: balanceSource,
    startingBalanceAt: balanceFromLocal
      ? local.startingBalanceAt || remote.startingBalanceAt
      : remote.startingBalanceAt,
    categories: mergeRows(local.categories, remote.categories, deleted, mergeCategory),
    items: mergeRows(local.items, remote.items, deleted, mergeItem),
    deleted,
  }
}
