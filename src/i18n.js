// Every sentence the person sees, in Swahili and English. Generated from codes in plain code,
// so a warning can never be "talked away" by model output.
import { shortAddr } from './text.js'

const L = {
  not_a_payment: { sw: 'Hili si ombi la kutuma pesa.', en: 'This is not a payment request.' },
  unsupported_token: { sw: (d) => `Sarafu "${d.token}" haitumiki. Programu hii inatuma USDT pekee.`, en: (d) => `"${d.token}" is not supported. This app only sends USDT.` },
  token_assumed: { sw: 'Hukutaja sarafu; tunachukulia USDT.', en: 'No token was named; assuming USDT.' },
  missing_amount: { sw: 'Sikusikia kiasi. Sema au andika kiasi cha USDT.', en: 'I did not catch an amount. Say or type how much USDT.' },
  amount_not_heard: { sw: 'Sikusikia kiasi kwenye maneno yako. Sema au andika kiasi kwa tarakimu (k.m. 20).', en: 'I could not find an amount in your words. Say or type it in digits (e.g. 20).' },
  amount_not_in_request: { sw: (d) => `Kiasi ${d.amount} hakikuwa kwenye ombi lako. Rudia ombi.`, en: (d) => `The amount ${d.amount} was not in your request. Please repeat it.` },
  over_tx_limit: { sw: (d) => `Zaidi ya kikomo chako cha malipo moja (${d.limit} USDT ya majaribio).`, en: (d) => `Above your per-payment limit (${d.limit} test USDT).` },
  over_daily_limit: { sw: (d) => `Utazidi kikomo cha siku (${d.limit} USDT ya majaribio; umeshatuma ${d.spent}).`, en: (d) => `This would pass your daily limit (${d.limit} test USDT; already ${d.spent}).` },
  insufficient_balance: { sw: (d) => `Salio halitoshi (${d.balance} USDT ya majaribio kwa mujibu wa usawazishaji wa mwisho).`, en: (d) => `Not enough balance (${d.balance} test USDT at the last sync).` },
  balance_unknown: { sw: 'Salio halijulikani (hakuna mtandao). Litaangaliwa kabla ya kutuma.', en: 'Balance unknown (offline). It is checked before sending.' },
  retype_amount: { sw: (d) => `Kiasi kikubwa: andika ${d.amount} tena kuthibitisha.`, en: (d) => `Large amount: type ${d.amount} again to confirm.` },
  missing_recipient: { sw: 'Sikusikia unamtumia nani.', en: 'I did not catch who to pay.' },
  unknown_recipient: { sw: (d) => `"${d.said}" hayupo kwenye orodha yako ya anwani. Ongeza anwani yake kwanza.`, en: (d) => `"${d.said}" is not in your address book. Add their address first.` },
  ambiguous_recipient: { sw: (d) => `Kuna watu kadhaa: ${d.candidates.join(', ')}. Chagua mmoja.`, en: (d) => `Several people match: ${d.candidates.join(', ')}. Pick one.` },
  did_you_mean: { sw: (d) => `Je, ulimaanisha ${d.candidates.join(' au ')}? Thibitisha jina.`, en: (d) => `Did you mean ${d.candidates.join(' or ')}? Please confirm the name.` },
  recipient_not_in_request: { sw: (d) => `Sikusikia jina la ${d.name} kwenye ombi lako. Je, unamtumia ${d.name}? Thibitisha.`, en: (d) => `I did not hear ${d.name}'s name in your request. Is it ${d.name}? Please confirm.` },
  relation_conflict: { sw: (d) => `${d.name} amehifadhiwa kama "${d.saved}", si "${d.said}". Hakikisha.`, en: (d) => `${d.name} is saved as "${d.saved}", not "${d.said}". Please check.` },
  bad_address: { sw: 'Anwani si sahihi.', en: 'The address is not valid.' },
  bad_checksum: { sw: 'Anwani ina herufi iliyokosewa (checksum si sahihi). Usitume.', en: 'The address has a wrong character (checksum fails). Do not send.' },
  zero_address: { sw: 'Anwani ya sifuri: pesa zingepotea.', en: 'Zero address: the money would be lost.' },
  name_address_mismatch: { sw: (d) => `Anwani hii SI ya ${d.name} uliyohifadhi (${shortAddr(d.saved)}).`, en: (d) => `This address is NOT the one saved for ${d.name} (${shortAddr(d.saved)}).` },
  self_send: { sw: 'Unajitumia mwenyewe.', en: 'You are sending to yourself.' },
  token_contract_recipient: { sw: 'Anwani ni mkataba wa sarafu yenyewe: pesa zingepotea.', en: 'That is the token contract itself: the money would be lost.' },
  lookalike_address: {
    sw: (d) => `HATARI: anwani hii inafanana na ${d.similarTo ? `ya ${d.similarTo}` : 'uliyowahi kutumia'} (${shortAddr(d.similarAddress)}) lakini SI ile ile. Huu ni ujanja wa "address poisoning".`,
    en: (d) => `DANGER: this address looks like ${d.similarTo ? `${d.similarTo}'s` : 'one you paid before'} (${shortAddr(d.similarAddress)}) but is NOT the same. This is an address-poisoning trick.`
  },
  new_recipient: { sw: 'Hujawahi kumtumia mtu huyu. Hakikisha anwani kwa simu.', en: 'You have never paid this address. Confirm it by phone.' },
  new_recipient_over_limit: { sw: (d) => `Malipo ya kwanza kwa anwani mpya yamezuiliwa juu ya ${d.limit} USDT ya majaribio. Tuma kiasi kidogo kwanza.`, en: (d) => `First payments to a new address are capped at ${d.limit} test USDT. Send a small test first.` },
  scam_high: { sw: 'Ombi lina dalili kali za utapeli. Malipo yamezuiliwa.', en: 'This request shows strong scam signs. Payment blocked.' },
  scam_signals: { sw: 'Ombi lina dalili za utapeli. Soma maonyo kabla ya kuthibitisha.', en: 'This request shows scam signs. Read the warnings before confirming.' }
}

export const FLAG_TEXT = {
  seed_request: { sw: 'Inaomba maneno yako ya siri (seed phrase) au PIN. Hakuna huduma halali inayoyahitaji. Usiyatume kamwe.', en: 'It asks for your seed phrase or PIN. No genuine service ever needs it. Never share it.' },
  remote_access: { sw: 'Inakuomba usakinishe programu ya kudhibiti simu (k.m. AnyDesk). Usifanye hivyo.', en: 'It asks you to install remote-control software (e.g. AnyDesk). Do not.' },
  unlock_fee: { sw: 'Inakuomba ulipe kwanza ili "kufungua" au kupokea pesa. Huu ni mtindo wa kawaida wa utapeli.', en: 'It asks you to pay first to "unlock" or receive money. This is a common scam pattern.' },
  wrong_send: { sw: 'Inadai pesa zilitumwa kwako kimakosa. Angalia salio lako mwenyewe; usirudishe kwa anwani uliyopewa.', en: 'It claims money was sent to you by mistake. Check your own balance; never "send back" to an address they give.' },
  new_address_claim: { sw: 'Inasema mtu amebadilisha anwani yake. Mpigie kwa namba unayoijua kabla ya kutuma.', en: 'It says someone changed their address. Call them on a number you already know before sending.' },
  impersonation: { sw: 'Inadai kutoka kwa mtu au huduma unayoiamini (ndugu, bosi, M-Pesa, benki). Mpigie kwa namba unayoijua kabla ya kulipa.', en: 'It claims to come from someone you trust (a relative, your boss, M-Pesa, a bank). Call them on a number you already know before paying.' },
  urgency: { sw: 'Inakuharakisha au kukutisha (k.m. "haraka", "akaunti itafungwa"). Matapeli hutumia haraka ili usifikirie.', en: 'It rushes or threatens you ("urgent", "account will be closed"). Scammers use pressure so you do not stop to check.' },
  prize: { sw: 'Inadai umeshinda zawadi. Kama hukuingia shindano, si kweli.', en: 'It says you won a prize. If you did not enter, it is not real.' },
  secrecy: { sw: 'Inakuambia usimwambie mtu. Ongea na mtu unayemwamini kwanza.', en: 'It tells you to keep it secret. Talk to someone you trust first.' },
  investment: { sw: 'Inaahidi faida kubwa au ya uhakika. Hakuna anayeweza kuhakikisha faida.', en: 'It promises big or guaranteed returns. Nobody can guarantee profit.' },
  link: { sw: 'Ina kiungo (link). Usifungue viungo usivyovijua.', en: 'It contains a link. Do not open links you do not recognise.' }
}

export const RISK_TEXT = {
  high: { sw: 'HATARI KUBWA: usitume pesa.', en: 'HIGH RISK: do not send money.' },
  medium: { sw: 'Tahadhari: kuna dalili za utapeli.', en: 'Caution: there are scam signs.' },
  low: { sw: 'Hatari ndogo, lakini kuwa makini.', en: 'Low risk, but stay careful.' },
  none: { sw: 'Hakuna dalili za utapeli zilizopatikana. Bado hakikisha na mtu husika.', en: 'No scam signs found. Still confirm with the person directly.' }
}

export function reasonText (r, lang) {
  const t = L[r.code]?.[lang] ?? L[r.code]?.en
  if (!t) return r.code
  return typeof t === 'function' ? t(r) : t
}

export function confirmationText ({ intent, recipient, decision }, lang, feeNote) {
  const who = recipient ? `${recipient.name || 'anwani mpya / new address'} (${shortAddr(recipient.address)})` : '?'
  const memo = intent.memo ? (lang === 'sw' ? ` kwa ajili ya "${intent.memo}"` : ` for "${intent.memo}"`) : ''
  if (decision === 'blocked') return lang === 'sw' ? 'Malipo hayawezi kuendelea:' : 'This payment cannot go ahead:'
  const fee = feeNote ? ` ${feeNote}` : ''
  return lang === 'sw'
    ? `Unatuma ${intent.amount} USDT ya majaribio kwa ${who}${memo}.${fee} Thibitisha? (ndiyo/hapana)`
    : `You are sending ${intent.amount} test USDT to ${who}${memo}.${fee} Confirm? (yes/no)`
}
