// E6: what an idle daemon sends out. Every proxy-aware outbound call goes to a counting listener
// that refuses it (HTTPS_PROXY, HTTP_PROXY), both download bases go to another, and on Linux the
// daemon's own sockets are read from /proc so a client that ignores the proxy is seen too.
//
// A fresh store downloads two things at boot, by design: the model price list
// (server/src/price-catalog.ts, raw.githubusercontent.com, when its cache is missing or a day old)
// and hydra_find's embedding model (server/src/tool-intent.ts, huggingface.co, once into
// DATA_DIR/models; AGENTHYDRA_TOOL_INTENT=0 turns it off). Those are the only destinations a boot
// may reach. After boot nothing may: no update check (auto-update is on by default and its loop
// asks GitHub), no download, nothing a newly synced upstream change starts in the background.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { type Daemon, hitHost, scenario, waitFor } from './harness'

const lane = scenario('E6')
const home = lane.home()
/** How long the daemon is left alone once its boot work has settled. */
const IDLE_MS = 10_000
/** Boot-time downloads a fresh store makes on purpose, and where each comes from. */
const BOOT_DOWNLOADS: Record<string, string> = {
  'raw.githubusercontent.com': 'the model price list, server/src/price-catalog.ts',
  'huggingface.co': "hydra_find's embedding model, server/src/tool-intent.ts",
}

let daemon: Daemon
let settledAt = 0

test('E6: a fresh boot reaches only its two documented downloads, and nothing is fetched from the download bases', async () => {
  daemon = await lane.boot(home)
  // Boot work is settled once no new outbound attempt has appeared for 3 s.
  let seen = -1
  let quietSince = Date.now()
  await waitFor(
    'boot to go quiet',
    () => {
      if (home.egress.hits.length !== seen) {
        seen = home.egress.hits.length
        quietSince = Date.now()
      }
      return Date.now() - quietSince >= 3_000
    },
    30_000,
    250,
  )
  settledAt = home.egress.hits.length
  const hosts = [...new Set(home.egress.hits.map(hitHost))].sort()
  expect(hosts.filter((h) => !(h in BOOT_DOWNLOADS))).toEqual([])
  expect(home.downloads.hits).toEqual([])
  expect((await daemon.api('/api/update/settings')).body.enabled).toBe(false)
}, 60_000)

/** Linux: the remote ends of the TCP sockets held by `pid` and its descendants that are open (or
 *  opening) to anything other than this machine, read from /proc. */
function outboundSockets(pid: number): string[] {
  const kids = new Map<number, number[]>()
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'latin1')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(p)])
    } catch {
      // gone
    }
  }
  const inodes = new Set<string>()
  for (const queue = [pid]; queue.length; ) {
    const p = queue.pop() as number
    queue.push(...(kids.get(p) ?? []))
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${p}/fd/${fd}`))
        if (m) inodes.add(m[1] as string)
      }
    } catch {
      // gone, or not ours
    }
  }
  const out: string[] = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string[] = []
    try {
      rows = readFileSync(table, 'latin1').trim().split('\n').slice(1)
    } catch {
      continue
    }
    for (const row of rows) {
      const f = row.trim().split(/\s+/)
      const [remote = '', state = '', inode = ''] = [f[2], f[3], f[9]]
      // 01 established, 02 syn-sent: a connection out, made or being made.
      if (!inodes.has(inode) || (state !== '01' && state !== '02')) continue
      const addr = remote.split(':')[0] ?? ''
      const v4 =
        addr.length === 8 ? addr : addr.startsWith('0000000000000000FFFF0000') ? addr.slice(24) : ''
      const loopback = v4 ? v4.endsWith('7F') : addr === '00000000000000000000000001000000'
      if (loopback) continue
      // The kernel writes an IPv4 address as one little-endian hex word, the port as hex.
      const port = Number.parseInt(remote.split(':')[1] ?? '', 16)
      const ip = v4 ? (v4.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)).reverse() : null
      out.push(ip ? `${ip.join('.')}:${port}` : `[${addr}]:${port}`)
    }
  }
  return out
}

test(
  `E6: left idle for ${IDLE_MS / 1000} s, the daemon makes no outbound attempt at all`,
  async () => {
    const direct = new Set<string>()
    const until = Date.now() + IDLE_MS
    while (Date.now() < until) {
      if (process.platform === 'linux')
        for (const s of outboundSockets(daemon.proc.pid)) direct.add(s)
      await Bun.sleep(250)
    }
    expect(home.egress.hits.slice(settledAt)).toEqual([])
    expect(home.downloads.hits).toEqual([])
    expect([...direct]).toEqual([])
  },
  IDLE_MS + 30_000,
)

lane.realHomeUntouched()
