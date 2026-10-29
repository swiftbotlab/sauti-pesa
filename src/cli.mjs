// Sauti Pesa CLI - the OFFLINE side (loaded by bin/sauti.mjs after its sandbox check). Run it inside the offline sandbox:
//   ops/sandbox.sh offline node bin/sauti.mjs <command> ...
// or, on a laptop without bubblewrap, with the network switched off:  npm run portable -- <command> ...
// Commands:
//   wallet init | wallet address
//   contacts demo | contacts list | contacts add --name N --address 0x.. [--relation brother]
//   ask "<request>"            [--network devnet|sepolia] [--yes] [--retype N] [--json]
//   say <file.wav>             [--lang sw|en|auto] [--accurate] (+ the ask options)
//   check "<message>" | check --file msg.txt | check --image screenshot.png  [--json] [--no-ai]
//   queue                      [--network ...]
//   resign <outbox-id>         [--network ...] [--yes]   re-sign a payment whose nonce was used elsewhere
//   cancel <outbox-id>         [--network ...] [--yes]   cancel a queued payment that was never sent (undo window)
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { close } from '@qvac/sdk'
import { createWallet, openWallet, walletExists } from './wallet.js'
import { loadContacts, saveContacts, validateContact } from './contacts.js'
import { Store } from './queue.js'
import { network, NETWORKS } from './networks.js'
import { LocalLLM } from './llm.js'
import { LocalASR, asrLabel } from './asr.js'
import { LocalOCR, readImageFile } from './ocr.js'
import { analyzeRequest, confirmAndQueue, analyzeMessage, resignEntry } from './pipeline.js'
import { cancelEntry, holdMinutesFrom, isHeld } from './undo.js'
import { networkState } from './offline.js'
import { requireGate } from './gate.js'
import { missingModelMessage, fetchCommand } from './setup_hint.js'
import { reasonText } from './i18n.js'
import { analysisView } from './view.js'
import { peakRssMb } from './procmem.js'
import { shortAddr } from './text.js'
import { loadConfig, llmLabel } from './profile.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // project root (this file is in src/)
const CFG = configOrExit() // config.json + the model profile (SAUTI_PROFILE=lite: Qwen3-0.6B; src/profile.js)
// SAUTI_DATA (tests only) moves private/ and queue/ under tmp/ so a test run never touches the real wallet
const DATA = dataRoot()
const PRIV = join(DATA, 'private')
const WALLET = join(PRIV, 'wallet.json')
const CONTACTS = join(PRIV, 'contacts.json')

function configOrExit () {
  try { return loadConfig(ROOT) } catch (e) { console.error(e.message); process.exit(2) }
}

function dataRoot () {
  const d = process.env.SAUTI_DATA
  if (!d) return ROOT
  const abs = resolve(ROOT, d)
  if (!abs.startsWith(join(ROOT, 'tmp') + sep)) throw new Error('SAUTI_DATA must be inside tmp/')
  return abs
}

function opts (argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (['yes', 'json', 'accurate', 'no-ai', 'require-offline'].includes(k)) o[k] = true
      else o[k] = argv[++i]
    } else o._.push(a)
  }
  return o
}

const say = (o, ...l) => { if (!o.json) console.log(...l) }
const PORTABLE = process.env.SAUTI_SANDBOX === 'portable'
// Right before every signature: the same live probe as at startup must still find the internet unreachable.
const signGate = () => requireGate({ action: 'sign', launcher: 'node bin/sauti.mjs ...' })
const modelPath = (rel) => {
  const p = join(ROOT, rel)
  if (!existsSync(p)) throw new Error(missingModelMessage(ROOT, rel))
  return realpathSync(p)
}

function tokenAddressFor (netId, store) {
  const n = network(netId)
  return n.token.address || store.state().tokenAddress || null
}

async function header (o) {
  const s = await networkState()
  if (o['require-offline'] && s.online) throw new Error('refusing to run: the internet is reachable (use ops/sandbox.sh offline)')
  say(o, `[network: ${s.online ? 'ON' : 'OFF (verified: no route, no DNS)'} | sandbox: ${s.sandbox}${PORTABLE ? ' (no bubblewrap: the network is switched off; checked again before every signature)' : ''}${CFG.profile !== 'default' ? ` | profile: ${CFG.profile} (${llmLabel(CFG.models.llm)})` : ''}]`)
  return s
}

async function cmdAsk (o, text, extra = {}) {
  const netId = o.network || CFG.network
  const net = network(netId)
  const store = new Store(join(DATA, 'queue'), netId)
  if (!walletExists(WALLET)) throw new Error('no wallet yet: run "wallet init"')
  const contacts = loadContacts(CONTACTS)
  const wallet = await openWallet(WALLET, { chainId: net.chainId })
  const ownAddress = await wallet.address()
  const tokenAddress = tokenAddressFor(netId, store)
  const llm = new LocalLLM({ modelPath: modelPath(CFG.models.llm), threads: CFG.llm_threads || undefined })
  const loadMs = await llm.load()
  const a = await analyzeRequest({ text, llm, contacts, store, ownAddress, tokenAddress, limits: CFG.limits })
  const timing = { ...extra.timing, llm_load_ms: loadMs, llm_ms: a.llmMs }
  if (!a.ok) {
    say(o, `Could not understand the request safely: ${a.errors.join('; ')}`)
    if (o.json) console.log(JSON.stringify({ ...a, timing }))
    return finish(llm, wallet)
  }
  const L = a.lang
  say(o, `\nYou said: "${a.transcript}"`)
  say(o, `AI (on device) understood: ${JSON.stringify(a.intent)}`)
  say(o, `\n${a.confirmation[L]}`)
  for (const r of a.reasons) say(o, `  ${r.severity === 'block' ? 'BLOCK' : r.severity === 'warn' ? 'WARN ' : 'info '} ${r[L]}`)
  // the same check groups as the UI's confirmation card (recipient, address, amount, limits, balance, scam)
  const groups = analysisView(a, { contacts, limits: { perTx: '100', perDay: '300', newRecipientMax: '20', retypeAbove: '50', ...(CFG.limits || {}) }, balanceUnits: store.state().balance?.units ?? null }).groups || []
  if (groups.length) say(o, `  ${L === 'sw' ? 'Ukaguzi' : 'Checks'} (${groups.length}, plain code): ${groups.map((g) => `${g.title[L]} ${g.status === 'ok' ? 'ok' : g.status.toUpperCase()}`).join(' · ')}`)
  for (const f of a.flags.filter((x) => x.source !== 'model')) say(o, `  sign: ${f[L]}`)
  const aiOnly = a.flags.filter((x) => x.source === 'model').map((x) => x.id)
  if (aiOnly.length) say(o, `  ${L === 'sw' ? 'AI pia inashuku (haijathibitishwa)' : 'AI also suspects (unconfirmed)'}: ${aiOnly.join(', ')}`)
  if (a.aiNote) say(o, `  AI note: ${a.aiNote}`)
  let queued = null
  if (a.decision !== 'blocked') {
    let yes = !!o.yes
    if (!yes && process.stdin.isTTY && !o.json) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const ans = (await rl.question(L === 'sw' ? 'ndiyo/hapana > ' : 'yes/no > ')).trim().toLowerCase()
      if (a.needsRetype) o.retype = (await rl.question(L === 'sw' ? 'Andika kiasi tena > ' : 'Type the amount again > ')).trim()
      rl.close()
      yes = ['y', 'yes', 'ndiyo', 'ndio'].includes(ans)
    }
    if (yes) {
      await signGate()
      queued = await confirmAndQueue({ analysis: a, wallet, store, networkId: netId, tokenAddress, retypedAmount: o.retype, holdMinutes: holdMinutesFrom(CFG) })
      say(o, `\n${L === 'sw' ? 'Imesainiwa kwenye kifaa (bila mtandao) na kuwekwa foleni.' : 'Signed on this device (offline) and queued.'}`)
      say(o, `  tx ${queued.hash}  nonce ${queued.nonce}  ->  ${queued.recipientName || ''} ${shortAddr(queued.to)}  ${queued.amount} test USDT`)
      if (queued.holdUntil) {
        const at = hhmm(queued.holdUntil)
        say(o, L === 'sw'
          ? `  MUDA WA KUGHAIRI: yanasubiri kwenye kifaa hadi ${at} (${queued.holdReasons.join(', ')}). Ghairi: node bin/sauti.mjs cancel ${queued.id.slice(0, 8)}`
          : `  UNDO WINDOW: held on this device until ${at} (${queued.holdReasons.join(', ')}). Cancel: node bin/sauti.mjs cancel ${queued.id.slice(0, 8)}`)
      }
      say(o, PORTABLE
        ? '  NETWORK NEEDED LATER: portable mode never broadcasts. The signed payment stays in the outbox (queue/); broadcasting is the separate online step (Linux: ops/devnet.sh broadcast).'
        : `  NETWORK NEEDED LATER: broadcast with "node bin/netsync.mjs broadcast --network ${netId}" when online.`)
    } else say(o, L === 'sw' ? 'Hakuna kilichotumwa.' : 'Nothing was sent.')
  }
  timing.peak_rss_mb = peakRssMb()
  if (o.json) console.log(JSON.stringify({ ...a, amountUnits: a.amountUnits?.toString() ?? null, queued: queued && { id: queued.id, hash: queued.hash, nonce: queued.nonce, holdUntil: queued.holdUntil || null }, timing }))
  else say(o, `\n[timing ms: ${Object.entries(timing).filter(([k]) => k !== 'peak_rss_mb').map(([k, v]) => `${k}=${v}`).join(' ')}]`)
  return finish(llm, wallet)
}

async function finish (llm, wallet) {
  await llm?.unload()
  wallet?.dispose()
}

async function cmdSay (o) {
  const file = o._[1]
  if (!file) throw new Error('usage: say <file.wav> [--lang sw|en|auto]')
  const contacts = loadContacts(CONTACTS)
  // Swahili: the Swahili fine-tune of Whisper small when it is on disk (config.models.asr_sw); --accurate: turbo
  const swRel = !o.accurate && CFG.models.asr_sw
  const swOk = swRel && existsSync(join(ROOT, swRel))
  if (swRel && !swOk && (o.lang || 'sw') === 'sw') say(o, `(Swahili speech model ${swRel} is missing: using ${CFG.models.asr}; download it once, with the internet on: ${fetchCommand(['WHISPER_SMALL_SW_Q8_0'])})`)
  const asr = new LocalASR({
    modelPath: modelPath(o.accurate ? CFG.models.asr_accurate : CFG.models.asr),
    modelPaths: swOk ? { sw: modelPath(swRel) } : {},
    vadPath: modelPath(CFG.models.vad),
    threads: CFG.asr_threads || 4,
    audioCtx: o.accurate ? (CFG.asr_accurate_audio_ctx || 0) : 0,
    names: contacts.map((c) => c.name)
  })
  const r = await asr.transcribe(realpathSync(file), o.lang || 'sw')
  const timing = { asr_model: r.model, asr_load_ms: Object.values(asr.loadMs)[0], asr_ms: r.ms, audio_s: r.seconds, input_gain_db: r.gain?.gain_db ?? 0 }
  await asr.unload() // free the speech model before loading the language model (RAM)
  if (r.gain?.applied) say(o, `Quiet recording (${r.gain.rms_dbfs} dBFS RMS, peak ${r.gain.peak_dbfs} dBFS): input raised by ${r.gain.gain_db} dB before speech to text.`)
  say(o, `Transcript (${r.lang}, ${asrLabel(r.model)}, ${r.ms} ms for ${r.seconds} s of audio): "${r.text}"`)
  return cmdAsk(o, r.text, { timing })
}

// "Check this message" from a screenshot: QVAC OCR reads the text on the device, then the SAME checks as pasted text.
// The OCR model is unloaded before the language model loads (one model in RAM at a time).
async function readScreenshot (o) {
  const { buf, info } = readImageFile(realpathSync(o.image))
  const reader = new LocalOCR({ modelPath: modelPath(CFG.models.ocr), detectorPath: modelPath(CFG.models.ocr_detector), threads: CFG.ocr_threads || 4 })
  try {
    const loadMs = await reader.load()
    const r = await reader.read(buf)
    say(o, `Read from the screenshot on this device (QVAC OCR, ${info.width}x${info.height} ${info.type}, ${r.ms} ms):`)
    for (const line of r.text.split('\n')) say(o, `  | ${line}`)
    return { text: r.text, timing: { ocr_load_ms: loadMs, ocr_ms: r.ms, ocr_blocks: r.blocks, ocr_peak_rss_mb: peakRssMb() } }
  } finally {
    await reader.unload()
  }
}

async function cmdCheck (o) {
  const shot = o.image ? await readScreenshot(o) : null
  const text = shot ? shot.text : o.file ? readFileSync(o.file, 'utf8') : o._.slice(1).join(' ')
  if (shot && !text) throw new Error('no text found in the screenshot')
  const contacts = loadContacts(CONTACTS)
  let llm = null
  let loadMs = 0
  if (!o['no-ai']) { llm = new LocalLLM({ modelPath: modelPath(CFG.models.llm) }); loadMs = await llm.load() }
  const r = await analyzeMessage({ text, llm, contacts, history: [] })
  const L = o.lang || r.lang
  say(o, `\n${r.headline[L]}`)
  for (const f of r.flags.filter((x) => x.source !== 'model')) say(o, `  - ${f[L]}`)
  const aiOnly = r.flags.filter((x) => x.source === 'model').map((x) => x.id)
  if (aiOnly.length) say(o, `  ${L === 'sw' ? 'AI pia inashuku (haijathibitishwa)' : 'AI also suspects (unconfirmed)'}: ${aiOnly.join(', ')}`)
  for (const a of r.addresses) {
    if (a.knownAs) say(o, `  - ${shortAddr(a.address)}: ${L === 'sw' ? 'ni anwani uliyohifadhi ya' : 'is the saved address of'} ${a.knownAs}`)
    for (const l of a.looksLike) say(o, `  - ${reasonText({ code: 'lookalike_address', similarTo: l.name, similarAddress: l.address }, L)}`)
    if (a.issue) say(o, `  - ${shortAddr(a.address)}: ${reasonText({ code: a.issue }, L)}`)
  }
  if (r.aiNote) say(o, `  AI note: ${r.aiNote}`)
  if (o.json) console.log(JSON.stringify({ ...r, ...(shot ? { ocrText: text } : {}), timing: { ...shot?.timing, llm_load_ms: loadMs, llm_ms: r.llmMs, peak_rss_mb: peakRssMb() } }))
  await llm?.unload()
}

// A queued payment whose nonce another transaction took (the broadcaster marks it needs_resign after checking
// that THIS transaction was not mined). Same transfer, new nonce, WDK policy bound to it again; asks first.
async function cmdResign (o) {
  const id = o._[1]
  if (!id) throw new Error('usage: resign <outbox-id> [--network devnet|sepolia] [--yes]')
  const netId = o.network || CFG.network
  const net = network(netId)
  const store = new Store(join(DATA, 'queue'), netId)
  const e = store.list().find((x) => x.id === id || x.id.startsWith(id))
  if (!e) throw new Error('no such outbox entry')
  say(o, `Re-sign ${e.amount} test USDT -> ${e.recipientName || ''} ${shortAddr(e.to)} (old nonce ${e.nonce}: ${e.error || e.status})`)
  let yes = !!o.yes
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    yes = ['y', 'yes', 'ndiyo', 'ndio'].includes((await rl.question('yes/no > ')).trim().toLowerCase())
    rl.close()
  }
  if (!yes) { say(o, 'Nothing was signed.'); return }
  await signGate()
  const wallet = await openWallet(WALLET, { chainId: net.chainId })
  try {
    const r = await resignEntry({ entryId: e.id, wallet, store, networkId: netId, chainId: net.chainId })
    say(o, `Signed again offline: tx ${r.hash} nonce ${r.nonce} (queued; broadcast when online)`)
    if (o.json) console.log(JSON.stringify({ id: r.id, hash: r.hash, nonce: r.nonce, status: r.status }))
  } finally { wallet.dispose() }
}

const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16) + ' UTC'

// Undo window: cancel a queued payment that was never handed to the network. Nothing is signed; the signed bytes
// are deleted. Newer queued payments must then be signed again (their nonce moves down by one). Asks first.
async function cmdCancel (o) {
  const id = o._[1]
  if (!id || !/^[0-9a-f-]{4,36}$/.test(id)) throw new Error('usage: cancel <outbox-id> [--network devnet|sepolia] [--yes]')
  const netId = o.network || CFG.network
  const net = network(netId)
  const store = new Store(join(DATA, 'queue'), netId)
  const matches = store.list().filter((x) => x.id === id || x.id.startsWith(id))
  if (matches.length !== 1) throw new Error(matches.length ? 'that id prefix matches more than one entry' : 'no such outbox entry')
  const e = matches[0]
  say(o, `Cancel ${e.amount} test USDT -> ${e.recipientName || ''} ${shortAddr(e.to)} (nonce ${e.nonce}, ${e.status}${isHeld(e) ? `, held until ${hhmm(e.holdUntil)}` : ''})`)
  let yes = !!o.yes
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    yes = ['y', 'yes', 'ndiyo', 'ndio'].includes((await rl.question('yes/no > ')).trim().toLowerCase())
    rl.close()
  }
  if (!yes) { say(o, 'Nothing was changed.'); return }
  const r = cancelEntry({ store, id: e.id, chainId: net.chainId })
  say(o, `Cancelled on this device: tx ${r.entry.hash} (nonce ${r.entry.nonce}) will never be sent; its signed bytes are deleted.`)
  for (const x of r.resign) say(o, `  newer payment ${x.id.slice(0, 8)} (${x.amount} test USDT -> ${x.recipientName || shortAddr(x.to)}) must be signed again: node bin/sauti.mjs resign ${x.id.slice(0, 8)}`)
  if (o.json) console.log(JSON.stringify({ id: r.entry.id, status: r.entry.status, nonce: r.entry.nonce, resign: r.resign.map((x) => x.id) }))
}

async function main () {
  const o = opts(process.argv.slice(2))
  const [cmd, sub] = o._
  await header(o)
  // the PUBLIC address is shared with the network side through queue/<net>/state.json; the seed never is
  const publish = (address) => { for (const id of Object.keys(NETWORKS)) new Store(join(DATA, 'queue'), id).saveState({ address }) }
  if (cmd === 'wallet' && sub === 'init') { const a = await createWallet(WALLET); publish(a); say(o, `test wallet created: ${a} (seed stored in private/wallet.json, never shown)`) }
  else if (cmd === 'wallet' && sub === 'address') { const w = await openWallet(WALLET, { chainId: 1 }); const a = await w.address(); publish(a); console.log(a); w.dispose() }
  else if (cmd === 'contacts' && sub === 'demo') {
    if (existsSync(CONTACTS) && !o.yes) throw new Error('contacts exist; pass --yes to replace them with the demo set')
    saveContacts(CONTACTS, JSON.parse(readFileSync(join(ROOT, 'data/demo-contacts.json'), 'utf8')))
    say(o, 'demo contacts installed (test addresses only)')
  } else if (cmd === 'contacts' && sub === 'list') for (const c of loadContacts(CONTACTS)) console.log(`${c.name.padEnd(12)} ${c.relation || ''}`.padEnd(24), c.address)
  else if (cmd === 'contacts' && sub === 'add') {
    const list = loadContacts(CONTACTS)
    const c = validateContact({ name: o.name, address: o.address, relation: o.relation, added: new Date().toISOString().slice(0, 10), payments: 0 })
    if (list.some((x) => x.address === c.address)) throw new Error('that address is already saved')
    saveContacts(CONTACTS, [...list, c]); say(o, `saved ${c.name} ${c.address}`)
  } else if (cmd === 'ask') await cmdAsk(o, o._.slice(1).join(' '))
  else if (cmd === 'say') await cmdSay(o)
  else if (cmd === 'check') await cmdCheck(o)
  else if (cmd === 'queue') {
    const store = new Store(join(DATA, 'queue'), o.network || CFG.network)
    for (const e of store.list()) console.log(`${e.status.padEnd(10)} nonce ${String(e.nonce).padEnd(3)} ${e.amount} test USDT -> ${e.recipientName || ''} ${shortAddr(e.to)}  ${e.hash.slice(0, 18)}…  id ${e.id.slice(0, 8)}${isHeld(e) ? `  held until ${hhmm(e.holdUntil)}` : ''}`)
  } else if (cmd === 'resign') await cmdResign(o)
  else if (cmd === 'cancel') await cmdCancel(o)
  else {
    const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
    console.log(head.slice(1, head.findIndex((l) => !l.startsWith('//'))).join('\n').replace(/^\/\/ ?/gm, ''))
  }
}

main().then(() => close()).catch(async (e) => {
  console.error(`error: ${e.message}`)
  try { await close() } catch {}
  process.exit(1)
})
