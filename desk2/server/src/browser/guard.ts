// The own-page rule of plugins/50-devwebui.ts (the /dw/ routes of the dev-servers service): a browser request must
// come from Desk 2's own page. Desk's localOnly guard (index.ts) has already refused other sites and names; this one
// also refuses another local page, such as a dev server on a different port, from driving a signed-in browser.

import { notOwnPage as ownPageRule } from '../own-page'

/** Why a request is not from Desk 2's own page, or null. */
export function notOwnPage(headers: Headers): string | null {
  return ownPageRule(headers, "the browser pane's API")
}
