// Generates data/demo-contacts.json + data/demo-attack.json (random TEST addresses; nobody holds keys).
//   ops/sandbox.sh offline node scripts/gen_demo_contacts.mjs > tmp/demo.json
import { getAddress } from 'ethers'
import { randomBytes } from 'node:crypto'
const rnd = () => getAddress('0x' + randomBytes(20).toString('hex'))
const people = [
  { id: 'amina', name: 'Amina', aliases: ['Amina Wanjiku'], relation: 'landlord' },
  { id: 'juma', name: 'Juma', aliases: ['Juma Mwangi'], relation: 'brother' },
  { id: 'wanjiru', name: 'Wanjiru', aliases: [], relation: 'sister' },
  { id: 'otieno', name: 'Otieno', aliases: ['Otieno Ouma'], relation: 'friend' },
  { id: 'mama', name: 'Mama Neema', aliases: ['Neema'], relation: 'mother' }
]
const out = people.map((p) => ({ ...p, address: rnd(), added: '2026-10-01', payments: 3 }))
const a = out[0].address.toLowerCase()
let mid = randomBytes(20).toString('hex').slice(4, 36)
const poisoned = getAddress('0x' + a.slice(2, 6) + mid + a.slice(-4))
console.log(JSON.stringify({ contacts: out, poisonedAmina: poisoned }, null, 1))
