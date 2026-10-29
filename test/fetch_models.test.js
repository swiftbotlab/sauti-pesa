// The cross-platform model downloader (scripts/fetch_models.mjs) with a scripted fetch: no network. Only pinned
// https downloads from Hugging Face are accepted; every redirect must stay https; the file is renamed into place only
// when size AND sha256 match; more bytes than the pin abort; a partial file resumes with an HTTP Range request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, linkSync, mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { entryFor, fetchOne, getFollowing, DEFAULT_KEYS } from '../scripts/fetch_models.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BODY = Buffer.from('model bytes '.repeat(5000))
const ENTRY = { file: 'm.bin', url: 'https://huggingface.co/org/repo/resolve/abc/m.bin', sha256: createHash('sha256').update(BODY).digest('hex'), bytes: BODY.length }
const quiet = () => {}

// a scripted server: huggingface.co redirects once to a CDN host, which serves the body (and honours Range)
function server ({ body = BODY, redirectTo = 'https://cdn.example.hf.co/blob', ignoreRange = false } = {}) {
  const calls = []
  const f = async (url, opts) => {
    calls.push({ url, range: opts.headers.range || null, redirect: opts.redirect })
    if (url.startsWith('https://huggingface.co/')) return new Response(null, { status: 302, headers: { location: redirectTo } })
    const m = /^bytes=(\d+)-$/.exec(opts.headers.range || '')
    if (m && !ignoreRange) return new Response(body.subarray(Number(m[1])), { status: 206 })
    return new Response(body, { status: 200 })
  }
  f.calls = calls
  return f
}

test('fetch-models: entries are validated before any download', () => {
  const models = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))
  for (const k of DEFAULT_KEYS) assert.equal(entryFor(models, k).url.startsWith('https://huggingface.co/'), true, k)
  assert.throws(() => entryFor(models, 'OCR_LATIN'), /peer-to-peer registry; its fenced downloader is Linux-only/)
  assert.throws(() => entryFor(models, '../x'), /bad model key/)
  assert.throws(() => entryFor(models, 'NOPE'), /not in models\.json/)
  assert.throws(() => entryFor(models, '__proto__'), /bad model key|not in models\.json/)
  assert.throws(() => entryFor({ A: { ...ENTRY, url: 'http://huggingface.co/x' } }, 'A'), /unexpected host/)
  assert.throws(() => entryFor({ A: { ...ENTRY, url: 'https://huggingface.co.evil.example/x' } }, 'A'), /unexpected host/)
  assert.throws(() => entryFor({ A: { ...ENTRY, file: '../m.bin' } }, 'A'), /bad file name/)
  assert.throws(() => entryFor({ A: { ...ENTRY, file: '.hidden' } }, 'A'), /bad file name/)
  assert.throws(() => entryFor({ A: { ...ENTRY, sha256: 'abc' } }, 'A'), /bad sha256 pin/)
  assert.throws(() => entryFor({ A: { ...ENTRY, bytes: -1 } }, 'A'), /bad size pin/)
})

test('fetch-models: download, verify, rename; a second run only verifies', async () => {
  const dir = mkdtempSync(join(ROOT, 'tmp', 'fm-test-'))
  try {
    const f = server()
    assert.match(await fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: f, log: quiet }), /^A: ok sha256=/)
    assert.deepEqual(readFileSync(join(dir, 'm.bin')), BODY)
    assert.equal(existsSync(join(dir, 'm.bin.part')), false)
    assert.equal(f.calls.every((c) => c.redirect === 'manual'), true)
    assert.equal(await fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), 'A: already present and verified')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fetch-models: a partial file resumes with Range; a server that ignores Range restarts cleanly', async () => {
  for (const ignoreRange of [false, true]) {
    const dir = mkdtempSync(join(ROOT, 'tmp', 'fm-test-'))
    try {
      writeFileSync(join(dir, 'm.bin.part'), BODY.subarray(0, 1000))
      const f = server({ ignoreRange })
      assert.match(await fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: f, log: quiet }), /^A: ok/)
      assert.equal(f.calls.at(-1).range, 'bytes=1000-')
      assert.deepEqual(readFileSync(join(dir, 'm.bin')), BODY)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('fetch-models: wrong bytes are deleted, oversize aborts, wrong existing file is not overwritten', async () => {
  const dir = mkdtempSync(join(ROOT, 'tmp', 'fm-test-'))
  try {
    const evil = Buffer.from(BODY); evil[10] ^= 1
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server({ body: evil }), log: quiet }), /sha256 mismatch/)
    assert.equal(existsSync(join(dir, 'm.bin')), false)
    assert.equal(existsSync(join(dir, 'm.bin.part')), false)
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server({ body: Buffer.concat([BODY, Buffer.from('x')]) }), log: quiet }), /more bytes than the pinned size/)
    assert.equal(existsSync(join(dir, 'm.bin')), false)
    rmSync(join(dir, 'm.bin.part'), { force: true })
    writeFileSync(join(dir, 'm.bin'), 'not the model')
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), /does not match the pin/)
    assert.equal(readFileSync(join(dir, 'm.bin'), 'utf8'), 'not the model')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fetch-models: every redirect must stay https, without credentials, at most 5 hops', async () => {
  await assert.rejects(getFollowing('https://huggingface.co/x', {}, server({ redirectTo: 'http://cdn.example/blob' })), /non-https/)
  await assert.rejects(getFollowing('https://huggingface.co/x', {}, server({ redirectTo: 'file:///etc/passwd' })), /non-https/)
  await assert.rejects(getFollowing('https://huggingface.co/x', {}, server({ redirectTo: 'https://user:pw@cdn.example/blob' })), /credentials/)
  const loop = async (url) => new Response(null, { status: 302, headers: { location: url + '1' } })
  await assert.rejects(getFollowing('https://huggingface.co/x', {}, loop), /more than 5 redirects/)
  const r = await getFollowing('https://huggingface.co/x', {}, server())
  assert.equal(r.status, 200)
})

// ---- the .part file is never reached through a link (security review 2026-10-29, L4)
// the reviewed commit's downloader, from git history (null without git): the positive control
function reviewedFetchOne () {
  const r = spawnSync('git', ['show', '47ad420:scripts/fetch_models.mjs'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) return null
  const dir = mkdtempSync(join(ROOT, 'tmp', 'fm-old-'))
  writeFileSync(join(dir, 'fetch_models.mjs'), r.stdout)
  return { dir, load: () => import(pathToFileURL(join(dir, 'fetch_models.mjs')).href) }
}

test('fetch-models L4 control: the reviewed downloader follows a dangling .part link and writes outside models/', async (t) => {
  const old = reviewedFetchOne()
  if (!old) return t.skip('git history not available')
  const base = mkdtempSync(join(ROOT, 'tmp', 'fm-test-'))
  try {
    const dir = join(base, 'models'); mkdirSync(dir)
    symlinkSync('../outside-target.bin', join(dir, 'm.bin.part'))
    const { fetchOne: oldFetchOne } = await old.load()
    assert.match(await oldFetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), /^A: ok/)
    assert.equal(existsSync(join(base, 'outside-target.bin')), true, 'the reviewed code created a file outside models/')
    assert.equal(lstatSync(join(dir, 'm.bin')).isSymbolicLink(), true, 'and models/m.bin is now that link')
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(old.dir, { recursive: true, force: true }) }
})

test('fetch-models L4: a .part that is a link (dangling or not), a hard link or a folder is refused; nothing is written through it', async () => {
  const base = mkdtempSync(join(ROOT, 'tmp', 'fm-test-'))
  try {
    const dir = join(base, 'models'); mkdirSync(dir)
    const part = join(dir, 'm.bin.part')
    const refused = /m\.bin\.part is not a regular file .*refusing/
    // dangling symlink
    symlinkSync('../outside-target.bin', part)
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), refused)
    assert.equal(existsSync(join(base, 'outside-target.bin')), false)
    assert.equal(existsSync(join(dir, 'm.bin')), false)
    rmSync(part)
    // symlink to an existing file (would be appended to on a resume)
    writeFileSync(join(base, 'victim.txt'), 'keep me')
    symlinkSync('../victim.txt', part)
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), refused)
    assert.equal(readFileSync(join(base, 'victim.txt'), 'utf8'), 'keep me')
    rmSync(part)
    // hard link: the same file under a second name
    linkSync(join(base, 'victim.txt'), part)
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), refused)
    assert.equal(readFileSync(join(base, 'victim.txt'), 'utf8'), 'keep me')
    rmSync(part)
    // a folder
    mkdirSync(part)
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), refused)
    rmSync(part, { recursive: true })
    // a dangling link where the model goes is not "missing": it is refused, never followed
    symlinkSync('../outside-model.bin', join(dir, 'm.bin'))
    await assert.rejects(fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), /exists but does not match the pin/)
    assert.equal(existsSync(join(base, 'outside-model.bin')), false)
    rmSync(join(dir, 'm.bin'))
    // and with nothing in the way, the same folder downloads normally (fresh, then resume after a cut)
    writeFileSync(part, BODY.subarray(0, 777))
    assert.match(await fetchOne({ key: 'A', entry: ENTRY, dir, fetchImpl: server(), log: quiet }), /^A: ok/)
    assert.deepEqual(readFileSync(join(dir, 'm.bin')), BODY)
    assert.equal(lstatSync(join(dir, 'm.bin')).isFile(), true)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('fetch-models L4: a fresh download creates the .part exclusively (O_EXCL), and the source opens without following links', () => {
  const src = readFileSync(join(ROOT, 'scripts/fetch_models.mjs'), 'utf8')
  assert.match(src, /const NOFOLLOW = FS\.O_NOFOLLOW \|\| 0/)
  assert.match(src, /const CREATE_NEW = FS\.O_CREAT \| FS\.O_EXCL \| FS\.O_WRONLY \| NOFOLLOW/)
  assert.match(src, /const APPEND_ONLY = FS\.O_APPEND \| FS\.O_WRONLY \| NOFOLLOW/)
  assert.ok(!/openSync\(part, done \? 'a' : 'w'/.test(src), 'no flag strings that follow links')
  assert.ok(!/createReadStream\(part\)/.test(src))
})
