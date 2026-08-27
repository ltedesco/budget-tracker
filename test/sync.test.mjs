import test from 'node:test'
import assert from 'node:assert/strict'
import { pullMerged, pushMerged, serialize } from '../src/lib/sync.js'
import { emptyData, makeCategory, makeItem, setCell } from '../src/lib/model.js'

const BORN = '2026-01-01T00:00:00.000Z'
const cfg = { owner: 'o', repo: 'r', branch: 'main', path: 'p', token: 't' }

function docWith(cellIndex, value, at) {
  const d = emptyData(2026)
  const cat = makeCategory({ kind: 'expense', name: 'Home', order: 0 }, BORN)
  const item = makeItem({ categoryId: cat.id, name: 'Mortgage', order: 0 }, BORN)
  item.id = 'item-1'
  cat.id = 'cat-1'
  item.categoryId = 'cat-1'
  d.categories.push(cat)
  d.items.push(setCell(item, 'planned', cellIndex, value, at))
  return d
}

/** An in-memory GitHub, so the conflict path can be exercised for real. */
function fakeApi(initial = null) {
  const state = { content: initial ? serialize(initial) : null, sha: initial ? 'sha-0' : null, puts: 0 }
  return {
    state,
    getFile: async () => ({ content: state.content, sha: state.sha }),
    putFile: async (_c, text, sha) => {
      if (sha !== state.sha) throw new Error('GitHub 409: does not match')
      state.content = text
      state.sha = `sha-${++state.puts}`
      return { sha: state.sha }
    },
  }
}

test('a push creates the file when none exists', async () => {
  const api = fakeApi(null)
  const local = docWith(0, '111', '2026-02-01T00:00:00Z')
  const { merged } = await pushMerged(cfg, local, api)
  assert.equal(merged.items[0].planned[0], 111)
  assert.ok(api.state.content.includes('111'))
})

test('a push merges the remote file rather than overwriting it', async () => {
  // Remote has March; this device has January. Both must survive.
  const remote = docWith(2, '999', '2026-03-01T00:00:00Z')
  const api = fakeApi(remote)
  const local = docWith(0, '111', '2026-02-01T00:00:00Z')

  const { merged } = await pushMerged(cfg, local, api)
  assert.equal(merged.items[0].planned[0], 111, "this device's January survives")
  assert.equal(merged.items[0].planned[2], 999, "the other device's March survives")
})

test('a 409 is retried against the re-read file, not blindly', async () => {
  const remote = docWith(2, '999', '2026-03-01T00:00:00Z')
  const api = fakeApi(remote)
  const local = docWith(0, '111', '2026-02-01T00:00:00Z')

  // Someone else commits in the gap between our read and our write, exactly
  // once. The retry must re-read and keep their row.
  let first = true
  const racing = {
    getFile: api.getFile,
    putFile: async (c, text, sha) => {
      if (first) {
        first = false
        const other = docWith(5, '7777', '2026-04-01T00:00:00Z')
        api.state.content = serialize(other)
        api.state.sha = 'sha-other'
        throw new Error('GitHub 409: does not match')
      }
      return api.putFile(c, text, sha)
    },
  }

  const { merged } = await pushMerged(cfg, local, racing)
  assert.equal(merged.items[0].planned[0], 111)
  assert.equal(merged.items[0].planned[5], 7777, 'the racing commit is not lost')
})

test('a pull merges into local instead of replacing it', async () => {
  const remote = docWith(2, '999', '2026-03-01T00:00:00Z')
  const api = fakeApi(remote)
  const local = docWith(0, '111', '2026-02-01T00:00:00Z')

  const { merged, existed } = await pullMerged(cfg, local, api)
  assert.equal(existed, true)
  assert.equal(merged.items[0].planned[0], 111)
  assert.equal(merged.items[0].planned[2], 999)
})

test('a pull against a missing file reports it rather than wiping local', async () => {
  const api = fakeApi(null)
  const local = docWith(0, '111', '2026-02-01T00:00:00Z')
  const { merged, existed } = await pullMerged(cfg, local, api)
  assert.equal(existed, false)
  assert.equal(merged.items[0].planned[0], 111)
})

test('a corrupt remote file is refused, not merged', async () => {
  const api = { getFile: async () => ({ content: '{"nope":true}', sha: 's' }), putFile: async () => {} }
  await assert.rejects(
    () => pullMerged(cfg, emptyData(2026), api),
    /not a valid budget document/,
  )
})

test('two devices converge after each pushes once', async () => {
  const api = fakeApi(null)
  const phone = docWith(0, '100', '2026-02-01T00:00:00Z')
  const laptop = docWith(6, '600', '2026-03-01T00:00:00Z')

  const a = await pushMerged(cfg, phone, api)
  const b = await pushMerged(cfg, laptop, api)
  const back = await pullMerged(cfg, a.merged, api)

  assert.equal(b.merged.items[0].planned[0], 100)
  assert.equal(b.merged.items[0].planned[6], 600)
  assert.deepEqual(back.merged.items[0].planned, b.merged.items[0].planned)
})
