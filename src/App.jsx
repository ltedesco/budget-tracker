import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SummaryTab from './components/SummaryTab.jsx'
import BudgetGrid from './components/BudgetGrid.jsx'
import DataTab from './components/DataTab.jsx'
import Toast from './components/Toast.jsx'
import { configErrors } from './lib/github.js'
import {
  copyLayer, fillRow, makeCategory, makeItem, nowISO, setCell, setItemField, toCell,
} from './lib/model.js'
import { templateData } from './lib/template.js'
import { money } from './lib/format.js'
import { itemsOf } from './lib/summary.js'
import { ensureCatchAll } from './lib/statement.js'
import { pullMerged, pushMerged } from './lib/sync.js'
import { decryptToken, encryptToken, makeSetupCode, readSetupCode } from './lib/crypto.js'
import {
  loadLocal, loadPrefs, loadSessionToken, loadSyncConfig,
  saveLocal, savePrefs, saveSessionToken, saveSyncConfig,
} from './lib/storage.js'

const TABS = [
  ['summary', 'Summary'],
  ['expenses', 'Expenses'],
  ['income', 'Income'],
  ['data', 'Setup & Sync'],
]

const UNDO_MS = 8000
const AUTOPUSH_DEBOUNCE_MS = 3000

/** What a pull actually brought in, for the toast. */
function describe(before, after) {
  const cats = after.categories.length - before.categories.length
  const items = after.items.length - before.items.length
  const changed = JSON.stringify(before.items) !== JSON.stringify(after.items)
  if (cats <= 0 && items <= 0) return changed ? 'Merged changes from GitHub.' : 'Already up to date.'
  const bits = []
  if (cats > 0) bits.push(`${cats} categor${cats === 1 ? 'y' : 'ies'}`)
  if (items > 0) bits.push(`${items} line item${items === 1 ? '' : 's'}`)
  return `Merged in ${bits.join(' and ')} from GitHub.`
}

export default function App() {
  const [data, setData] = useState(loadLocal)
  const [sync, setSyncState] = useState(loadSyncConfig)
  // The token is deliberately not part of `sync`: `sync` is persisted to
  // localStorage, and the whole point is that the token never lands there.
  const [token, setTokenState] = useState(loadSessionToken)
  const [syncStatus, setSyncStatus] = useState({ busy: false, message: '', error: '' })
  const [tab, setTab] = useState('summary')
  const [prefs, setPrefs] = useState(loadPrefs)
  const [toast, setToast] = useState(null)

  const layer = prefs.layer === 'actual' || prefs.layer === 'variance' ? prefs.layer : 'planned'
  const collapsed = prefs.collapsed || {}

  // Mirrors `data` so the action callbacks can read current state without
  // being rebuilt on every keystroke, and without side effects in a setState
  // updater (which StrictMode would double-invoke).
  const dataRef = useRef(data)
  const tokenRef = useRef(token)
  const undoRef = useRef(null)
  const toastTimer = useRef(null)

  useEffect(() => { dataRef.current = data; saveLocal(data) }, [data])
  useEffect(() => { saveSyncConfig(sync) }, [sync])
  useEffect(() => { savePrefs(prefs) }, [prefs])
  useEffect(() => { tokenRef.current = token; saveSessionToken(token) }, [token])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const showToast = useCallback((message, snapshot) => {
    clearTimeout(toastTimer.current)
    undoRef.current = snapshot ?? null
    setToast({ message, undo: Boolean(snapshot) })
    toastTimer.current = setTimeout(() => { setToast(null); undoRef.current = null }, UNDO_MS)
  }, [])

  const dismissToast = useCallback(() => {
    clearTimeout(toastTimer.current)
    setToast(null)
    undoRef.current = null
  }, [])

  const undo = useCallback(() => {
    if (undoRef.current) {
      dataRef.current = undoRef.current
      setData(undoRef.current)
    }
    dismissToast()
  }, [dismissToast])

  /** Single write path. `undoable` snapshots prior state for the toast. */
  const commit = useCallback((next, message, undoable) => {
    const prev = dataRef.current
    dataRef.current = next
    setData(next)
    if (message) showToast(message, undoable ? prev : undefined)
  }, [showToast])

  const setSyncField = useCallback((patch) => {
    setSyncState((s) => ({ ...s, ...patch }))
    setSyncStatus((s) => ({ ...s, message: '', error: '' }))
  }, [])

  // --- GitHub sync ---------------------------------------------------------

  const syncRef = useRef(sync)
  useEffect(() => { syncRef.current = sync }, [sync])

  /** Persisted settings plus the in-memory token — what the API actually needs. */
  const activeConfig = useCallback(() => ({ ...syncRef.current, token: tokenRef.current }), [])

  /**
   * Adopt a merged document. Returns false when nothing changed, which keeps a
   * push from re-triggering auto-push and looping.
   */
  const applyMerged = useCallback((merged, message) => {
    if (JSON.stringify(merged) === JSON.stringify(dataRef.current)) return false
    commit(merged, message)
    return true
  }, [commit])

  const pull = useCallback(async () => {
    const config = activeConfig()
    if (configErrors(config).length) return
    setSyncStatus({ busy: true, message: 'Pulling…', error: '' })
    try {
      const before = dataRef.current
      const { merged, existed } = await pullMerged(config, before)
      if (!existed) {
        setSyncStatus({ busy: false, message: 'No file there yet — push to create it.', error: '' })
        return
      }
      applyMerged(merged, describe(before, merged))
      setSyncStatus({ busy: false, message: `Pulled at ${new Date().toLocaleTimeString()}.`, error: '' })
    } catch (e) {
      setSyncStatus({ busy: false, message: '', error: e.message })
    }
  }, [applyMerged, activeConfig])

  const push = useCallback(async () => {
    const config = activeConfig()
    if (configErrors(config).length) return
    setSyncStatus({ busy: true, message: 'Pushing…', error: '' })
    try {
      // Merged, not local: the file may hold edits this device has never seen.
      const { merged } = await pushMerged(config, dataRef.current)
      applyMerged(merged)
      setSyncStatus({ busy: false, message: `Pushed at ${new Date().toLocaleTimeString()}.`, error: '' })
    } catch (e) {
      setSyncStatus({ busy: false, message: '', error: e.message })
    }
  }, [applyMerged, activeConfig])

  // Auto-push is debounced so a burst of edits produces one commit.
  const skipFirstAutoPush = useRef(true)
  useEffect(() => {
    if (skipFirstAutoPush.current) { skipFirstAutoPush.current = false; return }
    if (!sync.autoPush || configErrors({ ...sync, token }).length) return
    const t = setTimeout(push, AUTOPUSH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [data, sync, token, push])

  // --- data actions --------------------------------------------------------

  const actions = useMemo(() => {
    const d = () => dataRef.current
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

    /** Replace one item, preserving order. */
    const patchItem = (id, fn, message) =>
      commit({ ...d(), items: d().items.map((it) => (it.id === id ? fn(it) : it)) }, message)

    /** A delete leaves a tombstone, or the row returns on the next merge. */
    const withTombstones = (base, ids) => ({
      ...base,
      deleted: [
        ...base.deleted.filter((t) => !ids.includes(t.id)),
        ...ids.map((id) => ({ id, at: nowISO() })),
      ],
    })

    return {
      setCell: (id, activeLayer, index, value) =>
        patchItem(id, (it) => setCell(it, activeLayer, index, value)),

      fillRow: (id, activeLayer, value) =>
        patchItem(id, (it) => fillRow(it, activeLayer, value), 'Filled across all 12 months.'),

      copyPlanToActual: (id) =>
        patchItem(id, (it) => copyLayer(it, 'planned', 'actual'), 'Copied plan into actuals.'),

      renameItem: (id, name) => patchItem(id, (it) => setItemField(it, 'name', name)),

      addItem: (categoryId) => {
        const order = itemsOf(d(), categoryId).length
        commit(
          { ...d(), items: [...d().items, makeItem({ categoryId, name: 'New line item', order })] },
          'Line item added.',
        )
      },

      deleteItem: (id) => {
        const item = d().items.find((it) => it.id === id)
        commit(
          withTombstones({ ...d(), items: d().items.filter((it) => it.id !== id) }, [id]),
          `Deleted "${item?.name || 'line item'}".`,
          true,
        )
      },

      addCategory: (kind) => {
        const order = d().categories.filter((c) => c.kind === kind).length
        commit(
          { ...d(), categories: [...d().categories, makeCategory({ kind, name: 'New category', order })] },
          'Category added.',
        )
      },

      renameCategory: (id, name) =>
        commit({
          ...d(),
          categories: d().categories.map((c) =>
            c.id === id ? { ...c, name, updatedAt: nowISO() } : c),
        }),

      // Deleting a category takes its line items with it — an item with no
      // category cannot be displayed, so leaving them would hide data rather
      // than remove it. Undo restores both.
      deleteCategory: (id) => {
        const cat = d().categories.find((c) => c.id === id)
        const doomed = d().items.filter((it) => it.categoryId === id).map((it) => it.id)
        commit(
          withTombstones(
            {
              ...d(),
              categories: d().categories.filter((c) => c.id !== id),
              items: d().items.filter((it) => it.categoryId !== id),
            },
            [id, ...doomed],
          ),
          `Deleted "${cat?.name || 'category'}"${doomed.length ? ` and ${plural(doomed.length, 'line item', 'line items')}` : ''}.`,
          true,
        )
      },

      setStartingBalance: (value) =>
        commit({ ...d(), startingBalance: toCell(value) ?? 0, startingBalanceAt: nowISO() }),

      setYear: (value) => {
        const year = Number(value)
        if (Number.isFinite(year) && year > 1970) commit({ ...d(), year })
      },

      loadTemplate: () => {
        if (d().items.length || d().categories.length) {
          showToast('This budget already has categories — clear it first, or add categories by hand.')
          return
        }
        const next = templateData(d().year)
        commit({ ...next, startingBalance: d().startingBalance }, 'Loaded starter categories.', true)
      },

      // Import is an explicit "make it this". Stamping every row now means the
      // imported version wins the next merge instead of losing to whatever is
      // already on GitHub, and any tombstone for an imported id is cleared.
      restore: (next, source) => {
        const at = nowISO()
        const ids = new Set([...next.categories, ...next.items].map((r) => r.id))
        commit(
          {
            ...next,
            categories: next.categories.map((c) => ({ ...c, updatedAt: at })),
            items: next.items.map((it) => ({ ...it, baseAt: at, updatedAt: at })),
            startingBalanceAt: at,
            deleted: [...d().deleted, ...(next.deleted || [])].filter((t) => !ids.has(t.id)),
          },
          `Imported ${plural(next.categories.length, 'category', 'categories')} and ` +
            `${plural(next.items.length, 'line item', 'line items')} from ${source}.`,
          true,
        )
      },

      // Statement import writes only the actual layer, and is undoable like
      // any other bulk change.
      applyStatement: (next, summary, filename) => {
        const cells = summary.cells.size
        const swept = summary.totals.swept
        commit(
          next,
          `Recorded ${plural(cells, 'monthly total', 'monthly totals')} from ${filename}` +
            (swept ? `, ${money(swept)} of it unassigned.` : '.'),
          true,
        )
      },

      /** The import needs its catch-all line to exist before it can sweep. */
      prepareForStatement: () =>
        ensureCatchAll(d(), { category: makeCategory, item: makeItem }),

      setSync: setSyncField,

      /** Encrypt the token under a passphrase and keep it unlocked for this tab. */
      saveToken: async (raw, passphrase) => {
        try {
          const tokenEnc = await encryptToken(raw.trim(), passphrase)
          setSyncField({ tokenEnc })
          setTokenState(raw.trim())
          setSyncStatus({ busy: false, message: 'Token encrypted and saved.', error: '' })
        } catch (e) {
          setSyncStatus({ busy: false, message: '', error: e.message })
        }
      },

      unlock: async (passphrase) => {
        try {
          setTokenState(await decryptToken(syncRef.current.tokenEnc, passphrase))
          setSyncStatus({ busy: false, message: 'Unlocked.', error: '' })
        } catch (e) {
          setSyncStatus({ busy: false, message: '', error: e.message })
        }
      },

      lock: () => {
        setTokenState('')
        setSyncStatus({ busy: false, message: 'Locked.', error: '' })
      },

      forgetToken: () => {
        setTokenState('')
        setSyncField({ tokenEnc: null })
        setSyncStatus({ busy: false, message: 'Saved token removed from this device.', error: '' })
      },

      setupCode: () => makeSetupCode(syncRef.current),

      importSetup: (code) => {
        try {
          setSyncField(readSetupCode(code))
          setSyncStatus({ busy: false, message: 'Settings loaded. Enter the passphrase to unlock.', error: '' })
          return true
        } catch (e) {
          setSyncStatus({ busy: false, message: '', error: e.message })
          return false
        }
      },

      pull,
      push,
    }
  }, [commit, pull, push, setSyncField, showToast])

  const toggleCategory = useCallback((id) => {
    setPrefs((p) => ({
      ...p,
      collapsed: { ...(p.collapsed || {}), [id]: !(p.collapsed || {})[id] },
    }))
  }, [])

  const setLayer = useCallback((next) => setPrefs((p) => ({ ...p, layer: next })), [])

  const syncLabel = !sync.tokenEnc && !token
    ? 'Sync off'
    : !token
      ? 'Locked'
      : syncStatus.busy
        ? 'Syncing…'
        : sync.autoPush ? 'Sync on (auto)' : 'Sync on'

  return (
    <div className="wrap">
      <header className="app-head">
        <h1>Budget {data.year}</h1>
        <span className="sync-state">{syncStatus.error ? <span className="err">{syncStatus.error}</span> : syncLabel}</span>
      </header>

      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab !== 'data' && (
        <div className="row" style={{ marginBottom: 14, alignItems: 'center', gap: 12 }}>
          <div className="layer-toggle" role="group" aria-label="Which numbers to show">
            <button aria-pressed={layer === 'planned'} onClick={() => setLayer('planned')}>Planned</button>
            <button aria-pressed={layer === 'actual'} onClick={() => setLayer('actual')}>Actual</button>
            {tab !== 'summary' && (
              <button aria-pressed={layer === 'variance'} onClick={() => setLayer('variance')}>Variance</button>
            )}
          </div>
          <span className="small muted">
            {layer === 'planned' && 'Editing the plan — what you expect for each month.'}
            {layer === 'actual' && 'Editing actuals — what really happened.'}
            {layer === 'variance' && 'Read-only: actual minus planned.'}
          </span>
        </div>
      )}

      {tab === 'summary' && (
        <SummaryTab data={data} layer={layer === 'variance' ? 'planned' : layer} />
      )}

      {(tab === 'expenses' || tab === 'income') && (
        <div className="panel">
          <BudgetGrid
            data={data}
            kind={tab === 'income' ? 'income' : 'expense'}
            layer={layer}
            actions={actions}
            collapsed={collapsed}
            onToggleCategory={toggleCategory}
          />
        </div>
      )}

      {tab === 'data' && (
        <DataTab data={data} sync={sync} token={token} syncStatus={syncStatus} actions={actions} />
      )}

      <Toast toast={toast} onUndo={undo} onDismiss={dismissToast} />
    </div>
  )
}
