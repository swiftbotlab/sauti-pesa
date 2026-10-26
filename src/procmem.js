// Peak resident memory of this process and of the QVAC worker it spawned (Linux /proc only).
// Inside the sandbox we have our own PID namespace, so /proc lists only our own processes.
import { readdirSync, readFileSync } from 'node:fs'

export function peakRssMb () {
  const out = {}
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      const name = /^Name:\s+(\S+)/m.exec(st)?.[1]
      const hwm = /^VmHWM:\s+(\d+)/m.exec(st)?.[1]
      if (name && hwm && name !== 'bwrap') out[`${name}:${pid}`] = Math.round(Number(hwm) / 1024)
    } catch { /* process exited */ }
  }
  return out
}

/** Current resident memory (VmRSS) per process, in MB. */
export function currentRssMb () {
  const out = {}
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      const name = /^Name:\s+(\S+)/m.exec(st)?.[1]
      const rss = /^VmRSS:\s+(\d+)/m.exec(st)?.[1]
      if (name && rss && name !== 'bwrap') out[`${name}:${pid}`] = Math.round(Number(rss) / 1024)
    } catch { /* process exited */ }
  }
  return out
}
