export interface Ctx {
  req: Request
  sub: string
  params: string[]
  url: URL
  requestId: string
  /** Parsed JSON body (only for routes that declare `body: true`). */
  body: unknown
}

export interface Route {
  method: string
  pattern: RegExp
  /** Counts against the per-sub write budget instead of the read budget. */
  write?: boolean
  body?: boolean
  handler: (c: Ctx) => Promise<Response> | Response
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint = '',
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const errorBody = (status: number, error: string, hint = '', extra = {}): Response =>
  json(status, { error, hint, ...extra })

export function match(routes: Route[], method: string, path: string) {
  let pathSeen = false
  for (const r of routes) {
    const m = r.pattern.exec(path)
    if (!m) continue
    pathSeen = true
    if (r.method === method) return { route: r, params: m.slice(1).map(decodeURIComponent) }
  }
  return { route: null, params: [], methodNotAllowed: pathSeen }
}
