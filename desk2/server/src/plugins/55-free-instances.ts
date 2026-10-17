import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { bridge } from '../bridge'
import type { ServerContext } from '../context'
import { ModelWatch } from '../free-instances/models'
import { planNotice } from '../free-instances/plan'
import { FreeError, FreeInstances } from '../free-instances/service'
import { daemonCreds, FreeSync } from '../free-instances/sync'
import { isRealHome } from '../real-home'

/** Opaque validators can contain commas: a split would mistake an embedded * for a wildcard. */
function unchangedHistory(value: string | undefined, tag: string): boolean {
  if (!value) return false
  const list = value.trim()
  if (list === '*') return true
  if (!/^(?:W\/)?"[^"]*"(?:\s*,\s*(?:W\/)?"[^"]*")*$/.test(list)) return false
  return list.match(/(?:W\/)?"[^"]*"/g)?.some(validator => validator === tag || validator === `W/${tag}`) ?? false
}

/** Root /api, independent of the upstream AgentHydra daemon and its CLI/Desktop accounts. */
export default function plugin(app: Hono, ctx: ServerContext): void {
  const service = (ctx.deps.freeInstances as FreeInstances | undefined) ?? new FreeInstances(ctx.home)
  // Chats pinned to ChatGPT send through it (the engine reads it from here).
  ctx.deps.freeInstances = service
  ctx.onStop(() => service.stop())
  service.onPlanChange = (instance) => {
    const notice = planNotice(instance)
    if (notice) ctx.broadcast({ type: 'notice', ...notice })
  }
  // A model no account listed before is told once (free-instances/models.ts); the seen file lives under this home.
  const watch = new ModelWatch(ctx.home)
  service.onUsage = () => {
    const notice = watch.check(service.allInstances())
    if (notice) ctx.broadcast({ type: 'notice', ...notice })
  }
  // The logins go to the other PCs through AgentHydra's Login sync store, from the real home only (real-home.ts): a
  // test's, an e2e script's or a probe's Desk never reaches the owner's store.
  const sync = isRealHome(ctx.home) ? new FreeSync(ctx.home, service.syncHost(), () => daemonCreds(bridge().url), () => ctx.wsVisibleCount() > 0) : undefined
  if (sync) {
    service.onLoginChange = () => sync.nudge()
    sync.start()
    const unsubscribe = ctx.onWsVisibility((visible) => {
      if (visible > 0) sync.wake()
    })
    ctx.onStop(() => {
      unsubscribe()
      sync.stop()
    })
  }
  const router = new Hono()
  router.onError((error, c) => c.json({ error: error instanceof FreeError ? error.message : 'Free instances could not complete the request.',
    ...(error instanceof FreeError && error.code ? { code: error.code } : {}) }, error instanceof FreeError ? error.status : 503))
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')
    let own = true
    try { if (origin) own = new URL(origin).host === c.req.header('host') } catch { own = false }
    if (!own || (site && site !== 'same-origin' && site !== 'none')) return c.json({ error: 'Free instances are only accessible from Desk 2’s own page.' }, 403)
    await next()
  })
  router.use('*', bodyLimit({ maxSize: 450_000, onError: c => c.json({ error: 'Request is too large.' }, 413) }))
  router.get('/status', c => c.json(service.status()))
  router.get('/pool', c => c.json({ version: 1 }))
  router.post('/pool/instances/:id/retire', async c => c.json(await service.retirePool(c.req.param('id'))))
  router.post('/pool/admissions', async c => c.json(await service.admitPool(await c.req.json().catch(() => null)), 201))
  router.post('/pool/admissions/:requestId/commit', async c => c.json(await service.commitPool(c.req.param('requestId'))))
  router.post('/pool/admissions/:requestId/abort', async c => c.json(await service.abortPool(c.req.param('requestId'))))
  router.get('/stats', c => c.json(service.stats(Number(c.req.query('days')) || 14)))
  router.get('/sync', c => c.json(sync?.status() ?? { on: false, lastSyncAt: null, lastError: null, shared: 0 }))
  router.post('/instances', async c => c.json(service.create(await c.req.json().catch(() => null)), 201))
  router.patch('/instances/:id', async c => c.json(service.rename(c.req.param('id'), await c.req.json().catch(() => null))))
  router.delete('/instances/:id', async c => c.json(await service.remove(c.req.param('id'))))
  router.get('/settings', c => c.json(service.settings()))
  router.patch('/settings', async c => c.json(service.updateSettings(await c.req.json().catch(() => null))))
  router.post('/instances/:id/logout', async c => c.json(await service.logout(c.req.param('id'))))
  router.post('/instances/:id/plan-seen', c => c.json(service.planSeen(c.req.param('id'))))
  // `since` (ms): only the threads started from then on, for a caller that needs the recent few (the pacing in
  // server/src/mcp-free.ts), not all ~22,000 (8 MB).
  router.get('/threads', c => {
    // Explicit selectors keep raw/conditional history readers backward compatible.
    // A full-list validator never validates a different selected representation.
    if (c.req.query('view') === 'recent')
      return c.json(service.recentThreads(Number(c.req.query('limit')),
        c.req.query('account') === undefined ? undefined : Number(c.req.query('account'))))
    if (c.req.query('view') === 'lookup')
      return c.json(service.lookupThreads(c.req.queries('chat_id') ?? []))
    const since = Number(c.req.query('since'))
    // Filtered callers keep their existing 200 response. Only a full-list reader can
    // validate the full history; no rows are read or serialized when it is unchanged.
    if (since > 0) return c.json(service.threads().filter(t => t.createdAt >= since))
    const tag = service.threadsETag()
    c.header('ETag', tag)
    if (unchangedHistory(c.req.header('if-none-match'), tag)) return c.body(null, 304)
    return c.json(service.threads())
  })
  // A thread's id is `<instance>/<chat>`: the slash may arrive encoded or not.
  router.delete('/threads/:id{.+}', c => c.json(service.forgetThread(c.req.param('id'))))
  router.post('/jobs', async c => c.json(service.start(await c.req.json().catch(() => null)), 202))
  router.get('/jobs', c => c.json({ jobs: service.getMany(c.req.query('ids')?.split(',')) }))
  router.get('/jobs/:id', c => c.json(service.get(c.req.param('id'))))
  router.delete('/jobs/:id', c => { service.cancel(c.req.param('id')); return c.json({ ok: true }) })
  app.route('/api/free', router)
}
