import type { FreeInstance, FreeProvider } from '@shared/free-instances'

export const poolPlan = (i: Pick<FreeInstance, 'plan' | 'usage'>): string | null =>
  (i.plan ?? i.usage?.plan)?.trim().toLowerCase() || null

const identity = (i: FreeInstance): string => i.email?.trim().toLowerCase() || i.id
const isSlotPlan = (i: FreeInstance): boolean => {
  const plan = poolPlan(i)
  // Unknown signed-in legacy accounts occupy space but cannot be displaced.
  return !plan || plan === 'free' || (i.provider === 'chatgpt' && plan === 'go')
}

/** A staged renewal reserves its previous live slot until it commits or aborts. */
function counted(i: FreeInstance): FreeInstance | null {
  const before =
    i.poolState === 'pending' && i.poolAdmission?.state === 'pending'
      ? i.poolAdmission.before
      : undefined
  const row = before ?? i
  return !row.poolState &&
    !(row as FreeInstance & { movedAway?: unknown }).movedAway &&
    row.loggedIn &&
    isSlotPlan(row)
    ? row
    : null
}

export function poolCount(
  rows: readonly FreeInstance[],
  provider: FreeProvider,
  except?: string,
): number {
  return new Set(
    rows.flatMap((i) => {
      const row = i.id !== except && i.provider === provider ? counted(i) : null
      return row ? [identity(row)] : []
    }),
  ).size
}

/** Candidate is verified independently. Only complete idle Free identity groups may be retired. */
export function poolVictims(
  rows: readonly FreeInstance[],
  candidate: FreeInstance,
  plan: 'free' | 'go',
  limit: number,
  busy: (id: string) => boolean,
): FreeInstance[] | null {
  const others = rows.filter((i) => i.id !== candidate.id && i.provider === candidate.provider)
  const same = others.some((i) => {
    const row = counted(i)
    return row && identity(row) === identity(candidate)
  })
  const needsSlot = !same
  const count = poolCount(rows, candidate.provider, candidate.id)
  const groups = new Map<string, FreeInstance[]>()
  for (const i of others) {
    if (i.poolState === 'retired') continue
    const key = identity(i)
    const group = groups.get(key) ?? []
    group.push(i)
    groups.set(key, group)
  }
  const free = [...groups.values()].filter(
    (group) =>
      group.every(
        (i) =>
          !i.poolState &&
          poolPlan(i) === 'free' &&
          !i.poolAdmission?.before &&
          !(i as FreeInstance & { movedAway?: unknown }).movedAway &&
          !busy(i.id),
      ) && identity(group[0]!) !== identity(candidate),
  )
  // A known signed-out Free is safe to archive even when it did not occupy a live slot.
  const dead = free.find((group) =>
    group.every((i) => !i.loggedIn && i.checkedAt != null && !!i.email),
  )
  if (!needsSlot || count < limit) return dead ?? []
  if (limit === 0) return null
  if (plan !== 'go') return null
  const live = free
    .filter((group) => group.some((i) => i.loggedIn))
    .sort(
      (a, b) =>
        Math.max(...a.map((i) => i.lastActiveAt ?? 0)) -
          Math.max(...b.map((i) => i.lastActiveAt ?? 0)) || a[0]!.num - b[0]!.num,
    )
  // Do not bulk shrink a pre-existing oversized Go pool to normalize an old setting.
  return count === limit ? (live[0] ?? null) : null
}
