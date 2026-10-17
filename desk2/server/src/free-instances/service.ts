import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE_CLAUDE_MODELS, FREE_COMMANDS, FREE_PROVIDERS, FREE_SETTINGS_DEFAULTS, isFreeChatgptModel, promotionFor, type FreeHealth, type FreeInstance, type FreeJob, type FreePoolAdmission, type FreePoolCommit, type FreeRequest, type FreeResult, type FreeSettings, type FreeStatRow, type FreeStatus, type FreeThread, type FreeTokens } from '@shared/free-instances'
import { addOutcome, healthOf, type SendOutcome } from './health'
import { NUDGE_EVERY_MS, nudgeDue } from './keepalive'
import { nextRead, REFRESH_TICK_MS, USAGE_EVERY_MS } from './refresh'
import { failure, parseResult } from './results'
import { runFree, type FreeRunner } from './runner'
import { ManagedFreeRuntime, SetupRefused, type FreeRuntime } from './runtime'
import { FreeStorage } from './storage'
import { readLogin, type FreeSyncHost } from './sync'
import { poolCount, poolPlan, poolVictims } from './pool-policy'
import { addStat, statRows } from './stats'
import { addTokens, estimateTokens, type TokenEntry, tokenWindows } from './tokens'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class FreeError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 503 = 400, public code?: string) { super(message) }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FreeError('A JSON operation is required.')
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new FreeError('A name must contain 1–100 printable characters.')
  return value.trim()
}
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v)
/** Operations running at once, and operations kept (running, and finished ones waiting to be read; see start). */
const MAX_RUNNING = 16
const MAX_KEPT = 200
/** How long a shutdown waits for aborted jobs to save their last state, ms. */
const STOP_WAIT_MS = 2000
function checkIdentity(r: FreeRequest): void {
  const keys = ['requestId', 'instanceId', 'provider', 'command', 'chatId', 'prompt', 'name', 'webSearch', 'model']
  if (Object.keys(r).some(k => !keys.includes(k))) throw new FreeError('Unknown operation option.')
  if (!isUuid(r.requestId) || !isUuid(r.instanceId) || !FREE_PROVIDERS.includes(r.provider) || !FREE_COMMANDS.includes(r.command)) throw new FreeError('Request and instance UUIDs, a supported provider and command are required.')
}
function checkChatAndPrompt(r: FreeRequest, send: boolean): void {
  const reference = ['read', 'resume', 'track'].includes(r.command)
  if (reference ? !isUuid(r.chatId) : r.chatId !== undefined) throw new FreeError('Use an explicit chat UUID for read, resume or track.')
  if (send ? typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 100_000 : r.prompt !== undefined) throw new FreeError('Messages must contain 1–100,000 characters, only for chat or resume.')
}
function checkOptions(r: FreeRequest, send: boolean): void {
  if (r.name !== undefined) { if (!['chat', 'track'].includes(r.command)) throw new FreeError('Name is an option for chat or track.'); name(r.name) }
  if (r.command === 'nudge' && r.provider !== 'claude') throw new FreeError('A keepalive nudge is for Claude only.')
  if (r.command === 'track' && !r.name) throw new FreeError('A name is required when tracking a chat.')
  const claudeMessage = send && r.provider === 'claude'
  if (r.webSearch !== undefined && (typeof r.webSearch !== 'boolean' || !claudeMessage)) throw new FreeError('Web search is an option for Claude messages only.')
  if (r.model !== undefined) {
    const claude = r.provider === 'claude'
    const ok = send && typeof r.model === 'string' && (claude ? (FREE_CLAUDE_MODELS as readonly string[]).includes(r.model) : isFreeChatgptModel(r.model))
    if (!ok) throw new FreeError(claude ? `Model is ${FREE_CLAUDE_MODELS.join(' or ')} for a Claude message.`
      : 'Model is gpt-instant, gpt-thinking, gpt-auto, luna-thinking, gpt-6, gpt-6-thinking or a slug the account lists (gpt-...) for a ChatGPT message.')
  }
}
export function validateRequest(value: unknown): FreeRequest {
  const r = record(value) as unknown as FreeRequest
  checkIdentity(r)
  const send = r.command === 'chat' || r.command === 'resume'
  checkChatAndPrompt(r, send)
  checkOptions(r, send)
  return { ...r }
}

export class FreeInstances {
  private store: FreeStorage
  private runtime: FreeRuntime
  private jobs = new Map<string, FreeJob>()
  private fingerprints = new Map<string, string>()
  private controllers = new Map<string, AbortController>()
  /** Accounts whose log out is running: no operation may start on them meanwhile. */
  private forgetting = new Set<string>()
  private poolTail: Promise<unknown> = Promise.resolve()
  private poolCommits = new Map<string, Promise<FreePoolCommit>>()
  private stopping = false
  /** Keep windows running: a first pass a minute after start, then every NUDGE_EVERY_MS. */
  private keeper: ReturnType<typeof setTimeout>
  /** The rolling refresh (refresh.ts): a first read a minute and a half after start, then one each REFRESH_TICK_MS. */
  private refresher: ReturnType<typeof setTimeout>
  /** When the rolling refresh last started a read on each account: one per USAGE_EVERY_MS at most, so a read that
   *  fails before it records anything (setup, a crash) is not tried again every tick. */
  private refreshed = new Map<string, number>()
  /** Each operation's end: a person's operation waits for it while Desk's own read (FreeJob.auto) holds the account. */
  private runs = new Map<string, Promise<void>>()
  /** Each account's messages in the last hour and how they ended (health.ts). Kept in memory: an hour is gone soon. */
  private outcomes = new Map<string, SendOutcome[]>()
  /** Thread counts change only on insertion, removal or a status transition, not on every poll. */
  private threadRevision = 0
  private threadSummary?: { threads: FreeThread[]; length: number; revision: number; running: number; counts: Record<string, number> }
  /** A restart must not validate a browser's history from the previous process. No account data is in this tag. */
  private historyEpoch = randomUUID()
  private historyRevision = 0
  /** A sign-in or a log out here (the Free login sync listens, so the other PCs hear soon). */
  onLoginChange?: () => void
  /** An account moved between free and paid (notePlan); the plugin tells the window. */
  onPlanChange?: (instance: FreeInstance) => void
  /** Told after a usage reading is kept on an account (the model watch reads the listed models). */
  onUsage?: (instance: FreeInstance) => void
  constructor(home: string, private runner: FreeRunner = runFree, runtime?: FreeRuntime) {
    this.store = new FreeStorage(home)
    this.runtime = runtime ?? new ManagedFreeRuntime(home)
    // Armed only once the store has loaded. Armed before (as field initialisers), a store that failed to load left
    // them running on an instance with no store, and the first pass a minute later took the whole server down
    // (2026-10-08), where the plugin's failure alone costs only Free.
    this.keeper = setTimeout(() => { this.keepWindows(); this.keeper = setInterval(() => this.keepWindows(), NUDGE_EVERY_MS).unref() }, 60_000).unref()
    this.refresher = setTimeout(() => { this.refreshNext(); this.refresher = setInterval(() => this.refreshNext(), REFRESH_TICK_MS).unref() }, 90_000).unref()
  }
  private prune(): void {
    for (const [id, job] of this.jobs) if (job.finishedAt && Date.now() - job.finishedAt > 15 * 60_000) { this.jobs.delete(id); this.fingerprints.delete(id) }
  }
  private instance(id: string): FreeInstance {
    const instance = this.store.data.instances.find(i => i.id === id)
    if (!instance) throw new FreeError('Free instance not found.', 404)
    return instance
  }
  create(value: unknown): FreeInstance {
    const r = record(value)
    if (Object.keys(r).some(k => !['provider', 'name'].includes(k)) || !FREE_PROVIDERS.includes(r.provider as FreeInstance['provider'])) throw new FreeError('Choose Claude or ChatGPT.')
    return this.store.create(r.provider as FreeInstance['provider'], r.name === undefined ? undefined : name(r.name))
  }
  private poolSerial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.poolTail.then(work)
    this.poolTail = next.then(() => undefined, () => undefined)
    return next
  }
  private poolEntry(requestId: string): FreeInstance {
    if (!isUuid(requestId)) throw new FreeError('An admission UUID is required.')
    const instance = this.store.data.instances.find(i => i.poolAdmission?.requestId === requestId)
    if (!instance) throw new FreeError('Pool admission not found.', 404, 'pool_not_found')
    return instance
  }
  private async poolSaved(): Promise<void> {
    if (!await this.store.saveDurable()) throw new FreeError('The pool change could not be confirmed on disk. Keep the imported login and resolve the same admission before changing it.', 503, 'pool_persist_failed')
  }
  /** Release an idle Free slot while preserving the account's saved login and history. */
  retirePool(id: string): Promise<{ ok: true; id: string; retired: true; count: number }> {
    return this.poolSerial(async () => {
      if (this.stopping) throw new FreeError('Desk is stopping. Retire this account after reconnecting.', 503)
      const instance = this.instance(id)
      if (this.busy(id)) throw new FreeError('This account has an operation running. Wait for it to finish before retiring it.', 409, 'pool_busy')
      if (instance.poolState === 'pending' || instance.poolAdmission?.state === 'pending')
        throw new FreeError('Resolve this account’s pending import before retiring it.', 409, 'pool_pending')
      if (poolPlan(instance) !== 'free') throw new FreeError('Only a verified Free account can be retired from the pool.', 409, 'pool_changed')
      const retired = instance.poolState === 'retired'
      if (!retired) {
        if (!instance.loggedIn || !instance.email || instance.checkedAt == null || (instance as FreeInstance & { movedAway?: unknown }).movedAway)
          throw new FreeError('Verify this Free account before retiring it from the pool.', 409, 'pool_verification_failed')
        this.poolLogin(instance)
      }
      this.forgetting.add(id)
      try {
        instance.poolState = 'retired'
        try { await this.poolSaved() }
        catch (error) {
          if (!retired) { delete instance.poolState; this.store.save() }
          throw error
        }
        return { ok: true, id, retired: true, count: poolCount(this.store.data.instances, instance.provider) }
      } finally { this.forgetting.delete(id) }
    })
  }
  /** Staging precedes the caller's cookie export. No pending account can generate or sync a login. */
  admitPool(value: unknown): Promise<{ requestId: string; instance: FreeInstance; existing: boolean; pending: true }> {
    const r = record(value)
    if (Object.keys(r).some(k => !['requestId', 'provider', 'email', 'plan', 'limit', 'instanceId'].includes(k)) ||
      !isUuid(r.requestId) || !FREE_PROVIDERS.includes(r.provider as FreeInstance['provider']) ||
      typeof r.email !== 'string' || r.email.length > 254 || !/^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+$/.test(r.email) ||
      !['free', 'go'].includes(r.plan as string) || (r.plan === 'go' && r.provider !== 'chatgpt') ||
      !Number.isInteger(r.limit) || (r.limit as number) < 0 || (r.limit as number) > 500 ||
      (r.instanceId !== undefined && !isUuid(r.instanceId))) throw new FreeError('A request UUID, provider, email, Free/Go plan and limit from 0 to 500 are required.')
    const requestId = r.requestId as string
    const email = r.email.toLowerCase()
    return this.poolSerial(async () => {
      if (this.stopping) throw new FreeError('Desk is stopping. Resume the admission after reconnecting.', 503)
      const previous = this.store.data.instances.find(i => i.poolAdmission?.requestId === requestId)
      if (previous) {
        const a = previous.poolAdmission!
        if (previous.provider !== r.provider || a.email !== email || a.plan !== r.plan || a.limit !== r.limit || a.targetId !== r.instanceId)
          throw new FreeError('That admission UUID already identifies another import.', 409, 'pool_changed')
        if (a.state !== 'pending') throw new FreeError('That admission has already ended. Read its commit receipt or use a new request UUID.', 409, 'pool_changed')
        await this.poolSaved()
        return { requestId, instance: previous, existing: a.existing, pending: true }
      }
      if (this.jobs.has(requestId)) throw new FreeError('That request UUID already identifies an operation.', 409, 'pool_changed')
      const matches = this.store.data.instances.filter(i => i.provider === r.provider && i.email?.toLowerCase() === email)
      let instance: FreeInstance | undefined
      if (r.instanceId) {
        instance = this.instance(r.instanceId as string)
        if (instance.provider !== r.provider || instance.email?.toLowerCase() !== email ||
          (instance as FreeInstance & { movedAway?: unknown }).movedAway)
          throw new FreeError('The selected pool account no longer matches this email and provider.', 409, 'pool_changed')
      } else {
        if (matches.length > 1 || matches.some(i => i.poolState))
          throw new FreeError('Select the exact existing pool account before renewing this email.', 409, 'pool_changed')
        instance = matches[0]
      }
      if (instance?.poolState === 'pending') throw new FreeError('This account already has a pending import.', 409, 'pool_busy')
      if (instance && (instance as FreeInstance & { movedAway?: unknown }).movedAway)
        throw new FreeError('A moved-away account cannot be renewed into this pool.', 409, 'pool_changed')
      if (instance) {
        await this.autoSettled(instance.id)
        if (this.stopping || this.busy(instance.id) || this.instance(instance.id) !== instance || instance.email?.toLowerCase() !== email)
          throw new FreeError('This pool account changed or has an operation running. Try after it finishes.', 409, 'pool_busy')
      }
      const existing = !!instance
      const before = instance ? structuredClone(Object.fromEntries(Object.entries(instance).filter(([k]) => k !== 'poolAdmission'))) as Omit<FreeInstance, 'poolAdmission'> : undefined
      const admission: FreePoolAdmission = { requestId, email, plan: r.plan as 'free' | 'go', limit: r.limit as number,
        existing, state: 'pending', ...(r.instanceId ? { targetId: r.instanceId as string } : {}), ...(before ? { before } : {}) }
      if (instance) { instance.poolState = 'pending'; instance.poolAdmission = admission }
      else instance = this.store.create(r.provider as FreeInstance['provider'], email, { poolState: 'pending', poolAdmission: admission })
      this.forgetting.add(instance.id)
      try { await this.poolSaved() } finally { this.forgetting.delete(instance.id) }
      return { requestId, instance, existing, pending: true }
    })
  }
  abortPool(requestId: string): Promise<{ ok: true; id: string; existing: boolean; aborted: true }> {
    return this.poolSerial(async () => {
      const instance = this.poolEntry(requestId)
      const a = instance.poolAdmission!
      if (this.stopping || this.busy(instance.id) || this.poolCommits.has(requestId))
        throw new FreeError('This admission is still being checked. Resolve it before restoring a login.', 409, 'pool_busy')
      if (a.state === 'committed') throw new FreeError('This admission was committed and cannot be aborted.', 409, 'pool_changed')
      this.forgetting.add(instance.id)
      try {
        if (a.state === 'pending') {
          if (a.existing) {
            if (!a.before || a.before.id !== instance.id) throw new FreeError('The original pool metadata is unavailable. Keep this import pending for review.', 409, 'pool_changed')
            for (const key of Object.keys(instance)) delete (instance as unknown as Record<string, unknown>)[key]
            Object.assign(instance, structuredClone(a.before))
          } else instance.poolState = 'retired'
          a.state = 'aborted'; delete a.before
          instance.poolAdmission = a
        }
        await this.poolSaved()
        return { ok: true, id: instance.id, existing: a.existing, aborted: true }
      } finally { this.forgetting.delete(instance.id) }
    })
  }
  commitPool(requestId: string): Promise<FreePoolCommit> {
    if (this.stopping) throw new FreeError('Desk is stopping. Resolve this admission after reconnecting.', 503)
    const running = this.poolCommits.get(requestId)
    if (running) return running
    const instance = this.poolEntry(requestId)
    const a = instance.poolAdmission!
    if (a.state === 'committed' && a.result) return this.poolSerial(async () => {
      if (this.stopping) throw new FreeError('Desk is stopping. Resolve this admission after reconnecting.', 503)
      await this.poolSaved(); return structuredClone(a.result!)
    })
    if (a.state !== 'pending' || instance.poolState !== 'pending') throw new FreeError('This admission is no longer pending.', 409, 'pool_changed')
    if (this.stopping || this.busy(instance.id)) throw new FreeError('This account has an operation running. Try after it finishes.', 409, 'pool_busy')
    if ([...this.jobs.values()].filter(job => job.state === 'running').length >= MAX_RUNNING)
      throw new FreeError(`Desk already has ${MAX_RUNNING} operations running.`, 409, 'pool_busy')
    this.forgetting.add(instance.id)
    const controller = new AbortController()
    this.controllers.set(`pool:${requestId}`, controller)
    const job: FreeJob = { id: requestId, instanceId: instance.id, provider: instance.provider,
      command: 'auth', state: 'running', phase: 'working', startedAt: Date.now() }
    this.jobs.set(requestId, job)
    const deadline = setTimeout(() => controller.abort(), 120_000)
    const work = this.verifyPool(instance, a, controller.signal).then(result => {
      job.result = { ok: true, authenticated: true, account_email: a.email }
      return result
    }, error => {
      job.result = failure(error instanceof FreeError ? error.code ?? 'pool_verification_failed' : 'pool_verification_failed',
        error instanceof FreeError ? error.message : 'The pool verification did not finish. Resolve the pending admission before changing its login.')
      throw error
    }).finally(() => {
      job.state = 'done'; job.finishedAt = Date.now()
      clearTimeout(deadline); this.controllers.delete(`pool:${requestId}`)
      this.forgetting.delete(instance.id); this.poolCommits.delete(requestId)
    })
    this.poolCommits.set(requestId, work)
    this.runs.set(`pool:${requestId}`, work.then(() => undefined, () => undefined))
    void work.then(() => this.runs.delete(`pool:${requestId}`), () => this.runs.delete(`pool:${requestId}`))
    return work
  }
  private poolLogin(instance: FreeInstance): string {
    const file = join(this.runtime.config(instance.id).stateDir, instance.provider === 'chatgpt' ? 'chatgpt' : '', 'session.dpapi')
    const login = readLogin(file, instance.provider)
    if (!login || (instance.provider === 'chatgpt' && !login.fresh))
      throw new FreeError('The imported login is missing a complete browser sign-in. Keep this account pending.', 503, 'pool_verification_failed')
    // GPT's locked auth result proves the exact post-save file, including rotations.
    return createHash('sha256').update(instance.provider === 'chatgpt' ? readFileSync(file) : JSON.stringify(login.cookies)).digest('hex')
  }
  private async verifyPool(instance: FreeInstance, a: FreePoolAdmission, signal: AbortSignal): Promise<FreePoolCommit> {
    await this.runtime.ensure(instance.provider)
    const config = this.runtime.config(instance.id)
    let planCheckedAt: string | undefined
    let authLoginProof: string | undefined
    const read = async (command: 'auth' | 'usage'): Promise<FreeResult> => {
      signal.throwIfAborted()
      const output = await this.runner(config, { requestId: randomUUID(), instanceId: instance.id, provider: instance.provider, command }, signal)
      const result = parseResult(command, output)
      if (command === 'auth' && instance.provider === 'chatgpt') {
        authLoginProof = undefined
        try {
          const raw = JSON.parse(output.stdout)
          if (typeof raw.login_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(raw.login_fingerprint)) authLoginProof = raw.login_fingerprint
        } catch { /* Missing or malformed auth proof fails closed below. */ }
      }
      if (command === 'usage' && instance.provider === 'claude') {
        try { const raw = JSON.parse(output.stdout); planCheckedAt = typeof raw.checked_at === 'string' ? raw.checked_at : undefined } catch { /* parseResult fails closed */ }
      }
      signal.throwIfAborted()
      if (!result.ok) throw new FreeError('The imported login could not be verified. Keep it pending or restore the previous login before aborting.', 503, 'pool_verification_failed')
      return result
    }
    const auth = async (): Promise<void> => {
      const result = await read('auth')
      if (!result.authenticated || result.account_email?.toLowerCase() !== a.email)
        throw new FreeError('The imported login did not verify the expected account email.', 503, 'pool_verification_failed')
      if (instance.provider === 'chatgpt') {
        if (!authLoginProof) throw new FreeError('The ChatGPT runtime did not return its saved-login proof. Update its runtime before resolving this import.', 503, 'pool_verification_failed')
        if (this.poolLogin(instance) !== authLoginProof) throw new FreeError('The saved login changed after authentication. Resolve this pending admission again.', 409, 'pool_changed')
      }
    }
    this.poolLogin(instance)
    await auth()
    const authenticated = this.poolLogin(instance)
    const started = Date.now()
    const result = await read('usage')
    const usage = result.usage
    // Claude's plan is read from fresh organization capabilities even when quota counters are unavailable/cached.
    const observed = instance.provider === 'claude' ? planCheckedAt : usage?.observed_at
    if (!usage || (instance.provider === 'chatgpt' && (!usage.available || usage.is_snapshot)) || !observed || Date.parse(observed) < started - 60_000 ||
      Date.parse(observed) > Date.now() + 60_000 || !Number.isFinite(Date.parse(observed)) ||
      usage.plan?.toLowerCase() !== a.plan)
      throw new FreeError('A fresh matching Free/Go plan reading was not available. No account was replaced.', 503, 'pool_verification_failed')
    let verified = this.poolLogin(instance)
    // Auth may legitimately rotate cookies. Reconfirm identity if the usage read rotated them again.
    if (verified !== authenticated) {
      await auth()
      if (instance.provider === 'chatgpt') verified = authLoginProof!
      else if (this.poolLogin(instance) !== verified) throw new FreeError('The saved login changed during verification. Resolve this pending admission again.', 409, 'pool_changed')
    }
    return this.poolSerial(async () => {
      signal.throwIfAborted()
      if (this.stopping || this.poolEntry(a.requestId) !== instance || instance.poolAdmission !== a ||
        a.state !== 'pending' || instance.poolState !== 'pending' || this.poolLogin(instance) !== verified)
        throw new FreeError('The pending account changed before the pool commit.', 409, 'pool_changed')
      const before = a.before
      if (a.existing && (!before || before.id !== instance.id || before.provider !== instance.provider ||
        before.email?.toLowerCase() !== a.email || before.poolState === 'pending' ||
        (before as FreeInstance & { movedAway?: unknown }).movedAway))
        throw new FreeError('The original pool account no longer matches this renewal.', 409, 'pool_changed')
      // Refreshing an existing managed identity is not a new admission, even if its old login
      // expired or it was retired. The configured cap must never block it or evict a bystander.
      const renewal = a.existing
      const projected = { ...instance, email: a.email, loggedIn: true, plan: a.plan, usage }
      const victims = renewal ? [] : poolVictims(this.store.data.instances, projected, a.plan, a.limit, id => this.busy(id))
      if (!victims) throw new FreeError('The web pool is full. No idle lower-priority Free account can be replaced.', 409, 'pool_full')
      for (const victim of victims) this.forgetting.add(victim.id)
      const old = { email: instance.email, loggedIn: instance.loggedIn, checkedAt: instance.checkedAt,
        lastSignedInAt: instance.lastSignedInAt, usage: instance.usage, usageReadAt: instance.usageReadAt, plan: instance.plan }
      try {
        const now = Date.now()
        Object.assign(instance, { email: a.email, loggedIn: true, checkedAt: now, lastSignedInAt: now, usage, usageReadAt: now, plan: a.plan })
        delete instance.poolState
        for (const victim of victims) victim.poolState = 'retired'
        const receipt: FreePoolCommit = { ok: true, id: instance.id, existing: a.existing, replaced: victims.map(i => i.id), count: poolCount(this.store.data.instances, instance.provider), limit: a.limit }
        a.state = 'committed'; a.result = receipt
        try { await this.poolSaved() }
        catch (error) {
          // A failed/late write is uncertain. Queue a newer safe pending snapshot; never remove either login.
          Object.assign(instance, old); instance.poolState = 'pending'
          for (const victim of victims) delete victim.poolState
          a.state = 'pending'; delete a.result
          this.store.save()
          throw error
        }
        delete a.before
        this.store.save()
        this.onLoginChange?.()
        return structuredClone(receipt)
      } finally { for (const victim of victims) this.forgetting.delete(victim.id) }
    })
  }
  rename(id: string, value: unknown): FreeInstance {
    const r = record(value)
    if (Object.keys(r).some(k => k !== 'name')) throw new FreeError('Only a name can be changed.')
    const instance = this.instance(id)
    instance.name = name(r.name)
    instance.autoName = false
    this.store.save()
    return instance
  }
  /**
   * Removes the stored sign-in only (chats and metadata stay); the account can sign in again later. The harness's own
   * forget does it: it deletes the saved login (and for ChatGPT its preparations) under the lock a cookie refresh takes.
   */
  async logout(id: string): Promise<FreeInstance> {
    this.instance(id)
    if (this.stopping) throw new FreeError('Desk is stopping. Log out after reconnecting.', 503)
    await this.autoSettled(id)
    const instance = this.instance(id)
    if (this.busy(id)) throw new FreeError('This account has an operation running. Wait for it to finish or cancel it first.', 409)
    this.forgetting.add(id)
    try {
      try { await this.runtime.ensure(instance.provider) }
      catch (e) { throw new FreeError(e instanceof SetupRefused ? e.message : 'Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.', 503) }
      const done = await this.runner(this.runtime.config(id), { requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'forget' }, AbortSignal.timeout(240_000)).catch(() => null)
      if (done?.code !== 0) throw new FreeError('The saved login could not be removed. Try again.', 503)
    } finally { this.forgetting.delete(id) }
    instance.loggedIn = false
    instance.checkedAt = Date.now()
    instance.usage = null
    // The next sign-in may be another account: its check reads the address and the plan again.
    instance.email = null
    instance.plan = null
    instance.planChange = null
    // Logged out on purpose, not lost: the row offers "Sign in", and "Sign in again" stays for an expired login.
    instance.lastSignedInAt = null
    this.store.save()
    this.onLoginChange?.()
    return instance
  }
  /**
   * Deletes the account here: its login, state folder, chats and row. Deleting reaches every PC, as a log out does:
   * the sync leaves a tombstone for the store, and the other PCs remove it too (they pass `tombstone: false`).
   */
  async remove(id: string, opts: { tombstone?: boolean } = {}): Promise<{ ok: true }> {
    this.instance(id)
    if (this.stopping) throw new FreeError('Desk is stopping. Delete the account after reconnecting.', 503)
    await this.autoSettled(id)
    const instance = this.instance(id)
    if (this.busy(id)) throw new FreeError('This account has an operation running. Wait for it to finish or cancel it first.', 409)
    this.forgetting.add(id)
    try {
      // The harness's forget also stops a live ChatGPT worker; its failure does not matter, the folder delete removes the login file anyway.
      try {
        await this.runtime.ensure(instance.provider)
        await this.runner(this.runtime.config(id), { requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'forget' }, AbortSignal.timeout(240_000))
      } catch { /* deleted regardless */ }
      for (const [jobId, job] of this.jobs) if (job.instanceId === id) { this.jobs.delete(jobId); this.fingerprints.delete(jobId) }
      this.historyRevision++
      this.store.remove(id, opts.tombstone ?? true)
      this.threadSummary = undefined
      this.refreshed.delete(id)
      this.outcomes.delete(id)
    } finally { this.forgetting.delete(id) }
    this.onLoginChange?.()
    return { ok: true }
  }
  private busy(id: string): boolean {
    return this.forgetting.has(id) || [...this.jobs.values()].some(j => j.instanceId === id && j.state === 'running')
  }
  /** Waits until no read of Desk's own (FreeJob.auto) runs on the account: a person's log out or delete waits for one
   *  rather than being refused. */
  private async autoSettled(id: string): Promise<void> {
    for (;;) {
      const job = [...this.jobs.values()].find(j => j.instanceId === id && j.state === 'running' && j.auto)
      const run = job && this.runs.get(job.id)
      if (!run) return
      await run
    }
  }
  settings(): FreeSettings { return this.store.data.settings ?? { ...FREE_SETTINGS_DEFAULTS } }
  updateSettings(value: unknown): FreeSettings {
    const r = record(value)
    if (Object.keys(r).some(k => k !== 'keepWindows' && k !== 'weeklyFloorPct')) throw new FreeError('Only keepWindows and weeklyFloorPct can be changed.')
    if (r.keepWindows !== undefined && typeof r.keepWindows !== 'boolean') throw new FreeError('keepWindows must be true or false.')
    if (r.weeklyFloorPct !== undefined && (!Number.isInteger(r.weeklyFloorPct) || (r.weeklyFloorPct as number) < 1 || (r.weeklyFloorPct as number) > 100)) throw new FreeError('weeklyFloorPct must be a whole number from 1 to 100.')
    this.store.data.settings = { ...this.settings(), ...r }
    this.store.save()
    setTimeout(() => this.keepWindows(), 0).unref()
    return this.store.data.settings
  }
  /** Starts a nudge on each signed-in Claude account that is due (keepalive.ts); one that is busy waits for the next pass. */
  keepWindows(): void {
    const settings = this.settings()
    for (const instance of [...this.store.data.instances]) {
      if (instance.poolState || !nudgeDue(instance, settings, Date.now()) || this.busy(instance.id)) continue
      try { this.start({ requestId: randomUUID(), instanceId: instance.id, provider: 'claude', command: 'nudge' }, true) } catch { /* Desk is stopping or its jobs are full; the next pass tries again */ }
    }
  }
  /** One read of the rolling refresh (refresh.ts): the most overdue account's login check or usage, as Desk's own job. */
  refreshNext(): void {
    if (this.stopping) return
    // Recovery replies keep the same expiry even when no account needs a read.
    this.prune()
    const now = Date.now()
    const read = nextRead(this.store.data.instances, id => !!this.instance(id).poolState || this.busy(id) || now - (this.refreshed.get(id) ?? 0) < USAGE_EVERY_MS, now)
    if (!read) return
    this.refreshed.set(read.id, now)
    try { this.start({ requestId: randomUUID(), instanceId: read.id, provider: this.instance(read.id).provider, command: read.command }, true) } catch { /* its jobs are full; a later tick reads it */ }
  }
  /** What the Free login sync (sync.ts) reads and does here. */
  syncHost(): FreeSyncHost {
    return {
      list: () => this.store.data.instances,
      deleted: () => this.store.data.deleted ?? [],
      settled: id => this.store.settle(id),
      remove: async id => { await this.remove(id, { tombstone: false }) },
      busy: id => !!this.store.data.instances.find(i => i.id === id)?.poolState || this.busy(id),
      sessionFile: i => join(this.runtime.config(i.id).stateDir, i.provider === 'chatgpt' ? 'chatgpt' : '', 'session.dpapi'),
      adopt: shared => this.store.adopt(shared),
      landed: id => {
        const instance = this.instance(id)
        if (instance.poolState || this.occupied(id)) return
        instance.loggedIn = true
        instance.checkedAt = instance.lastSignedInAt = Date.now()
        this.store.save()
        // Check it here at once: the row then says whether the login works on this PC, with its quota. A read of Desk's
        // own already running began with the old login and may report it gone: this check waits and comes after it.
        void this.autoSettled(id).then(() => {
          try { this.start({ requestId: randomUUID(), instanceId: id, provider: instance.provider, command: 'auth' }, true) } catch { /* someone's operation runs on it; the next check confirms the login */ }
        })
      },
      forget: async id => { await this.logout(id) }
    }
  }
  threads(): FreeThread[] { return this.store.data.threads }
  /** Opt-in bounded history for callers that would otherwise download every row then slice it. */
  recentThreads(limit: number, account?: number): { total: number; threads: FreeThread[] } {
    const byId = new Map(this.store.data.instances.map(instance => [instance.id, instance]))
    const mine = this.store.data.threads.filter(thread => account === undefined || byId.get(thread.instanceId)?.num === account)
    const count = Math.max(1, Math.min(Number(limit) || 30, 500))
    return { total: mine.length, threads: mine.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, count) }
  }
  /** The first stored match wins, just as a full history's find(chatId) did, even for a removed account. */
  lookupThreads(chatIds: readonly string[]): FreeThread[] {
    if (chatIds.length > 32) throw new FreeError('Look up at most 32 chat identifiers.')
    const wanted = new Set(chatIds)
    const found: FreeThread[] = []
    for (const thread of this.store.data.threads) {
      if (wanted.delete(thread.chatId)) found.push(thread)
      if (!wanted.size) break
    }
    return found
  }
  /** Full history validators are cheap; only actual thread writes invalidate them. */
  threadsETag(): string { return `"free-threads-${this.historyEpoch}-${this.historyRevision}"` }
  /** Removes one thread from Desk's list (a private chat: it is not in the site's history either). Its tokens stay in the
   *  account's ledger, so the totals do not drop. Refused while its message is still running. Its id is remembered: the
   *  harness still lists the private chats it made, and the next read of them (refresh.ts, hourly) would add it back. */
  forgetThread(id: string): { ok: true } {
    const thread = this.store.data.threads.find(t => t.id === id)
    if (!thread) throw new FreeError('Thread not found.', 404)
    if (thread.status === 'running') throw new FreeError('This chat has a message running. Wait for it to finish or cancel it first.', 409)
    this.store.data.threads = this.store.data.threads.filter(t => t !== thread)
    this.historyRevision++
    this.threadSummary = undefined
    this.store.data.forgotten = [...(this.store.data.forgotten ?? []).filter(f => f !== id), id].slice(-5000)
    this.store.save()
    return { ok: true }
  }
  /** Every account row, as kept (the model watch reads their listed models). */
  allInstances(): readonly FreeInstance[] {
    return this.store.data.instances
  }
  status(): FreeStatus {
    this.prune()
    const now = Date.now()
    const tokens: Record<string, FreeTokens> = {}
    const health: Record<string, FreeHealth> = {}
    for (const i of this.store.data.instances) {
      const ledger = this.store.data.tokens?.[i.id]
      if (ledger) tokens[i.id] = tokenWindows(ledger, i.usage, now)
      const hour = healthOf(this.outcomes.get(i.id), now)
      if (hour) health[i.id] = hour
    }
    const threads = this.store.data.threads
    let summary = this.threadSummary
    if (!summary || summary.threads !== threads || summary.length !== threads.length || summary.revision !== this.threadRevision) {
      summary = { threads, length: threads.length, revision: this.threadRevision, running: 0, counts: {} }
      for (const t of threads) {
        if (t.status === 'running') summary.running++
        summary.counts[t.instanceId] = (summary.counts[t.instanceId] ?? 0) + 1
      }
      this.threadSummary = summary
    }
    return { ready: this.runtime.ready(), tokens, health, running: summary.running, threadCounts: { ...summary.counts }, instances: this.store.data.instances, jobs: [...this.jobs.values()].map(({ result, ...job }) => ({ ...job, chatId: result?.chat_id ?? result?.error?.chat_id ?? job.chatId })) }
  }
  /** The last `days` days' messages by account and model (stats.ts). */
  stats(days: number): FreeStatRow[] { return statRows(this.store.data.stats ?? {}, days, Date.now()) }
  get(id: string): FreeJob {
    this.prune()
    const job = this.jobs.get(id)
    if (!job) throw new FreeError('Operation not found or expired. Refresh the chat list and read the chat before sending again.', 404)
    return job
  }
  /** One bounded read/prune for a batch; an expired ID must not hide its siblings. */
  getMany(ids: unknown): Record<string, FreeJob | null> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 32 || ids.some(id => !isUuid(id)))
      throw new FreeError('Read between 1 and 32 operation UUIDs.')
    this.prune()
    return Object.fromEntries([...new Set(ids as string[])].map(id => [id, this.jobs.get(id) ?? null]))
  }
  cancel(id: string): void { this.get(id); this.controllers.get(id)?.abort() }
  /** True while start() would refuse an operation a person or a chat asks for on the account: one of theirs runs
   *  there, or its log out does (a read of Desk's own does not count: that one is waited for). */
  occupied(id: string): boolean {
    return this.forgetting.has(id) || [...this.jobs.values()].some(j => j.instanceId === id && j.state === 'running' && !j.auto)
  }
  /** `auto`: Desk's own job (FreeJob.auto). It never waits: it is refused while the account runs anything; an operation a
   *  person or a chat asks for while it runs waits for it instead of being refused. */
  start(value: unknown, auto = false): FreeJob {
    const r = validateRequest(value)
    const fingerprint = createHash('sha256').update(JSON.stringify([r.instanceId, r.provider, r.command, r.chatId, r.prompt, r.name, r.webSearch, r.model])).digest('hex')
    const previous = this.jobs.get(r.requestId)
    if (previous) {
      if (this.fingerprints.get(r.requestId) !== fingerprint) throw new FreeError('That request UUID already identifies another operation.', 409)
      return previous
    }
    if (this.stopping) throw new FreeError('Desk is stopping. Read the chat after reconnecting.', 503)
    const instance = this.instance(r.instanceId)
    if (instance.provider !== r.provider) throw new FreeError('The provider does not match this instance.')
    if (instance.poolState === 'pending') throw new FreeError('This account has a pending pool import. Resolve it before starting another operation.', 409, 'pool_pending')
    if (instance.poolState === 'retired' && ['chat', 'resume', 'nudge', 'login'].includes(r.command))
      throw new FreeError('This account is retired from the web pool. Renew its login before sending again.', 409, 'pool_retired')
    const running = [...this.jobs.values()].filter(j => j.instanceId === r.instanceId && j.state === 'running')
    if (this.forgetting.has(r.instanceId) || (running.length && (auto || running.some(j => !j.auto)))) throw new FreeError('This account already has an operation running.', 409)
    this.prune()
    // At most MAX_RUNNING run at once. A finished one stays until its caller has read it (prune drops it 15 minutes
    // after it finished; past MAX_KEPT the earliest finished goes first). Before, any 17th operation dropped the
    // earliest STARTED finished one, often a send that had just finished and whose reply free_chat had not read yet, so
    // the caller was told operation_lost for a reply that had come (2026-10-10: 2 of 30 sends in one batch).
    if ([...this.jobs.values()].filter(j => j.state === 'running').length >= MAX_RUNNING)
      throw new FreeError(`Desk already has ${MAX_RUNNING} operations running.`, 409)
    if (this.jobs.size >= MAX_KEPT) {
      const done = [...this.jobs.values()].filter(j => j.state === 'done').sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      for (const old of done.slice(0, this.jobs.size - MAX_KEPT + 1)) { this.jobs.delete(old.id); this.fingerprints.delete(old.id) }
    }
    const job: FreeJob = { id: r.requestId, instanceId: r.instanceId, provider: r.provider, command: r.command, state: 'running', phase: 'setup', startedAt: Date.now(), chatId: r.chatId, ...(auto ? { auto: true } : {}) }
    this.jobs.set(job.id, job)
    this.fingerprints.set(job.id, fingerprint)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.markThread(r, 'running')
    const before = running.length ? Promise.all(running.map(j => this.runs.get(j.id))).then(() => undefined) : undefined
    const run = this.execute(job, r, controller, before).then(() => undefined, () => undefined)
    this.runs.set(job.id, run)
    void run.then(() => this.runs.delete(job.id))
    return job
  }
  /** noteThread, then the store saved. */
  private markThread(r: FreeRequest, status: FreeThread['status'], chatId = r.chatId, error: string | null = null, serverId?: string, title?: string, createdAt?: number, used = true): void {
    if (this.noteThread(r, status, chatId, error, serverId, title, createdAt, used)) this.store.save()
  }
  /**
   * Marks a thread (adding it when new) without saving the store; true when one was marked. apply() notes a whole
   * chat list and saves once: a save per chat wrote the whole store (5 MB, fsync'd) for each, and one account's list
   * of 1,493 chats held the server's one thread for 16 s, 30 to 80 s on a busy PC, the sidebar frozen meanwhile
   * (2026-10-09). `used` false for a chat-list refresh: it records the chat but is not a use, so "last used" stays.
   * `known` is the threads by id, for a caller noting many.
   */
  private noteThread(r: FreeRequest, status: FreeThread['status'], chatId = r.chatId, error: string | null = null, serverId?: string, title?: string, createdAt?: number, used = true, known?: Map<string, FreeThread>): boolean {
    if (!chatId || !UUID.test(chatId)) return false
    const id = `${r.instanceId}/${chatId}`
    // A forgotten chat used again (a message, a track, a read) is wanted again: the chat-list read keeps it current.
    const forgotten = this.store.data.forgotten
    if (used && forgotten?.includes(id)) this.store.data.forgotten = forgotten.filter(f => f !== id)
    let thread = known ? known.get(id) : this.store.data.threads.find(t => t.id === id)
    // An identical passive listing must keep the full-history validator. Used
    // operations still invalidate: their later accounting can change contextChars.
    const historyChanged = used || !thread || thread.status !== status || thread.error !== error ||
      !!(serverId && thread.serverId !== serverId) || !!(title && thread.title !== title)
    if (!thread) {
      const created = createdAt || Date.now()
      thread = { id, instanceId: r.instanceId, provider: r.provider, chatId, title: title || r.name || `${r.provider === 'claude' ? 'Claude' : 'ChatGPT'} · ${chatId.slice(0, 8)}`, status, createdAt: created, updatedAt: used ? Date.now() : created, error }
      this.store.data.threads.push(thread)
      known?.set(id, thread)
      this.threadRevision++
    }
    else if (thread.status !== status) this.threadRevision++
    if (historyChanged) this.historyRevision++
    Object.assign(thread, { status, error }, used ? { updatedAt: Date.now() } : {}, serverId ? { serverId } : {}, title ? { title } : {})
    return true
  }
  private async execute(job: FreeJob, r: FreeRequest, controller: AbortController, before?: Promise<void>): Promise<void> {
    let spent: TokenEntry | null = null
    try {
      // Desk's own read on this account ends first: one operation per account at a time. A cancel ends the wait.
      if (before) await Promise.race([before, new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))])
      controller.signal.throwIfAborted()
      try { await this.runtime.ensure(r.provider) }
      catch (e) { job.result = failure('setup_failed', e instanceof SetupRefused ? e.message : 'Automatic setup could not finish. Check that Python 3.11 or later, Bun and Node.js are installed, then try again.'); return }
      controller.signal.throwIfAborted()
      job.phase = 'working'
      const config = this.runtime.config(r.instanceId)
      job.result = parseResult(r.command, await this.runner(config, r, controller.signal))
      const instance = this.instance(r.instanceId)
      if (r.command === 'auth' || r.command === 'login') await this.afterAuth(r, job.result, instance, config, controller.signal)
      if (r.command === 'nudge') await this.afterNudge(r, job.result, instance, config, controller.signal)
      // finally saves the result together with its stats. Serializing here too
      // copied the entire history twice with no asynchronous work in between.
      spent = this.apply(r, job.result, false)
    } catch {
      job.result = failure('operation_interrupted', 'The operation was interrupted. Refresh the chat list and read the chat before sending again.', r.chatId)
      // finally persists this recovery state together with the completed job's accounting.
      this.noteThread(r, 'failed', r.chatId, job.result.error!.message)
    } finally {
      job.state = 'done'; job.finishedAt = Date.now(); this.controllers.delete(job.id)
      // A cancel is the asker's doing, not the account's.
      if ((r.command === 'chat' || r.command === 'resume') && !controller.signal.aborted) {
        this.outcomes.set(r.instanceId, addOutcome(this.outcomes.get(r.instanceId), { at: job.finishedAt, error: job.result?.ok ? null : (job.result?.error?.message ?? 'No result') }, job.finishedAt))
        const ok = job.result?.ok === true
        addStat((this.store.data.stats ??= {}), { at: job.finishedAt, instanceId: r.instanceId, model: ok ? job.result?.model : job.result?.error?.model, ok, code: job.result?.error?.code, input: spent?.input ?? 0, output: spent?.output ?? 0 })
      }
      this.store.save()
    }
  }
  private async afterAuth(r: FreeRequest, result: FreeResult, instance: FreeInstance, config: ReturnType<FreeRuntime['config']>, signal: AbortSignal): Promise<void> {
    // Only an answer moves the login: the site took it, or said it needs one (login_required or login_expired). A check that failed
    // on its own (offline after sleep, a crashed harness) leaves it as it was: Desk checks in the background now
    // (refresh.ts), and a working login read as signed out would never be checked again.
    const signedIn = result.ok && result.authenticated === true
    if (result.ok || r.command === 'login' || result.error?.code === 'login_required' || result.error?.code === 'login_expired') instance.loggedIn = signedIn
    instance.checkedAt = Date.now()
    if (!signedIn) return
    instance.lastSignedInAt = instance.checkedAt
    instance.email = result.account_email ?? null
    const label = result.account_label
    if (instance.autoName && label && label.length <= 100 && !/[\x00-\x1f]/.test(label)) instance.name = label
    this.onLoginChange?.()
    // Read-only followups bring imported chats and available quota into the shared view.
    for (const command of ['chats', 'usage'] as const) {
      // Keep the chat checkpoint before the next provider read. The last usage
      // result has no further provider wait: execute's finally saves it once.
      try { this.apply({ ...r, command }, parseResult(command, await this.runner(config, { ...r, command }, signal)), command !== 'usage') } catch { /* auth still succeeded; refresh can retry a read */ }
    }
  }
  private async afterNudge(r: FreeRequest, result: FreeResult, instance: FreeInstance, config: ReturnType<FreeRuntime['config']>, signal: AbortSignal): Promise<void> {
    instance.nudge = { at: Date.now(), ok: result.ok }
    // Read the quota again so the window the nudge started shows.
    if (result.ok) try { this.apply({ ...r, command: 'usage' }, parseResult('usage', await this.runner(config, { ...r, command: 'usage' }, signal)), false) } catch { /* the nudge worked; the next refresh reads it */ }
  }
  /** Keep the plan a reading reports; a move that changes what the account can be promoted to (promotionFor: Free to
   *  Go does not, Go to Plus does, and so does a first reading already on Plus) is kept on the row and told to
   *  onPlanChange. A reading with no plan changes nothing. */
  private notePlan(instance: FreeInstance, plan: string | null): void {
    if (!plan || plan === instance.plan) return
    const before = instance.plan ?? null
    instance.plan = plan
    if (promotionFor(instance.provider, plan) === promotionFor(instance.provider, before)) return
    instance.planChange = { from: before, to: plan, at: Date.now() }
    this.onPlanChange?.(instance)
  }
  /** The row's plan-change mark has been seen. */
  planSeen(id: string): FreeInstance {
    const instance = this.instance(id)
    instance.planChange = null
    this.store.save()
    return instance
  }
  /** Returns the message's token estimate, or null for anything that was not an answered message. */
  private apply(r: FreeRequest, result: NonNullable<FreeJob['result']>, persist = true): TokenEntry | null {
    const instance = this.instance(r.instanceId)
    if (result.usage) this.applyUsage(instance, result.usage)
    if (r.command === 'usage') instance.usageReadAt = Date.now()
    if (result.ok && (r.command === 'chat' || r.command === 'resume')) instance.lastActiveAt = Date.now()
    if (result.chats) this.applyChats(r, result.chats)
    if (!['auth', 'login', 'usage', 'chats', 'nudge'].includes(r.command)) this.applyChatThread(r, instance, result)
    const spent = result.ok ? this.countTokens(r, result) : null
    if (persist) this.store.save()
    return spent
  }
  /** Takes a reading's usage as the row's, and tells the watchers, after noting any plan change. */
  private applyUsage(instance: FreeInstance, usage: NonNullable<FreeResult['usage']>): void {
    // A row read before plans were kept (2026-10-09) has its plan only in its last reading. Start from that, or
    // every account already on Go or Pro would be told as newly paid on its first reading after the update.
    if (instance.plan === undefined) instance.plan = instance.usage?.plan ?? null
    instance.usage = usage
    this.notePlan(instance, usage.plan ?? null)
    try { this.onUsage?.(instance) } catch { /* a watcher's failure never fails a reading */ }
  }
  /** Keeps each temporary chat of a listing as a thread, unless it was forgotten. */
  private applyChats(r: FreeRequest, chats: NonNullable<FreeResult['chats']>): void {
    // Looked up by id, not searched per chat: an account's list of ~1,500 chats against ~22,000 threads held the
    // server 2 to 6 s a list, every list read (2026-10-10, loop-stalls.jsonl: 220 s in a day).
    const known = new Map(this.store.data.threads.map(t => [t.id, t]))
    const forgotten = new Set(this.store.data.forgotten)
    for (const chat of chats) {
      const id = `${r.instanceId}/${chat.chat_id}`
      if (chat.is_temporary === true && !forgotten.has(id)) {
        const existing = known.get(id)
        this.noteThread(r, existing?.status ?? 'done', chat.chat_id, existing?.error ?? null, chat.server_conversation_id, existing?.title || chat.name || undefined, Date.parse(chat.created_at ?? '') || undefined, false, known)
      }
    }
  }
  /** Records a chat-type command's outcome on its thread, and marks the account signed in when the chat is private. */
  private applyChatThread(r: FreeRequest, instance: FreeInstance, result: FreeResult): void {
    if (result.ok && result.is_temporary) { instance.loggedIn = true; instance.checkedAt = instance.lastSignedInAt = Date.now() }
    const chatId = result.chat_id ?? result.error?.chat_id ?? r.chatId
    const existing = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chatId)
    if (result.ok) result.chat_name = r.name || existing?.title || result.chat_name
    this.noteThread(r, result.ok ? 'done' : 'failed', chatId, result.error?.message ?? null, result.server_conversation_id, r.name || existing?.title || result.chat_name || undefined)
  }
  /** A message adds to the account's token estimate (tokens.ts): what it sent, the thread it continues included, and
   *  the reply. A chat that was read gives its thread's length, so a later continuation counts what it holds. */
  private countTokens(r: FreeRequest, result: FreeResult): TokenEntry | null {
    const chatId = result.chat_id ?? r.chatId
    const thread = this.store.data.threads.find(t => t.instanceId === r.instanceId && t.chatId === chatId)
    if (r.command === 'read' && thread && result.messages) thread.contextChars = result.messages.reduce((n, m) => n + (m.text?.length ?? 0), 0)
    if (r.command !== 'chat' && r.command !== 'resume') return null
    const context = r.command === 'resume' ? thread?.contextChars ?? 0 : 0
    const sent = r.prompt?.length ?? 0
    const reply = result.response?.length ?? 0
    const ledgers = (this.store.data.tokens ??= {})
    const entry: TokenEntry = { at: Date.now(), input: estimateTokens(context + sent), output: estimateTokens(reply) }
    ledgers[r.instanceId] = addTokens(ledgers[r.instanceId], entry)
    if (thread) thread.contextChars = context + sent + reply
    return entry
  }
  /** Resolves once everything saved so far is on disk (tests). */
  settled(): Promise<void> { return this.store.settled() }
  /** Aborts the running jobs, waits for their last saves (STOP_WAIT_MS at most), then writes what is still queued and
   *  waits out a write already in flight, so nothing touches the folder after the service stopped. */
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.keeper); clearInterval(this.keeper); clearTimeout(this.refresher); clearInterval(this.refresher)
    for (const controller of this.controllers.values()) controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(this.runs.values()), new Promise(resolve => { timer = setTimeout(resolve, STOP_WAIT_MS) })])
    clearTimeout(timer)
    this.store.flushSync()
    await this.store.quiet()
  }
}
