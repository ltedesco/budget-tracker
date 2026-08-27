// GitHub Contents API client tests, against a stubbed fetch.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getFile, putFile, configErrors } from '../src/lib/github.js'


const cfg = { owner: 'ltedesco', repo: 'budget', branch: 'main', path: 'data/budget-data.json', token: 'tok123' }
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
let calls = []
const stub = (responder) => { calls = []; globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return responder(url, opts) } }
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

// --- configErrors ---
test('lists every missing field', () => assert.deepEqual(configErrors({}), ['owner', 'repo', 'path', 'token']))
test('empty when complete', () => assert.deepEqual(configErrors(cfg), []))

// --- getFile ---
test('builds the right URL and auth header', async () => {
  stub(() => res(200, { content: b64('{"items":[]}'), sha: 'sha1' }))
  await getFile(cfg)
  assert.equal(calls[0].url, 'https://api.github.com/repos/ltedesco/budget/contents/data/budget-data.json?ref=main')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok123')
  assert.equal(calls[0].opts.headers['X-GitHub-Api-Version'], '2022-11-28')
})
test('decodes content and returns sha', async () => {
  stub(() => res(200, { content: b64('{"items":[]}'), sha: 'sha1' }))
  assert.deepEqual(await getFile(cfg), { content: '{"items":[]}', sha: 'sha1' })
})
test('decodes GitHub-style wrapped base64 with newlines', async () => {
  const wrapped = b64('{"a":1}').match(/.{1,4}/g).join('\n')
  stub(() => res(200, { content: wrapped, sha: 's' }))
  assert.equal((await getFile(cfg)).content, '{"a":1}')
})
test('round-trips non-ASCII payer names', async () => {
  const text = JSON.stringify({ payer: 'Café Zöe — 整体', note: '“check”' })
  stub(() => res(200, { content: b64(text), sha: 's' }))
  assert.equal((await getFile(cfg)).content, text)
})
test('404 means "not created yet", not an error', async () => {
  stub(() => res(404, { message: 'Not Found' }))
  assert.deepEqual(await getFile(cfg), { content: null, sha: null })
})
test('401 surfaces a token hint', async () => {
  stub(() => res(401, { message: 'Bad credentials' }))
  await assert.rejects(getFile(cfg), /401.*Bad credentials.*check the token/s)
})
test('403 surfaces a permissions hint', async () => {
  stub(() => res(403, { message: 'Resource not accessible' }))
  await assert.rejects(getFile(cfg), /Contents write access/)
})
test('rejects a directory path', async () => {
  stub(() => res(200, [{ name: 'a.json' }]))
  await assert.rejects(getFile(cfg), /is a directory/)
})
test('encodes spaces in the path', async () => {
  stub(() => res(200, { content: b64('{}'), sha: 's' }))
  await getFile({ ...cfg, path: 'my data/tracker data.json' })
  assert.ok(calls[0].url.includes('my%20data/tracker%20data.json'), calls[0].url)
})

// --- putFile ---
test('sends sha on update', async () => {
  stub(() => res(200, { content: { sha: 'sha2' }, commit: { sha: 'c1' } }))
  const out = await putFile(cfg, '{"x":1}', 'sha1', 'msg')
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(calls[0].opts.method, 'PUT')
  assert.equal(body.sha, 'sha1')
  assert.equal(body.branch, 'main')
  assert.equal(body.message, 'msg')
  assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), '{"x":1}')
  assert.deepEqual(out, { sha: 'sha2', commit: 'c1' })
})
test('omits sha when creating', async () => {
  stub(() => res(201, { content: { sha: 'new' }, commit: { sha: 'c' } }))
  await putFile(cfg, '{}', null)
  assert.ok(!('sha' in JSON.parse(calls[0].opts.body)), 'sha should be absent')
})
test('409 conflict is reported as a remote change', async () => {
  stub(() => res(409, { message: 'sha does not match' }))
  await assert.rejects(putFile(cfg, '{}', 'stale'), /409.*changed on GitHub/s)
})
test('handles a non-JSON error body', async () => {
  stub(() => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } }))
  await assert.rejects(putFile(cfg, '{}', 's'), /GitHub 500/)
})

