// Sauti Pesa local UI. Plain JavaScript, no framework, no external requests: it only talks to the local
// bridge (same origin). All text from the engine is inserted with textContent (never as HTML).
import { T, EXAMPLES } from './i18n.js'

// ------------------------------------------------------------------ small helpers
const store = {
  get (k, d) { try { const v = localStorage.getItem(`sauti.${k}`); return v === null ? d : v } catch { return d } },
  set (k, v) { try { localStorage.setItem(`sauti.${k}`, v) } catch {} }
}
const S = {
  lang: ['sw', 'en'].includes(store.get('lang', 'sw')) ? store.get('lang', 'sw') : 'sw',
  network: ['devnet', 'sepolia'].includes(store.get('network', '')) ? store.get('network', '') : null,
  tab: 'send',
  status: null,
  statusErr: null,
  contacts: [],
  outbox: [],
  job: null,
  last: null, // { steps: [...], at }
  F: { mode: 'idle', text: '' }, // send flow
  C: { text: '', res: null, busy: false } // check flow
}
// The bridge only answers API calls that carry this launch's key. ops/ui.sh prints a link with the key in the
// #fragment (never sent over the network); keep it for this tab only and take it out of the address bar.
const KEY = (() => {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{32,128})(?:&|$)/.exec(location.hash)
  if (m) {
    try { sessionStorage.setItem('sauti.key', m[1]) } catch {}
    try { history.replaceState(null, '', location.pathname + location.search) } catch {}
    return m[1]
  }
  try { const k = sessionStorage.getItem('sauti.key'); return /^[A-Za-z0-9_-]{32,128}$/.test(k || '') ? k : '' } catch { return '' }
})()
const $ = (id) => document.getElementById(id)
const t = (k, ...a) => { const v = T[S.lang][k] ?? T.en[k] ?? k; return typeof v === 'function' ? v(...a) : v }
const L = (o) => (o && typeof o === 'object' ? (o[S.lang] ?? o.en ?? '') : String(o ?? ''))

function h (tag, props, ...kids) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style') el.style.cssText = v // CSSOM, allowed by the page's CSP (style attributes are not)
      else if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of kids.flat(3)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  wifioff: '<path d="M3 3l18 18"/><path d="M8.5 16.4a5 5 0 0 1 6.2-.6"/><path d="M5 12.8a10 10 0 0 1 4.4-2.4"/><path d="M19 12.8a10 10 0 0 0-2.3-1.6"/><path d="M2 9a15 15 0 0 1 4-2.6"/><path d="M22 9a15 15 0 0 0-10.5-4"/><path d="M12 20h.01"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5"/>',
  plane: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.5 21.5l-4-8-8-4 19-7z"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4"/><path d="M12 14h.01"/>',
  tray: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19a14.5 14.5 0 0 1 0-19z"/>',
  ext: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  cloudoff: '<path d="M3 3l18 18"/><path d="M6 6.6A6.5 6.5 0 0 0 7 19h10"/><path d="M21.3 15.6A4.5 4.5 0 0 0 17.5 9h-1A6.5 6.5 0 0 0 9.3 4.6"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  wave: '<path d="M3 12h1.5M7 8.5v7M11 5v14M15 8v8M19 10.5v3M21.5 12h0"/>',
  spark: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3"/><path d="M17 6l3 3"/><path d="M14.5 8.5l2 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>'
}
function icon (name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('fill', 'none')
  s.setAttribute('stroke', 'currentColor')
  s.setAttribute('stroke-width', '2')
  s.setAttribute('stroke-linecap', 'round')
  s.setAttribute('stroke-linejoin', 'round')
  s.setAttribute('aria-hidden', 'true')
  s.innerHTML = ICONS[name] || '' // fixed strings from this file only
  return s
}

async function api (path, { method = 'GET', json, body, type } = {}) {
  const headers = { 'x-sauti-key': KEY }
  let payload
  if (json !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(json) } else if (body) { headers['content-type'] = type; payload = body }
  let r
  try { r = await fetch(path, { method, headers, body: payload, cache: 'no-store' }) } catch { return { ok: false, status: 0, error: 'bridge unreachable' } }
  let j = null
  try { j = await r.json() } catch {}
  if (!j) return { ok: false, status: r.status, error: `HTTP ${r.status}` }
  j.status = r.status
  if (!r.ok) j.ok = false
  return j
}

function toast (msg, ms = 3200) {
  const el = h('div', { class: 'toast', role: 'status', text: msg })
  document.body.append(el)
  setTimeout(() => el.remove(), ms)
}

const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
const fmtAmt = (a) => { if (a === null || a === undefined) return '—'; const n = Number(a); return isNaN(n) ? String(a) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) }
const secs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const netId = () => S.network || S.status?.network?.id || 'devnet'

function addrNode (a) {
  if (!a || a.length !== 42) return h('span', { class: 'addr', text: a || '' })
  return h('span', { class: 'addr' }, h('b', { text: a.slice(0, 6) }), a.slice(6, 38), h('b', { text: a.slice(38) }))
}

// ------------------------------------------------------------------ status, balance, pill, tabs
async function refreshStatus () {
  const r = await api(`/api/status?network=${netId()}`)
  S.noKey = r.status === 401
  if (r.ok) { S.status = r; S.statusErr = null; if (!S.network) S.network = r.network.id } else { S.statusErr = r.error || 'error'; if (r.status === 0 || r.status >= 500) S.status = S.status && { ...S.status, engine: { ...S.status.engine, ready: false, stage: 'down' } } }
  renderChrome()
  if (S.tab === 'send' && S.F.mode === 'idle') updateIdleReady()
}

function renderChrome () {
  document.documentElement.lang = S.lang
  $('tagline').textContent = t('tagline')
  for (const b of $('langSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.lang === S.lang))
  renderPill()
  renderBalance()
  renderTabs()
  renderSide()
}

function renderPill () {
  const st = S.status
  const p = $('pill')
  // rebuild only when what it shows changes (a rebuild every 4 s would restart its pulse forever)
  const sig = JSON.stringify([S.lang, !!S.statusErr, !!S.noKey, st?.engine?.ready, st?.engine?.stage, st?.net?.online])
  if (p.dataset.sig === sig) return
  p.dataset.sig = sig
  p.className = 'pill'
  if (!st || S.statusErr || st.engine?.stage === 'down') {
    p.classList.add('down')
    p.replaceChildren(icon('alert'), h('span', { class: 'grow' }, h('span', { text: S.noKey ? t('pillNoKey') : t('pillDown') })))
    return
  }
  if (!st.engine.ready) {
    p.classList.add('loading')
    p.replaceChildren(h('span', { class: 'spinner', style: 'width:15px;height:15px;border-width:2px' }), h('span', { class: 'grow' }, h('span', { text: `${t('pillLoading')} ${t(`stage_${st.engine.stage}`)}` })))
    return
  }
  if (st.net.online) {
    p.classList.add('online')
    p.replaceChildren(icon('alert'), h('span', { class: 'grow' }, h('span', { text: t('pillAi') }), h('span', { class: 'sep', text: '·' }), h('span', { text: t('pillNetOn') })))
    return
  }
  p.replaceChildren(
    h('span', { class: 'live' }),
    h('span', { class: 'grow' },
      h('span', { text: t('pillAi') }), h('span', { class: 'sep', text: '·' }), h('span', { text: t('pillNetOff') }),
      h('span', { class: 'vfy' }, icon('shield'), t('pillVerified'))),
    icon('chev')
  )
  p.setAttribute('aria-label', `${t('pillAi')}. ${t('pillNetOff')} (${t('pillVerified')})`)
}

function renderBalance () {
  const st = S.status
  const c = st?.chain
  $('balance').replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: 'lbl', text: t('balance') }),
      h('button', { class: 'net-chip', id: 'netChip', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${t('networkMenu')}: ${t(`net_${netId()}`)}`, onclick: openNetMenu },
        h('span', { class: 'dot' }), t(`net_${netId()}`), icon('chev'))),
    h('div', { class: 'amt' }, c?.usdt === null || c?.usdt === undefined ? '—' : fmtAmt(c.usdt), h('small', { text: 'USDT' })),
    h('div', { class: 'meta' },
      h('span', { class: 'badge', text: t('testUsdt') }),
      h('span', { text: c?.syncedAt ? `${t('synced')} ${fmtTime(c.syncedAt)}` : t('neverSynced') }),
      st?.wallet ? h('code', { text: st.wallet.short }) : null)
  )
}

const TABS = [['send', 'plane', 'tabSend'], ['check', 'msg', 'tabCheck'], ['outbox', 'tray', 'tabOutbox'], ['contacts', 'users', 'tabContacts']]
function renderTabs () {
  const waiting = (S.status?.outbox?.queued || 0) + (S.status?.outbox?.needs_resign || 0)
  $('tabs').replaceChildren(...TABS.map(([id, ic, label]) => h('button', {
    type: 'button',
    'aria-current': S.tab === id ? 'page' : null,
    onclick: () => setTab(id)
  }, icon(ic), t(label), id === 'outbox' && waiting ? h('span', { class: 'count', text: String(waiting) }) : null)))
}

function setTab (id) {
  S.tab = id
  renderTabs()
  renderView()
  if (id === 'outbox') refreshOutbox()
  if (id === 'contacts' || id === 'send') refreshContacts()
  window.scrollTo({ top: 0 })
}

// ------------------------------------------------------------------ side panel (desktop)
const STEP_META = {
  asr: { icon: 'wave', key: 'stepAsr' },
  llm: { icon: 'spark', key: 'stepLlm' },
  checks: { icon: 'shield', key: 'stepChecks' },
  sign: { icon: 'key', key: 'stepSign' }
}
function stepDetail (s) {
  if (s.id === 'asr') return `whisper small q8_0 · ${t('audioSec', s.audio_s ?? '?')}`
  if (s.id === 'llm') return `Qwen3-1.7B Q4_0 · ${s.cached_tokens !== null && s.cached_tokens !== undefined ? t('tokensCached', s.cached_tokens, s.prompt_tokens ?? '?') : 'QVAC'}`
  if (s.id === 'checks') return t('checksCount', s.count || 6)
  if (s.id === 'sign') return t('policy')
  return ''
}
function renderSide () {
  const side = $('side')
  if (!window.matchMedia('(min-width: 980px)').matches) { side.replaceChildren(); return }
  const steps = S.last?.steps || []
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]))
  const order = ['asr', 'llm', 'checks', 'sign']
  const total = steps.reduce((a, s) => a + (s.ms || 0), 0)
  const st = S.status
  const n = st?.net
  const err = (x) => (x?.ok ? h('span', { text: t('reachable') }) : h('span', { class: 'ok', text: `${t('failed')} · ${x?.error || '?'}` }))
  side.replaceChildren(
    h('section', { class: 'panel' },
      h('h2', null, icon('chip'), t('panelTitle')),
      h('p', { class: 'sub', text: steps.length ? `${t('lastRequest')} · ${fmtTime(S.last.at)}` : t('nothingYet') }),
      h('div', { class: 'pipe' }, order.map((id) => {
        const s = byId[id]
        const m = STEP_META[id]
        return h('div', { class: `p${s ? '' : ' idle'}` },
          h('span', { class: 'ic' }, icon(m.icon)),
          h('div', null, h('div', { class: 'nm', text: `${t(m.key)} · ${t('onDevice')}` }), h('div', { class: 'md', text: s ? stepDetail(s) : '' })),
          h('span', { class: 'ms', text: s ? secs(s.ms) : '—' }))
      })),
      steps.length ? h('div', { class: 'total' }, h('span', { text: t('total') }), h('b', { text: secs(total) })) : null
    ),
    h('section', { class: 'panel' },
      h('h2', null, icon('wifioff'), t('proofTitle')),
      h('p', { class: 'sub', text: n ? `sandbox: ${n.sandbox} (bwrap --unshare-net)` : '—' }),
      n ? h('dl', { class: 'netproof' },
        h('dt', { text: t('ifaces') }), h('dd', { text: (n.interfaces || []).join(', ') }),
        h('dt', { text: `${t('tcp')} ${n.tcp_ipv4.target}` }), h('dd', null, err(n.tcp_ipv4)),
        h('dt', { text: `${t('tcp')} IPv6` }), h('dd', null, err(n.tcp_ipv6)),
        h('dt', { text: `${t('dns')} ${n.dns.target}` }), h('dd', null, err(n.dns)),
        h('dt', { text: t('checkedAt') }), h('dd', { text: new Date(n.at).toLocaleTimeString('en-GB', { hourCycle: 'h23' }) })) : null
    ),
    h('section', { class: 'panel' },
      h('h2', null, icon('globe'), t('netNeededFor')),
      h('ul', { class: 'mini' },
        h('li', null, icon('plane'), t('netNeeded1')),
        h('li', null, icon('refresh'), t('netNeeded2')),
        h('li', null, icon('upload'), t('netNeeded3'))),
      h('h3', { class: 'section-title', style: 'margin-top:14px', text: t('models') }),
      h('ul', { class: 'mini' },
        h('li', null, icon('wave'), h('code', { text: st?.engine?.models?.asr || 'whisper small q8_0' })),
        h('li', null, icon('spark'), h('code', { text: st?.engine?.models?.llm || 'Qwen3-1.7B Q4_0' })),
        h('li', null, icon('chip'), h('code', { text: `${st?.engine?.models?.sdk || '@qvac/sdk'} · ${t('memory')} ${st?.engine?.rssMb ? (st.engine.rssMb / 1024).toFixed(1) + ' GB' : '—'}` })))
    )
  )
}

function pushSteps (steps, reset = false) {
  if (reset || !S.last) S.last = { steps: [], at: new Date().toISOString() }
  for (const s of steps || []) {
    const i = S.last.steps.findIndex((x) => x.id === s.id)
    if (i >= 0) S.last.steps[i] = s; else S.last.steps.push(s)
  }
  S.last.at = new Date().toISOString()
  renderSide()
}

// ------------------------------------------------------------------ views
function renderView () {
  const v = $('view')
  const kids = S.tab === 'send' ? sendView() : S.tab === 'check' ? checkView() : S.tab === 'outbox' ? outboxView() : contactsView()
  v.replaceChildren(...kids.filter(Boolean))
}

const engineReady = () => !!S.status?.engine?.ready && !S.statusErr

function loadingCard () {
  const st = S.status
  if (engineReady()) return null
  const down = !st || S.statusErr || st.engine?.stage === 'down'
  return h('div', { class: 'card loading-card' }, down ? icon('alert') : h('span', { class: 'spinner' }),
    h('div', null, h('b', { text: down ? (S.noKey ? t('noKey') : t('engineDown')) : `${t('engineLoading')}…` }), down ? null : h('div', { class: 'sub', text: t(`stage_${st.engine.stage}`) })))
}

function updateIdleReady () {
  const ready = engineReady()
  const mic = document.querySelector('.mic')
  if (mic) mic.disabled = !ready && S.F.mode !== 'rec'
  const send = document.querySelector('.composer .iconbtn')
  if (send) send.disabled = !ready
  const lc = document.querySelector('.loading-card')
  if (ready && lc) lc.remove()
  if (!ready && !lc && S.tab === 'send') { const c = loadingCard(); if (c) $('view').prepend(c) }
}

// ---- send tab
function sendView () {
  const F = S.F
  if (F.mode === 'idle' || F.mode === 'rec') return idleView()
  if (F.mode === 'busy') return [busyView()]
  if (F.mode === 'result') return [resultView()]
  if (F.mode === 'signed') return [signedView()]
  return idleView()
}

function idleView () {
  const rec = S.F.mode === 'rec'
  const ready = engineReady()
  const input = h('input', {
    type: 'text', id: 'reqText', maxlength: '500', autocomplete: 'off', enterkeyhint: 'send',
    placeholder: t('placeholder'), 'aria-label': t('placeholder'),
    oninput: (e) => { S.F.text = e.target.value },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitText() } }
  })
  input.value = S.F.text || ''
  return [
    loadingCard(),
    h('div', { class: 'card hero' },
      h('button', { class: `mic${rec ? ' rec' : ''}`, type: 'button', disabled: !ready && !rec, 'aria-label': rec ? t('micStop') : t('micIdle'), onclick: toggleRec },
        h('span', { class: 'ring' }), icon(rec ? 'stop' : 'mic')),
      h('div', { class: 'mic-label', text: rec ? t('micRec') : t('micIdle') }),
      rec ? h('div', { class: 'meter', id: 'meter' }, Array.from({ length: 14 }, () => h('i'))) : h('div', { class: 'mic-hint', text: t('micHint') }),
      rec ? h('div', { class: 'timer', id: 'recTimer', text: '0:00' }) : h('button', { class: 'linkbtn', type: 'button', onclick: () => $('voiceFile').click(), disabled: !ready }, icon('upload'), t('uploadVoice'))
    ),
    h('div', { class: 'divider', text: t('or') }),
    h('div', { class: 'composer' }, input, h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('sendText'), disabled: !ready, onclick: submitText }, icon('arrow'))),
    S.contacts.length ? h('div', { class: 'section-title', text: t('people') }) : null,
    S.contacts.length ? h('div', { class: 'people' }, S.contacts.map((c) => h('button', {
      class: 'person', type: 'button',
      onclick: () => {
        const x = $('reqText')
        S.F.text = S.lang === 'sw' ? `Tuma USDT  kwa ${c.name}` : `Send  USDT to ${c.name}`
        x.value = S.F.text
        x.focus()
        const pos = S.lang === 'sw' ? 10 : 5
        x.setSelectionRange(pos, pos)
      }
    }, h('span', { class: 'avatar', text: c.initials }), c.name))) : null
  ]
}

const STEP_ORDER_VOICE = ['asr', 'llm', 'checks']
const STEP_ORDER_TEXT = ['llm', 'checks']
function busyView () {
  const F = S.F
  const order = F.source === 'voice' ? STEP_ORDER_VOICE : STEP_ORDER_TEXT
  return h('div', { class: 'card' },
    h('h2', { text: F.source === 'voice' ? t('stepAsr') : t('stepLlm') }),
    F.transcript ? heardBlock(F.transcript, F.source) : null,
    h('div', { class: 'steps' }, order.map((id) => {
      const st = F.steps?.[id]
      const state = st?.done ? 'done' : st?.run ? 'run' : ''
      return h('div', { class: `step ${state}` },
        h('span', { class: 'ic' }, icon(state === 'done' ? 'check' : state === 'run' ? 'loader' : STEP_META[id].icon)),
        h('span', { text: t(STEP_META[id].key) }), h('span', { class: 'tag', text: t('onDevice') }),
        h('span', { class: 'ms', text: st?.ms !== undefined ? secs(st.ms) : '' }))
    }))
  )
}

// "HATARI KUBWA: usitume pesa." under a "HATARI KUBWA" title reads twice: show only the rest
function headlineRest (headline, label) {
  const s = String(headline || '')
  if (!label || !s.toLowerCase().startsWith(label.toLowerCase())) return s
  const rest = s.slice(label.length).replace(/^\s*[:.\-–]\s*/, '')
  return rest ? rest[0].toUpperCase() + rest.slice(1) : s
}

function heardBlock (text, source) {
  return h('div', { class: 'heard' },
    h('div', { class: 'k' }, icon(source === 'voice' ? 'wave' : 'pen'), source === 'voice' ? t('youSaid') : t('youTyped')),
    h('q', { text }))
}

function passedList (groups) {
  if (!groups.length) return null
  return h('ul', { class: 'passed' }, groups.map((g) => h('li', null, h('span', { class: 'ic' }, icon('check')), h('span', null, h('b', { text: `${L(g.title)} ` }), L(g.lines[0])))))
}

function groupNode (g) {
  return h('div', { class: `grp ${g.status === 'ok' ? '' : g.status}` },
    h('span', { class: 'ic' }, icon(g.status === 'ok' ? 'check' : g.status === 'warn' ? 'alert' : 'x')),
    h('div', null, h('div', { class: 't', text: L(g.title) }), h('ul', null, g.lines.map((l) => h('li', { text: L(l) })))))
}

function payeeNode (v) {
  const r = v.recipient
  if (!r) return null
  const rel = S.lang === 'sw' ? r.relation_sw : r.relation_en
  return h('div', { class: 'payee' },
    h('span', { class: `avatar lg${r.saved ? '' : ' addr'}`, text: r.saved ? r.initials : '0x' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'nm', text: r.name || t('newAddress') }),
      rel ? h('div', { class: 'rel', text: rel }) : null,
      addrNode(r.address)))
}

function resultView () {
  const F = S.F
  const res = F.res
  const v = res.view
  const kids = [heardBlock(v?.transcript || F.transcript || '', F.source)]
  if (!res.ok || !v?.ok) {
    kids.push(h('div', { class: 'banner warn', style: 'margin-top:12px' }, h('span', { class: 'ic' }, icon('alert')), h('div', null, h('b', { text: t('notUnderstood') }), h('span', { text: t('unknownAction') }))))
    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: resetFlow }, t('startOver'))))
    return h('div', { class: 'card' }, kids)
  }
  if (v.action !== 'send') {
    const msg = v.action === 'balance' ? t('balanceAnswer', v.balance?.usdt ? fmtAmt(v.balance.usdt) : null, fmtTime(v.balance?.at)) : v.action === 'check_message' ? t('checkSuggest') : t('unknownAction')
    kids.push(h('div', { class: 'banner info', style: 'margin-top:12px' }, h('span', { class: 'ic' }, icon(v.action === 'balance' ? 'info' : 'msg')), h('div', null, h('b', { text: v.action === 'balance' ? t('balance') : t('tabCheck') }), h('span', { text: msg }))))
    kids.push(h('div', { class: 'actions' },
      v.action === 'check_message' ? h('button', { class: 'btn primary', type: 'button', onclick: () => { S.C.text = v.transcript; resetFlow(); setTab('check') } }, t('checkTitle')) : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: resetFlow }, t('newPayment'))))
    return h('div', { class: 'card' }, kids)
  }

  const flagged = v.groups.filter((g) => g.status !== 'ok')
  const passed = v.groups.filter((g) => g.status === 'ok')
  if (v.hardBlock) {
    kids.push(h('div', { class: 'banner bad', style: 'margin-top:12px' }, h('span', { class: 'ic' }, icon('x')), h('div', null, h('b', { text: t('blockedTitle') }), h('span', { text: t('blockedSub') }))))
    if (v.amount) kids.push(h('div', { class: 'amount-big' }, fmtAmt(v.amount), h('small', { text: 'USDT' })))
    kids.push(payeeNode(v))
    kids.push(h('h3', { text: t('checks') }), h('div', { class: 'groups' }, flagged.map(groupNode)), passedList(passed))
    kids.push(flagsNode(v.scamFlags, v.aiFlags, v.aiNote))
    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: resetFlow }, t('okGotIt'))))
    return h('div', { class: 'card' }, kids)
  }
  if (v.amountQuestion || v.contactQuestion) {
    kids.push(h('div', { class: 'confirm-top', style: 'margin-top:12px' }, h('h2', { text: t('questionTitle') })))
    if (v.amount && !v.amountQuestion) kids.push(h('div', { class: 'amount-big' }, fmtAmt(v.amount), h('small', { text: 'USDT' })))
    if (!v.contactQuestion) kids.push(payeeNode(v))
    if (v.amountQuestion) kids.push(amountQuestionNode(v.amountQuestion))
    else kids.push(contactQuestionNode(v.contactQuestion))
    const others = flagged.filter((g) => !(v.amountQuestion && g.id === 'amount') && !(v.contactQuestion && g.id === 'recipient'))
    if (others.length) kids.push(h('div', { class: 'groups', style: 'margin-top:12px' }, others.map(groupNode)))
    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: resetFlow }, t('cancel'))))
    return h('div', { class: 'card' }, kids)
  }
  // ready to confirm
  kids.push(h('div', { class: 'confirm-top', style: 'margin-top:12px' }, h('h2', { text: t('confirmTitle') }), h('span', { class: 'status queued', text: t('testBadge') })))
  kids.push(h('div', { class: 'sub', text: t('sending') }))
  kids.push(h('div', { class: 'amount-big' }, fmtAmt(v.amount), h('small', { text: 'USDT' })))
  kids.push(payeeNode(v))
  if (v.memo) kids.push(h('div', { class: 'memo' }, h('span', { text: `${t('forWhat')}: ` }), v.memo))
  kids.push(h('h3', { text: t('checks') }), flagged.length ? h('div', { class: 'groups' }, flagged.map(groupNode)) : null, passedList(passed))
  kids.push(flagsNode(v.scamFlags, v.aiFlags, v.aiNote))
  kids.push(h('div', { class: 'netbadge' }, icon('cloudoff'), h('div', null, h('b', { text: t('needsNet') }), h('span', { text: t('needsNetSub') }))))
  let retypeInput = null
  const confirmBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => doConfirm(retypeInput?.value) }, icon('key'), t('confirmBtn'))
  if (v.needsRetype) {
    const err = h('div', { class: 'err' })
    retypeInput = h('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '20', 'aria-label': t('retypeLabel'),
      oninput: (e) => {
        const ok = normAmt(e.target.value) === normAmt(v.amount)
        confirmBtn.disabled = !ok
        err.textContent = e.target.value && !ok && normAmt(e.target.value).length >= normAmt(v.amount).length ? t('retypeMismatch') : ''
      },
      onkeydown: (e) => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click() }
    })
    confirmBtn.disabled = true
    kids.push(h('div', { class: 'retype' }, h('label', { text: t('retypeLabel') }), retypeInput, err))
  }
  kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn ghost narrow', type: 'button', onclick: resetFlow }, t('cancel')), confirmBtn))
  return h('div', { class: 'card' }, kids)
}

const normAmt = (s) => String(s || '').trim().replace(/,/g, '').replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

function flagsNode (scamFlags, aiFlags, aiNote) {
  if (!scamFlags?.length && !aiFlags?.length && !aiNote) return null
  return h('div', null,
    scamFlags?.length ? h('ul', { class: 'flags' }, scamFlags.map((f) => h('li', null, icon('alert'), h('span', { text: L(f) })))) : null,
    aiFlags?.length ? h('div', { class: 'sub', style: 'margin-top:8px', text: `${t('aiAlso')}: ${aiFlags.join(', ')}` }) : null,
    aiNote ? h('div', { class: 'ai-note' }, h('b', { text: t('aiNote') }), aiNote) : null)
}

function amountQuestionNode (q) {
  if (q.kind === 'did_you_mean' && !S.F.typeAmount) {
    return h('div', { class: 'question' },
      h('div', { class: 'q', text: t('didYouMeanAmount', q.amount) }),
      h('div', { class: 'chips' },
        h('button', { class: 'chip primary', type: 'button', onclick: () => doAmend({ amount: q.amount }) }, icon('check'), t('yesAmount', q.amount)),
        h('button', { class: 'chip', type: 'button', onclick: () => { S.F.typeAmount = true; renderView() } }, t('noTypeIt'))))
  }
  if (q.kind === 'choose' && !S.F.typeAmount) {
    return h('div', { class: 'question' },
      h('div', { class: 'q', text: t('chooseAmount') }),
      h('div', { class: 'chips' }, q.amounts.map((a) => h('button', { class: 'chip', type: 'button', onclick: () => doAmend({ amount: a }) }, `${a} USDT`)),
        h('button', { class: 'chip', type: 'button', onclick: () => { S.F.typeAmount = true; renderView() } }, t('noTypeIt'))))
  }
  const inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '20', 'aria-label': t('howMuch'), placeholder: '0', onkeydown: (e) => { if (e.key === 'Enter') go() } })
  const go = () => { const a = normAmt(inp.value); if (/^\d{1,9}(\.\d{1,6})?$/.test(a) && Number(a) > 0) doAmend({ amount: a }); else inp.focus() }
  setTimeout(() => inp.focus(), 50)
  return h('div', { class: 'question' }, h('div', { class: 'q', text: t('howMuch') }),
    h('div', { class: 'ask' }, inp, h('button', { class: 'btn primary small', type: 'button', onclick: go }, t('continueBtn'))))
}

function contactQuestionNode (q) {
  return h('div', { class: 'question' },
    h('div', { class: 'q', text: q.kind === 'pick' ? (q.said ? t('whoDidYouMean', q.said) : t('pickFromContacts')) : t('whoDidYouMean', q.said) }),
    h('div', { class: 'chips' }, q.candidates.map((c) => h('button', { class: 'chip', type: 'button', onclick: () => doAmend({ contactId: c.id }) },
      h('span', { class: 'avatar', text: c.initials }), c.name, h('span', { class: 'sub', text: S.lang === 'sw' ? c.relation_sw || '' : c.relation_en || '' })))))
}

function signedView () {
  const q = S.F.signed
  return h('div', { class: 'card success' },
    h('div', { class: 'big' }, icon('check')),
    h('h2', { text: t('signedTitle') }),
    h('p', { class: 'sub', text: t('signedSub') }),
    h('dl', { class: 'kv' },
      h('dt', { text: t('sending') }), h('dd', { text: `${fmtAmt(q.amount)} USDT` }),
      h('dt', { text: t('to') }), h('dd', { text: `${q.recipientName || ''} ${q.short}` }),
      h('dt', { text: 'nonce' }), h('dd', { text: String(q.nonce) }),
      h('dt', { text: 'tx' }), h('dd', { text: q.hashShort }),
      h('dt', { text: 'status' }), h('dd', null, h('span', { class: 'status queued', text: t('st_queued') }))),
    h('div', { class: 'netbadge', style: 'text-align:left' }, icon('cloudoff'), h('div', null, h('b', { text: t('needsNet') }), h('span', { text: t('broadcasterNote') }))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: resetFlow }, t('newPayment')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { resetFlow(); setTab('outbox') } }, icon('tray'), t('viewOutbox'))))
}

function resetFlow () {
  stopRecording(true)
  S.F = { mode: 'idle', text: '' }
  renderView()
}

// ---- actions: text, voice, amend, confirm
function errText (r) {
  if (r.status === 429) return t('busy')
  if (r.status === 410) return t('expired')
  return r.error || 'error'
}

async function submitText () {
  const text = (S.F.text || '').trim()
  if (!text || !engineReady() || S.F.mode === 'busy') return
  await runAsk(text, 'text')
}

async function runAsk (text, source, asrStep) {
  S.F = { mode: 'busy', source, transcript: source === 'voice' ? text : null, text: source === 'text' ? text : '', steps: { ...(asrStep ? { asr: { done: true, ms: asrStep.ms } } : {}), llm: { run: true }, checks: {} } }
  if (source === 'text') pushSteps([], true)
  renderView()
  const r = await api(`/api/ask?network=${netId()}`, { method: 'POST', json: { text, lang: S.lang } })
  if (!r.ok && !r.view) {
    S.F = { mode: 'idle', text: source === 'text' ? text : '' }
    renderView()
    toast(errText(r))
    return
  }
  pushSteps(r.steps)
  S.F = { mode: 'result', source, transcript: text, res: r, sid: r.sid }
  renderView()
}

async function doAmend (change) {
  const r = await api('/api/amend', { method: 'POST', json: { sid: S.F.sid, ...change } })
  if (!r.ok) { toast(errText(r)); if (r.status === 410) resetFlow(); return }
  pushSteps(r.steps)
  S.F.res = r
  S.F.typeAmount = false
  renderView()
}

async function doConfirm (retype) {
  const btn = document.querySelector('.actions .btn.primary')
  if (btn) btn.disabled = true
  const r = await api('/api/confirm', { method: 'POST', json: { sid: S.F.sid, ...(retype !== undefined ? { retype } : {}) } })
  if (!r.ok) { toast(errText(r)); if (btn) btn.disabled = false; if (r.status === 410) resetFlow(); return }
  pushSteps(r.steps)
  S.F = { mode: 'signed', signed: r.queued }
  renderView()
  refreshStatus()
}

// ---- microphone: Web Audio -> 16 kHz mono PCM16 WAV, encoded in the page
const R = { stream: null, ctx: null, node: null, src: null, chunks: [], t0: 0, tick: null, levels: [] }
const MAX_REC_S = 25

async function toggleRec () {
  if (S.F.mode === 'rec') return finishRecording()
  if (!engineReady()) return
  try {
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch { toast(t('micDenied')); return }
  try {
    try { R.ctx = new AudioContext({ sampleRate: 16000 }) } catch { R.ctx = new AudioContext() }
    await R.ctx.audioWorklet.addModule('/recorder-worklet.js')
    R.src = R.ctx.createMediaStreamSource(R.stream)
    R.node = new AudioWorkletNode(R.ctx, 'pcm-recorder')
    R.chunks = []
    R.levels = []
    R.node.port.onmessage = (e) => {
      const c = e.data
      R.chunks.push(c)
      let sum = 0
      for (let i = 0; i < c.length; i++) sum += c[i] * c[i]
      R.levels.push(Math.sqrt(sum / c.length))
    }
    const mute = R.ctx.createGain()
    mute.gain.value = 0
    R.src.connect(R.node).connect(mute).connect(R.ctx.destination)
  } catch { stopRecording(true); toast(t('micDenied')); return }
  R.t0 = performance.now()
  S.F = { mode: 'rec', text: S.F.text || '' }
  renderView()
  R.tick = setInterval(() => {
    const s = (performance.now() - R.t0) / 1000
    const el = $('recTimer')
    if (el) el.textContent = `0:${String(Math.floor(s)).padStart(2, '0')}`
    const bars = $('meter')?.children || []
    const lv = R.levels.slice(-bars.length)
    for (let i = 0; i < bars.length; i++) bars[i].style.height = `${Math.max(4, Math.min(26, (lv[i] || 0) * 220))}px`
    if (s >= MAX_REC_S) finishRecording()
  }, 90)
}

function stopRecording (discard) {
  if (R.tick) clearInterval(R.tick)
  R.tick = null
  try { R.src?.disconnect(); R.node?.disconnect() } catch {}
  try { R.stream?.getTracks().forEach((x) => x.stop()) } catch {}
  const sr = R.ctx?.sampleRate || 16000
  try { R.ctx?.close() } catch {}
  const chunks = R.chunks
  Object.assign(R, { stream: null, ctx: null, node: null, src: null, chunks: [] })
  if (discard) return null
  let n = 0
  for (const c of chunks) n += c.length
  const all = new Float32Array(n)
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.length }
  return { samples: all, sr }
}

async function finishRecording () {
  const rec = stopRecording(false)
  if (!rec || rec.samples.length < rec.sr * 0.4) { S.F = { mode: 'idle', text: S.F.text || '' }; renderView(); toast(t('noSpeech')); return }
  const pcm = resample(rec.samples, rec.sr, 16000)
  await sendVoice(encodeWav(pcm, 16000))
}

async function sendVoice (blob) {
  pushSteps([], true)
  S.F = { mode: 'busy', source: 'voice', steps: { asr: { run: true }, llm: {}, checks: {} } }
  renderView()
  const r = await api(`/api/voice?network=${netId()}&lang=${S.lang}`, { method: 'POST', body: blob, type: 'audio/wav' })
  if (!r.ok) {
    S.F = { mode: 'idle', text: '' }
    renderView()
    if (r.steps) pushSteps(r.steps)
    toast(r.errors?.[0] === 'no speech heard' ? t('noSpeech') : errText(r))
    return
  }
  pushSteps(r.steps)
  await runAsk(r.transcript, 'voice', r.steps?.[0])
}

function resample (x, from, to) {
  if (from === to) return x
  const ratio = from / to
  const n = Math.floor(x.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // average the source samples that fall into this output sample (simple anti-aliasing)
    const a = Math.floor(i * ratio)
    const b = Math.min(x.length, Math.max(a + 1, Math.floor((i + 1) * ratio)))
    let s = 0
    for (let k = a; k < b; k++) s += x[k]
    out[i] = s / (b - a)
  }
  return out
}

function encodeWav (f32, sr) {
  const buf = new ArrayBuffer(44 + f32.length * 2)
  const v = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true)
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f32.length * 2, true)
  let o = 44
  for (let i = 0; i < f32.length; i++) { const c = Math.max(-1, Math.min(1, f32[i])); v.setInt16(o, c < 0 ? c * 0x8000 : c * 0x7fff, true); o += 2 }
  return new Blob([buf], { type: 'audio/wav' })
}

// voice notes from a file: WAV goes as is (the engine checks it); other formats are decoded by the browser
async function onVoiceFile (e) {
  const f = e.target.files?.[0]
  e.target.value = ''
  if (!f || !engineReady()) return
  if (f.size > 5 * 1024 * 1024) { toast('max 5 MB'); return }
  const buf = await f.arrayBuffer()
  const head = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, Math.min(12, buf.byteLength)))
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return sendVoice(new Blob([buf], { type: 'audio/wav' }))
  try {
    const ctx = new OfflineAudioContext(1, 16000 * 30, 16000)
    const audio = await ctx.decodeAudioData(buf)
    const n = Math.min(audio.length, audio.sampleRate * 30)
    const mono = new Float32Array(n)
    for (let ch = 0; ch < audio.numberOfChannels; ch++) { const d = audio.getChannelData(ch); for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels }
    return sendVoice(encodeWav(resample(mono, audio.sampleRate, 16000), 16000))
  } catch { toast(t('micDenied')) }
}

// ---- check tab
function checkView () {
  const ta = h('textarea', { maxlength: '2000', placeholder: t('checkPlaceholder'), 'aria-label': t('checkPlaceholder'), oninput: (e) => { S.C.text = e.target.value } })
  ta.value = S.C.text || ''
  const ex = (k, label) => h('button', { class: 'chip', type: 'button', onclick: () => { S.C.text = EXAMPLES[k]; ta.value = S.C.text; S.C.res = null; renderView() } }, label)
  const out = [loadingCard(), h('div', { class: 'card' },
    h('h2', { text: t('checkTitle') }),
    h('p', { class: 'sub', style: 'margin-bottom:12px', text: t('checkSub') }),
    ta,
    h('div', { class: 'section-title', style: 'margin:10px 2px 6px', text: t('examples') }),
    h('div', { class: 'chips' }, ex('prize', t('exPrize')), ex('address', t('exAddress')), ex('wrong', t('exWrong')), ex('hello', t('exHello'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', disabled: S.C.busy || !engineReady(), onclick: runCheck }, S.C.busy ? h('span', { class: 'spinner', style: 'border-color:rgba(255,255,255,.35);border-top-color:#fff' }) : icon('shield'), t('checkBtn')))
  )]
  const r = S.C.res
  if (r?.view) {
    const v = r.view
    const tone = v.risk === 'high' ? 'bad' : v.risk === 'none' ? 'ok' : 'warn'
    out.push(h('div', { class: `card risk-${v.risk}` },
      h('div', { class: `banner ${tone}` }, h('span', { class: 'ic' }, icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'x' : 'alert')), h('div', null, h('b', { text: t(`risk_${v.risk}`) }), h('span', { text: headlineRest(L(v.headline), t(`risk_${v.risk}`)) }))),
      h('div', { class: 'riskbar' }, h('i'), h('i'), h('i')),
      v.flags.length ? h('h3', { text: t('signsFound') }) : null,
      v.flags.length ? h('ul', { class: 'flags' }, v.flags.map((f) => h('li', null, icon('alert'), h('span', { text: L(f) })))) : null,
      v.addresses.length ? h('h3', { text: t('addresses') }) : null,
      v.addresses.map((a) => h('div', { class: `grp ${a.looksLike.length || a.issue ? 'block' : a.knownAs ? '' : 'warn'}` },
        h('span', { class: 'ic' }, icon(a.looksLike.length || a.issue ? 'x' : a.knownAs ? 'check' : 'alert')),
        h('div', { style: 'min-width:0' }, addrNode(a.address), h('ul', null,
          a.knownAs ? h('li', { text: t('addrSaved', a.knownAs) }) : null,
          a.issue ? h('li', { text: L(a.issue) }) : null,
          a.looksLike.map((l) => h('li', { text: L(l) })))))),
      v.aiFlags.length ? h('div', { class: 'sub', style: 'margin-top:10px', text: `${t('aiAlso')}: ${v.aiFlags.join(', ')}` }) : null,
      v.aiNote ? h('div', { class: 'ai-note' }, h('b', { text: t('aiNote') }), v.aiNote) : null
    ))
  }
  return out
}

async function runCheck () {
  const text = (S.C.text || '').trim()
  if (!text || S.C.busy) return
  S.C.busy = true
  S.C.res = null
  pushSteps([], true)
  renderView()
  const r = await api('/api/check', { method: 'POST', json: { text, network: netId(), lang: S.lang } })
  S.C.busy = false
  if (!r.ok) toast(errText(r)); else { S.C.res = r; pushSteps(r.steps) }
  renderView()
}

// ---- outbox tab
async function refreshOutbox () {
  const r = await api(`/api/outbox?network=${netId()}`)
  if (r.ok) S.outbox = r.entries
  if (S.tab === 'outbox') renderView()
}

function outboxView () {
  const waiting = S.outbox.filter((e) => e.status === 'queued').length
  const unconfirmed = S.outbox.filter((e) => e.status === 'broadcast').length // sent, result not known yet: re-checked by hash
  const job = S.job
  const running = !!job?.running
  return [
    h('div', { class: 'card' },
      h('h2', { text: t('outboxTitle') }),
      h('p', { class: 'sub', text: `${t('outboxSub')} · ${t(`net_${netId()}`)}` }),
      h('div', { class: 'actions', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn primary', type: 'button', disabled: running || !(waiting || unconfirmed), onclick: () => runNet('broadcast') }, icon('plane'), waiting ? t('sendQueued', waiting) : unconfirmed ? t('checkSent') : t('nothingToSend')),
        h('button', { class: 'btn ghost small', type: 'button', disabled: running, onclick: () => runNet('sync') }, icon('refresh'), t('syncBtn'))),
      h('div', { class: 'netbadge' }, icon('lock'), h('div', null, h('b', { text: `${t('broadcasterOnline')} · ${t('noKeys')}` }), h('span', { text: t('broadcasterNote') }))),
      job && job.network === netId() ? h('div', { class: 'joblog' },
        h('div', { class: 'hd' }, h('span', { class: `dot${running ? ' run' : ''}` }), running ? `${t('broadcasterOnline')} · ${job.action}` : `${t('broadcasterDone')} · exit ${job.code}`),
        (job.lines || []).slice(-14).join('\n')) : null
    ),
    h('div', { class: 'card' }, S.outbox.length ? S.outbox.map(obRow) : h('p', { class: 'sub', text: t('emptyOutbox') }))
  ]
}

function obRow (e) {
  return h('div', { class: 'ob' },
    h('span', { class: 'avatar', text: e.recipientName ? e.recipientName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '0x' }),
    h('div', { class: 'main' },
      h('div', { class: 'nm', text: e.recipientName || e.short }),
      h('div', { class: 'meta', text: `nonce ${e.nonce} · ${e.hashShort}${e.block ? ` · ${t('block')} ${e.block}` : ''}` }),
      h('span', { class: `status ${e.status}`, text: t(`st_${e.status}`) }),
      e.explorer ? h('div', null, h('a', { href: e.explorer, target: '_blank', rel: 'noopener noreferrer' }, t('explorer'), icon('ext'))) : null,
      e.status === 'needs_resign' ? h('button', { class: 'btn small danger', type: 'button', style: 'margin-top:8px', onclick: () => askResign(e) }, icon('key'), t('resignBtn')) : null),
    h('div', { class: 'amt', text: `${fmtAmt(e.amount)} USDT` }))
}

async function runNet (action) {
  const r = await api(`/api/net/${action}`, { method: 'POST', json: { network: netId() } })
  if (!r.ok) { toast(errText(r)); return }
  S.job = r.job
  renderView()
  const poll = async () => {
    const j = await api('/api/net/job')
    if (j.ok) S.job = j.job
    await refreshOutbox()
    if (S.job?.running) setTimeout(poll, 900)
    else { await refreshStatus(); await refreshOutbox() }
  }
  setTimeout(poll, 700)
}

function askResign (e) {
  openSheet([
    h('h2', { text: t('resignBtn') }),
    h('p', { class: 'sub', text: t('resignConfirm', fmtAmt(e.amount), e.recipientName || e.short) }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, t('cancel')),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        closeSheet()
        const r = await api('/api/resign', { method: 'POST', json: { id: e.id, network: netId(), confirm: true } })
        if (!r.ok) toast(errText(r)); else { pushSteps(r.steps, true); toast(t('signedTitle')) }
        refreshOutbox(); refreshStatus()
      } }, icon('key'), t('resignBtn')))
  ])
}

// ---- contacts tab
async function refreshContacts () {
  const r = await api('/api/contacts')
  if (r.ok) S.contacts = r.contacts
  if ((S.tab === 'contacts' || (S.tab === 'send' && S.F.mode === 'idle')) && !document.activeElement?.matches?.('input,textarea')) renderView()
}
function contactsView () {
  return [h('div', { class: 'card' },
    h('h2', { text: t('contactsTitle') }),
    h('p', { class: 'sub', style: 'margin-bottom:8px', text: t('contactsSub') }),
    S.contacts.map((c) => h('div', { class: 'ct' },
      h('span', { class: 'avatar', text: c.initials }),
      h('div', { class: 'main' }, h('div', { class: 'nm', text: c.name }), h('div', { class: 'rel', text: S.lang === 'sw' ? c.relation_sw || '' : c.relation_en || '' }), addrNode(c.address)))))]
}

// ------------------------------------------------------------------ sheets: proof, network menu
function openSheet (kids) {
  $('sheet').replaceChildren(h('div', { class: 'grab' }), ...kids)
  $('sheet').hidden = false
  $('sheetBackdrop').hidden = false
  $('sheet').querySelector('button')?.focus()
}
function closeSheet () { $('sheet').hidden = true; $('sheetBackdrop').hidden = true }

function openProof () {
  const n = S.status?.net
  const m = S.status?.engine?.models || {}
  const row = (k, v, good) => h('div', { class: 'proofrow' }, h('span', { text: k }), h('span', { class: good ? 'bad' : '', text: v }))
  openSheet([
    h('h2', { text: t('proofTitle') }),
    h('p', { class: 'sub', style: 'margin-bottom:10px', text: t('proofSub') }),
    n ? [
      row('sandbox', `${n.sandbox} · bwrap --unshare-net`),
      row(t('ifaces'), (n.interfaces || []).join(', ') === 'lo' ? t('onlyLo') : (n.interfaces || []).join(', '), (n.interfaces || []).join(',') === 'lo'),
      row(`${t('tcp')} ${n.tcp_ipv4.target}`, n.tcp_ipv4.ok ? t('reachable') : `${t('failed')} · ${n.tcp_ipv4.error}`, !n.tcp_ipv4.ok),
      row(`${t('tcp')} IPv6`, n.tcp_ipv6.ok ? t('reachable') : `${t('failed')} · ${n.tcp_ipv6.error}`, !n.tcp_ipv6.ok),
      row(`${t('dns')} ${n.dns.target}`, n.dns.ok ? t('reachable') : `${t('failed')} · ${n.dns.error}`, !n.dns.ok),
      row(t('checkedAt'), new Date(n.at).toLocaleTimeString('en-GB', { hourCycle: 'h23' }))
    ] : null,
    h('h3', { class: 'section-title', style: 'margin:14px 0 4px', text: t('models') }),
    row('ASR', m.asr || '—'), row('VAD', m.vad || '—'), row('LLM', m.llm || '—'), row('SDK', m.sdk || '—'),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, t('close')))
  ])
}

function openNetMenu () {
  const item = (id) => h('button', { class: 'menu-item', type: 'button', 'aria-pressed': String(netId() === id), onclick: () => { S.network = id; store.set('network', id); closeSheet(); S.outbox = []; S.job = null; refreshStatus(); refreshOutbox(); renderView() } },
    h('span', { class: 'avatar', style: 'width:36px;height:36px' }, icon('globe')), h('div', null, h('b', { text: t(`net_${id}`) }), h('span', { text: t(`net_${id}_sub`) })))
  openSheet([h('h2', { text: t('networkMenu') }), item('devnet'), item('sepolia'), h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, t('close')))])
}

// ------------------------------------------------------------------ boot
function boot () {
  for (const b of $('langSeg').querySelectorAll('button')) b.addEventListener('click', () => { S.lang = b.dataset.lang; store.set('lang', S.lang); renderChrome(); renderView() })
  $('pill').addEventListener('click', openProof)
  $('sheetBackdrop').addEventListener('click', closeSheet)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet() })
  $('voiceFile').addEventListener('change', onVoiceFile)
  window.matchMedia('(min-width: 980px)').addEventListener('change', renderSide)
  renderChrome()
  renderView()
  refreshStatus().then(() => { refreshContacts(); refreshOutbox() })
  setInterval(() => { if (!document.hidden) refreshStatus() }, 4000)
}
boot()
