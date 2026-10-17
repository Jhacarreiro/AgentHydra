import { Hono } from 'hono'

/**
 * The shared Hono app instance, split out of index.ts so the route groups under
 * server/src/routes/*.ts can register their handlers as top-level module statements — matching
 * how every route in this daemon has always been registered — and be pulled into the running app
 * by index.ts in the exact original order via `await import('./routes/...')` at the right point
 * in its boot sequence.
 *
 * This split exists ONLY to keep each route's cognitive/cyclomatic complexity independently
 * measurable: wrapping a route group in a `registerXRoutes(app)` function would nest every one of
 * its handlers inside that single function's body, and Architect's cognitive/cyclomatic-complexity
 * checks fold nested closures into the complexity of their lexically enclosing named function — so
 * a wrapper would misattribute the summed complexity of a dozen unrelated handlers to itself. A
 * bare top-level `app.get(...)` statement (here or in a routes/*.ts module) has no such enclosing
 * function, so each handler is measured on its own, exactly as it was before this file existed.
 *
 * Route order is load order: Hono runs handlers in the order they were registered, so a route
 * registered before index.ts mounts its /api/* guard answers a foreign Origin or Host unchecked.
 * Only index.ts loads a routes/*.ts module (its `await import` block, after the guard). No other
 * module may import one, not even for a helper: move the helper to a plain module instead, as
 * hswarmAccountId moved to hswarm.ts. server/tests/api-guard-order.test.ts enforces this.
 */
export const app = new Hono()
