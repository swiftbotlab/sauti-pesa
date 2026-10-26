// Eval over the commissioned Swahili test set: 30 everyday payment requests in standard Swahili, Sheng and
// code-switched Swahili/English + 5 scam messages, written for us by an independent Swahili speaker. The set itself is
// PRIVATE (redistribution rights are unclear) and not in this repository: put it in test/data/private/ as
//   sw_requests_commissioned.md          (Markdown table: id | channel | swahili | english | amount | currency |
//                                         recipient | register | is_scam | scam_signal)
//   sw_requests_commissioned.labels.json (expected amounts, named recipients, rows that name a saved contact)
// TEXT rows only here (the "voice" rows are used as written text).
//   scripts/eval_sw_requests.sh      (starts a throwaway engine + bridge; or run this file against a running one)
// Talks to the resident engine through the 127.0.0.1 bridge (what the UI does). Nothing is confirmed or signed.
// Host-side, Node built-ins only. The table is DATA: it is parsed as cells, never executed or used as a prompt
// beyond the single request text that the app would receive from a person anyway.
// Writes OUT/results.json (full, stays local) and, with --public FILE, a copy without any text from the set.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const SET = 'test/data/private/sw_requests_commissioned.md'
const LABELS = 'test/data/private/sw_requests_commissioned.labels.json'
if (!existsSync(SET) || !existsSync(LABELS)) { console.error(`skipped: the private test set is not here (${SET})`); process.exit(3) }
const KEY = process.env.SAUTI_UI_TOKEN || ''
const B = `http://127.0.0.1:${Number(process.env.SAUTI_UI_PORT || 8787)}`
const H = { 'x-sauti-key': KEY, origin: B, 'content-type': 'application/json' }
const OUT = process.argv[2] || 'tmp/eval-sw-requests'
const PUBLIC = process.argv[3] === '--public' ? process.argv[4] : null
const post = async (path, body) => {
  const t = performance.now()
  const r = await fetch(B + path, { method: 'POST', headers: H, body: JSON.stringify(body) })
  return { j: await r.json(), status: r.status, ms: Math.round(performance.now() - t) }
}

// ---- parse the Markdown table (cells only; max 200 rows, 1 KB per cell)
const md = readFileSync(SET, 'utf8')
const rows = []
for (const line of md.split('\n')) {
  if (!line.startsWith('| ') || line.startsWith('| id ') || line.startsWith('|---')) continue
  const c = line.split('|').slice(1, -1).map((x) => x.trim().slice(0, 1024))
  if (c.length !== 10) continue
  const [id, channel, swahili, english, amount, currency, recipient, register, isScam, signal] = c
  rows.push({ id, channel, swahili, english, amount, currency, recipient, register, scam: isScam === 'yes', signal })
  if (rows.length >= 200) break
}
if (rows.length !== 35) throw new Error(`expected 35 rows, parsed ${rows.length}`)

const L = JSON.parse(readFileSync(LABELS, 'utf8'))
const EXPECTED = L.expected_amount || {}
const NAMED = L.named || {}
const SAVED = L.saved_contact_rows || {} // rows whose recipient is a saved demo contact: id -> contact name
const CONFIRMABLE = ['confirm', 'confirm_with_warnings']

const num = (s) => (s === null || s === undefined ? null : String(s).replace(/,/g, '').replace(/\.0+$/, ''))
const results = []
for (const r of rows.filter((x) => !x.scam)) {
  const a = await post('/api/ask?network=devnet', { text: r.swahili, lang: 'sw' })
  const v = a.j.view || {}
  const intent = v.intent || {}
  const exp = EXPECTED[r.id]
  const name = intent.recipient_name || null
  const row = {
    id: r.id, register: r.register, currency: r.currency, text: r.swahili,
    action: intent.action ?? null, amount: num(intent.amount), expected_amount: exp, amount_ok: num(intent.amount) === exp,
    token: intent.token ?? null, recipient_name: name, expected_name: NAMED[r.id] || null,
    name_ok: NAMED[r.id] ? !!name && name.toLowerCase().includes(NAMED[r.id].toLowerCase()) : !name || !v.recipient?.saved,
    resolved_contact: v.recipient?.saved ? v.recipient.name : null,
    decision: v.decision ?? (a.j.ok === false ? 'error' : null),
    codes: (v.groups || []).flatMap((g) => g.lines.filter((l) => l.code).map((l) => l.code)),
    amount_question: v.amountQuestion?.kind || null,
    llm_ms: a.j.steps?.find((s) => s.id === 'llm')?.ms ?? null
  }
  // A confirmable payment is only correct if amount AND resolved contact are the ones in the request, in USDT.
  row.confirmable = CONFIRMABLE.includes(row.decision)
  row.confirmable_correct = row.confirmable ? row.amount_ok && row.currency === 'USDT' && !!SAVED[r.id] && row.resolved_contact === SAVED[r.id] : null
  results.push(row)
  console.log(JSON.stringify(row))
}

const checks = []
for (const r of rows) {
  const c = await post('/api/check', { text: r.swahili, network: 'devnet' })
  const v = c.j.view || {}
  const row = { id: r.id, scam: r.scam, signal: r.signal || null, risk: v.risk ?? 'error', rule_flags: (v.flags || []).map((f) => f.id), ai_flags: v.aiFlags || [], llm_ms: c.j.steps?.find((s) => s.id === 'llm')?.ms ?? null }
  checks.push(row)
  console.log(JSON.stringify(row))
}

// ---- summary
const usdt = results.filter((x) => x.currency === 'USDT')
const kes = results.filter((x) => x.currency === 'KES')
const usd = results.filter((x) => x.currency === 'USD')
const cnt = (xs, f) => xs.filter(f).length
const byReg = {}
for (const x of results) {
  byReg[x.register] ||= { n: 0, amount_ok: 0 }
  byReg[x.register].n++
  if (x.amount_ok) byReg[x.register].amount_ok++
}
const scamRows = checks.filter((x) => x.scam)
const genuine = checks.filter((x) => !x.scam)
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => sorted(xs)[Math.floor(xs.length / 2)]
const summary = {
  dataset: 'sw_requests_commissioned (private; 30 everyday requests + 5 scams, text)',
  model: 'Qwen3-1.7B Q4_0 via @qvac/sdk 0.22.0 + code checks',
  at: new Date().toISOString(),
  usdt_rows: {
    n: usdt.length,
    action_send: cnt(usdt, (x) => x.action === 'send'),
    amount_ok: cnt(usdt, (x) => x.amount_ok),
    token_usdt: cnt(usdt, (x) => x.token === 'USDT'),
    recipient_ok: cnt(usdt, (x) => x.name_ok),
    all_fields_ok: cnt(usdt, (x) => x.action === 'send' && x.amount_ok && x.token === 'USDT' && x.name_ok)
  },
  all_30: {
    amount_ok: cnt(results, (x) => x.amount_ok),
    amount_ok_by_register: byReg,
    named_recipient_ok: `${cnt(results, (x) => x.expected_name && x.name_ok)}/${cnt(results, (x) => x.expected_name)}`,
    confirmable: cnt(results, (x) => x.confirmable),
    confirmable_wrong: cnt(results, (x) => x.confirmable && !x.confirmable_correct),
    kes_rows_confirmable_as_usdt: `${cnt(kes, (x) => x.confirmable)}/${kes.length}`,
    usd_rows_read_as_usdt: `${cnt(usd, (x) => x.token === 'USDT')}/${usd.length}`,
    llm_median_ms: median(results.map((x) => x.llm_ms).filter(Number.isFinite))
  },
  check_mode: {
    scams_high: `${cnt(scamRows, (x) => x.risk === 'high')}/${scamRows.length}`,
    scams_flagged_medium_or_high: `${cnt(scamRows, (x) => ['high', 'medium'].includes(x.risk))}/${scamRows.length}`,
    genuine_high: `${cnt(genuine, (x) => x.risk === 'high')}/${genuine.length}`,
    genuine_medium: `${cnt(genuine, (x) => x.risk === 'medium')}/${genuine.length}`,
    genuine_low_or_none: `${cnt(genuine, (x) => !['high', 'medium'].includes(x.risk))}/${genuine.length}`,
    llm_median_ms: median(checks.map((x) => x.llm_ms).filter(Number.isFinite))
  }
}
writeFileSync(`${OUT}/results.json`, JSON.stringify({ summary, intents: results, checks }, null, 1))
if (PUBLIC) writeFileSync(PUBLIC, JSON.stringify(publicCopy({ summary, intents: results, checks }), null, 1) + '\n')
console.log(JSON.stringify({ summary }, null, 1))

// Outcomes only: no request text, names, amounts or scam descriptions from the private set.
export function publicCopy (r) {
  return {
    summary: r.summary,
    intents: r.intents.map((x) => ({ id: x.id, register: x.register, currency: x.currency, action: x.action, amount_ok: x.amount_ok, token: x.token, name_ok: x.name_ok, decision: x.decision, codes: x.codes, amount_question: x.amount_question, confirmable: x.confirmable, confirmable_correct: x.confirmable_correct, llm_ms: x.llm_ms })),
    checks: r.checks.map((x) => ({ id: x.id, scam: x.scam, risk: x.risk, rule_flags: x.rule_flags, ai_flags: x.ai_flags, llm_ms: x.llm_ms }))
  }
}
