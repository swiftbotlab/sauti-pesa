// Offline address book and recipient resolution. The language model only proposes a NAME as the
// person said it; this code decides who that is (or refuses to guess).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { fold, words, editDistance, clean } from './text.js'
import { normalizeAddress } from './evmaddr.js'

const RELATIONS = {
  brother: ['brother', 'bro', 'kaka', 'ndugu'],
  sister: ['sister', 'sis', 'dada'],
  mother: ['mother', 'mum', 'mom', 'mama', 'mamangu'],
  father: ['father', 'dad', 'baba', 'babangu'],
  son: ['son', 'mwanangu', 'mwana'],
  daughter: ['daughter', 'binti'],
  landlord: ['landlord', 'landlady', 'mwenye nyumba', 'mwenyenyumba'],
  wife: ['wife', 'mke', 'mke wangu'],
  husband: ['husband', 'mume', 'mume wangu'],
  friend: ['friend', 'rafiki'],
  school: ['school', 'shule']
}
const FILLER = new Set(['my', 'to', 'the', 'kwa', 'yangu', 'wangu', 'changu', 'langu', 'our', 'mr', 'mrs', 'ms', 'bwana', 'bi', 'mzee', 'please', 'tafadhali'])

export function relationOf (text) {
  const f = ` ${fold(text)} `
  for (const [rel, keys] of Object.entries(RELATIONS)) {
    if (keys.some((k) => f.includes(` ${k} `))) return rel
  }
  return null
}

export function loadContacts (path) {
  if (!existsSync(path)) return []
  const list = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(list) || list.length > 500) throw new Error('contacts file is malformed')
  return list.map(validateContact)
}

export function saveContacts (path, list) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(list.map(validateContact), null, 1), { mode: 0o600 })
  renameSync(tmp, path)
}

export function validateContact (c) {
  const name = clean(c?.name, 60)
  if (!name) throw new Error('contact needs a name')
  const address = normalizeAddress(c.address)
  if (!address.ok) throw new Error(`contact ${name}: ${address.error}`)
  return {
    id: clean(c.id || fold(name).replace(/\s+/g, '-'), 40),
    name,
    aliases: (Array.isArray(c.aliases) ? c.aliases : []).map((a) => clean(a, 40)).filter(Boolean).slice(0, 10),
    relation: c.relation && RELATIONS[c.relation] ? c.relation : null,
    address: address.address,
    added: clean(c.added || '', 30) || null,
    payments: Number.isInteger(c.payments) && c.payments >= 0 ? c.payments : 0
  }
}

function nameKeys (c) {
  return [c.name, ...c.aliases].flatMap((n) => [fold(n), ...words(n)]).filter((k) => k.length >= 2)
}

// Keys that identify a contact on their own: the saved name (and each of its words), each full alias and the
// first word of an alias. A later word of an alias ("Wanjiku" in "Amina Wanjiku") is usually a family name
// that other people share: a test request "Mtumie shangazi Wanjiku..." (an aunt) resolved to the landlord
// Amina Wanjiku. Such a match only ever leads to "did you mean", never to an automatic pick.
function strongKeys (c) {
  return [fold(c.name), ...words(c.name), ...c.aliases.map(fold), ...c.aliases.map((a) => words(a)[0] || '')].filter((k) => k.length >= 2)
}
function familyNameKeys (c) {
  const strong = strongKeys(c)
  return c.aliases.flatMap((a) => words(a).slice(1)).filter((k) => k.length >= 3 && !strong.includes(k))
}

// Words that never name a person on their own: relations ("mama", "kaka"), titles and trades people put in front
// of a name ("shangazi" = aunt, "fundi" = craftsman, "mwalimu" = teacher) and filler. "Mama Neema" is named by
// "Neema" or by "Mama Neema", not by "mama".
const RELATION_WORDS = new Set(Object.values(RELATIONS).flat().flatMap((k) => k.split(' ')))
const TITLE_WORDS = new Set(['shangazi', 'mjomba', 'binamu', 'bibi', 'babu', 'shemeji', 'wifi', 'mpwa', 'mjukuu', 'aunt', 'auntie', 'uncle', 'cousin',
  'grandma', 'grandpa', 'granny', 'fundi', 'boda', 'mwalimu', 'teacher', 'daktari', 'doctor', 'dr', 'dada', 'kaka', 'mzee', 'mama', 'baba', 'mr', 'mrs', 'ms', 'sir', 'madam'])
const weakWord = (w) => FILLER.has(w) || RELATION_WORDS.has(w) || TITLE_WORDS.has(w)
const unglue = (t) => t.replace(/^(kwa|ku)(?=[a-z]{3,})/, '')

/**
 * Is this contact named in the person's own words? (by relation when it was resolved that way, else by name)
 * Only strong keys count: a word of the saved name, a full alias, or an alias's first word, never a relation,
 * title or filler word. And the words found must lead back to THIS contact on their own: a family name that
 * another person also has ("shangazi Wanjiku" is an aunt, not the landlord "Amina Wanjiku"), or a name two
 * contacts share, does not count.
 * @param {object[]} [contacts] the address book (to check that the said words resolve to this contact)
 */
export function namedInText (contact, via, text, contacts = [contact]) {
  if (via === 'relation') return !!contact.relation && relationOf(text) === contact.relation
  const toks = words(text)
  const phrase = ` ${toks.map(unglue).join(' ')} `
  const said = new Set([...toks, ...toks.map(unglue)])
  const hits = []
  for (const k of new Set(strongKeys(contact))) {
    if (k.includes(' ')) { if (phrase.includes(` ${k} `) || ` ${toks.join(' ')} `.includes(` ${k} `)) hits.push(k) } else if (k.length >= 3 && !weakWord(k) && said.has(k)) hits.push(k)
  }
  return hits.some((k) => { const r = resolveRecipient(k, contacts); return r.status === 'resolved' && r.contact.id === contact.id })
}

/**
 * Resolve the spoken recipient against the address book.
 * @returns {{status:'resolved', contact, via} | {status:'ambiguous', candidates} |
 *           {status:'did_you_mean', candidates} | {status:'unknown'} | {status:'none'}}
 */
export function resolveRecipient (spoken, contacts) {
  if (!spoken) return { status: 'none' }
  const rel = relationOf(spoken)
  const toks = words(spoken).filter((w) => !FILLER.has(w) && !Object.values(RELATIONS).flat().includes(w))
  const phrase = toks.join(' ')

  let byName = []
  if (phrase) {
    byName = contacts.filter((c) => strongKeys(c).includes(phrase))
    if (!byName.length) byName = contacts.filter((c) => toks.some((t) => t.length >= 3 && strongKeys(c).includes(t)))
  }
  if (!byName.length && phrase) {
    // speech recognisers glue "kwa"/"ku" onto the name: "kuwanjiru" = "kwa Wanjiru"
    const unglued = toks.map((t) => t.replace(/^(kwa|ku)(?=[a-z]{3,})/, '')).filter((t) => t.length >= 3)
    byName = contacts.filter((c) => unglued.some((t) => strongKeys(c).includes(t)))
  }
  if (byName.length === 1) {
    const c = byName[0]
    const relConflict = rel && c.relation && rel !== c.relation
    return { status: 'resolved', contact: c, via: 'name', relationConflict: relConflict ? { said: rel, saved: c.relation } : null }
  }
  if (byName.length > 1) return { status: 'ambiguous', candidates: byName }

  if (rel && !phrase) {
    const byRel = contacts.filter((c) => c.relation === rel)
    if (byRel.length === 1) return { status: 'resolved', contact: byRel[0], via: 'relation' }
    if (byRel.length > 1) return { status: 'ambiguous', candidates: byRel }
  }

  // Only a family name matched ("Wanjiku" for "Amina Wanjiku"): ask, never auto-pick.
  if (phrase) {
    const byFamily = contacts.filter((c) => toks.some((t) => familyNameKeys(c).includes(t)))
    if (byFamily.length) return { status: 'did_you_mean', candidates: byFamily }
  }

  // Close but not equal ("Amiina", "Amima"): never auto-pick, ask the person.
  if (phrase) {
    const near = contacts.filter((c) => nameKeys(c).some((k) => {
      const lim = Math.min(k.length, phrase.length) >= 5 ? 2 : 1
      return toks.some((t) => t.length >= 3 && editDistance(t, k, 3) <= lim) || editDistance(phrase, k, 3) <= lim
    }))
    if (near.length) return { status: 'did_you_mean', candidates: near }
  }
  return { status: 'unknown' }
}
