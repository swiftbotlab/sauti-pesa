// Peak resident memory of this process and of the QVAC worker it spawned (Linux /proc).
// Inside the sandbox we have our own PID namespace, so /proc lists only our own processes. Outside it (portable
// mode) only this process and its descendants are counted, so nothing about other programs is read or printed.
// Without /proc (macOS, Windows) only this Node process is reported (process.resourceUsage / memoryUsage).
import { readdirSync, readFileSync, existsSync } from 'node:fs'

const OWN_TREE_ONLY = process.env.SAUTI_SANDBOX !== 'offline'

function procStatus () {
  const rows = []
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      rows.push({
        pid: Number(pid),
        ppid: Number(/^PPid:\s+(\d+)/m.exec(st)?.[1] ?? -1),
        name: /^Name:\s+(\S+)/m.exec(st)?.[1],
        hwm: /^VmHWM:\s+(\d+)/m.exec(st)?.[1],
        rss: /^VmRSS:\s+(\d+)/m.exec(st)?.[1]
      })
    } catch { /* process exited */ }
  }
  if (!OWN_TREE_ONLY) return rows
  const mine = new Set([process.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true }
  }
  return rows.filter((r) => mine.has(r.pid))
}

function collect (field) {
  const out = {}
  for (const r of procStatus()) if (r.name && r[field] && r.name !== 'bwrap') out[`${r.name}:${r.pid}`] = Math.round(Number(r[field]) / 1024)
  return out
}

const hasProc = () => process.platform === 'linux' && existsSync('/proc/self/status')

export function peakRssMb () {
  if (!hasProc()) return { [`node:${process.pid}`]: Math.round(process.resourceUsage().maxRSS / 1024) }
  return collect('hwm')
}

/** Current resident memory (VmRSS) per process, in MB. */
export function currentRssMb () {
  if (!hasProc()) return { [`node:${process.pid}`]: Math.round(process.memoryUsage.rss() / 1048576) }
  return collect('rss')
}
