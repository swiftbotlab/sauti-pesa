// Scam-pattern rules for payment requests and pasted SMS/WhatsApp messages (English + Swahili).
// The rules here DECIDE. The local language model may add flags from the same closed list as a
// second opinion (it can raise the risk, never lower it); see riskFromFlags().
import { fold } from './text.js'

export const FLAGS = {
  seed_request: 'high',
  remote_access: 'high',
  unlock_fee: 'high',
  wrong_send: 'high',
  new_address_claim: 'high',
  impersonation: 'medium',
  urgency: 'medium',
  prize: 'medium',
  secrecy: 'medium',
  investment: 'medium',
  link: 'low'
}
export const FLAG_IDS = Object.keys(FLAGS)

const R = (s) => new RegExp(s, 'i')
const RULES = {
  seed_request: [R('seed ?phrase'), R('recovery (phrase|words)'), R('private key'), R('secret (phrase|words)'), R('maneno (ya siri|12|kumi na mbili)'),
    R('\\b(pin|nywila|password)\\b.{0,30}\\b(yako|your)\\b'), R('\\b(yako|your)\\b.{0,20}\\b(pin|nywila|password)\\b'), R('namba ya siri')],
  remote_access: [R('any ?desk'), R('team ?viewer'), R('screen ?shar'), R('rust ?desk'), R('remote (access|control)')],
  unlock_fee: [R('\\bunlock'), R('release (your |the )?(funds|money|payment)'), R('(processing|activation|clearance|registration|withdrawal) fee'),
    R('ku ?(i|ya|zi|li)?fungu(a|liwa)'), R('(ushuru|\\btax|\\bfee|\\bada)\\b.{0,40}\\b(upate|upokee|kupokea|kupata|receive|claim)\\b.{0,25}\\b(zawadi|prize|winnings|pesa yako|your money)'), R('ada ya (kufungua|usajili|kuachilia|huduma|uanzishaji|kutoa)'), R('ili (u )?(kupokea|upokee|kutoa)'), R('lipa kwanza'), R('pay (a small fee )?first'),
    R('re-?activat'), R('verify your (account|wallet)'), R('kuhakiki (akaunti|wallet)'), R('kurejesha akaunti')],
  wrong_send: [R('by mistake'), R('wrong (number|account|address)'), R('kimakosa'), R('nimekosea (kutuma|namba)'), R('(send|return) (it |the money )?back'), R('\\b(ni)?rudish(a|ie)\\b'), R('kwa makosa')],
  new_address_claim: [R('new (wallet|address)'), R('(anwani|wallet|akaunti) mpya'), R('nimebadilisha (wallet|anwani|akaunti|namba)'), R('changed my (wallet|address|account)'),
    R('use this (address|wallet) instead'), R('tumia (anwani|wallet) hii')],
  impersonation: [R('m-?pesa (agent|customer|support|care|team)'), R('wakala wa m-?pesa'), R('safaricom'), R('customer (care|support|service)'), R('huduma kwa wateja'),
    R('(binance|tether|bank|benki|kra|airtel) (support|team|official|agent|wakala)'), R('(afisa|official) wa (benki|bank|serikali)'), R('\\bkra\\b'),
    R('dear (customer|client|user)'), R('mteja (mpendwa|wetu)'), R('your m-?pesa (account|line)'), R('akaunti yako ya m-?pesa'),
    R('ni mimi,? (mjomba|shangazi|kaka|dada|mama|baba|binamu|bosi|boss)'), R('ni (bosi|boss|meneja|mkurugenzi) wako'),
    R('(it\'?s|this is) (me,? )?your (uncle|aunt|brother|sister|mum|mom|dad|boss|manager)'), R('(nimepata|amepata) ajali'), R('nimekamatwa'),
    R('i(\'ve| have) (had an accident|been arrested)')],
  urgency: [R('\\bharaka\\b'), R('sasa hivi'), R('mara moja'), R('\\burgent'), R('immediately'), R('right (now|away)'), R('within \\d+ (minutes?|hours?|mins?)'),
    R('ndani ya (saa|dakika)'), R('leo tu'), R('(itafungwa|ku ?fungwa|imefungwa|will be (closed|blocked|suspended)|account (is )?(blocked|suspended))'), R('today only'), R('last chance'), R('expires? (today|soon|in)')],
  prize: [R('umeshinda'), R('you (have |\'ve )?won'), R('\\bwinner\\b'), R('zawadi (yako|kubwa)'), R('bahati nasibu'), R('lottery'), R('\\bjackpot'), R('free (usdt|money|airdrop)')],
  secrecy: [R('usimwambie'), R('usiambie mtu'), R('don\'?t tell'), R('keep (this|it) (a )?secret'), R('kwa siri')],
  investment: [R('double your'), R('(guaranteed|uhakika wa) (profit|returns|faida)'), R('faida (kubwa|ya uhakika)'), R('\\d+ ?% (daily|per day|kwa siku|weekly|kila wiki)'),
    R('investment (plan|opportunity)'), R('uwekezaji'), R('zidisha pesa'), R('mara mbili ya pesa')],
  link: [R('https?://'), R('\\b(bit\\.ly|tinyurl|t\\.me|wa\\.me|cutt\\.ly)/'), R('www\\.')]
}

export const MAX_MESSAGE_CHARS = 2000

/** Rule-based flags for a request or pasted message. */
export function ruleFlags (text) {
  const raw = String(text || '').slice(0, MAX_MESSAGE_CHARS)
  const f = `${raw}\n${fold(raw)}`
  const hits = []
  for (const [id, rules] of Object.entries(RULES)) {
    const m = rules.map((r) => f.match(r)).find(Boolean)
    if (m) hits.push({ id, severity: FLAGS[id], evidence: m[0].slice(0, 40), source: 'rule' })
  }
  return hits
}

/**
 * Merge rule flags with the model's opinion. Only known flag ids are accepted from the model, and a flag
 * that ONLY the model saw are always "low" (a small model also flags harmless texts; in tests it
 * called a plain greeting "impersonation"). Medium and high risk need rule or address evidence.
 */
export function mergeFlags (rule, modelFlags = []) {
  const out = [...rule]
  for (const id of Array.isArray(modelFlags) ? modelFlags.slice(0, 11) : []) {
    // Model-only flags are hints ("AI also suspects"), always LOW. Measured on 30 everyday Swahili requests
    // (commissioned test set, scripts/eval_sw_requests.mjs): the 1.7B model flagged "impersonation" on 26 and "wrong_send" on 8 of them.
    if (typeof id === 'string' && Object.hasOwn(FLAGS, id) && !out.some((h) => h.id === id)) out.push({ id, severity: 'low', evidence: null, source: 'model' })
  }
  return out
}

/** The risk level is computed here, in code, from the flags. */
export function riskFromFlags (flags) {
  if (flags.some((f) => f.severity === 'high')) return 'high'
  const ruleIds = new Set(flags.filter((f) => f.source !== 'model').map((f) => f.id))
  if (ruleIds.has('urgency') && (ruleIds.has('impersonation') || ruleIds.has('prize') || ruleIds.has('investment'))) return 'high'
  // "it's your boss / your uncle, don't tell anyone": secrecy plus a claimed identity, prize or pressure
  if (ruleIds.has('secrecy') && (ruleIds.has('impersonation') || ruleIds.has('prize') || ruleIds.has('investment') || ruleIds.has('urgency'))) return 'high'
  if (flags.some((f) => f.severity === 'medium')) return 'medium'
  if (flags.length) return 'low'
  return 'none'
}
