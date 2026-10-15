import { hopUrl } from "./hop-trace.mjs";

/**
 * Page-level lines for a Sue's trace.jsonl: console errors, uncaught exceptions, failed or 4xx requests,
 * and the initiator of each main-frame navigation. Query values, bodies and headers never reach a line.
 */

/** Most page-trace lines one Sue writes (her hop lines are not counted). */
export const PAGE_TRACE_CAP = 200;

const TEXT_MAX = 300;

const withoutFragment = (url) => String(url ?? "").replace(/#[\s\S]*$/, "");

/** `url:line` of a CDP call frame (`lineNumber` is 0-based there), or null when Chrome gives none. */
function whereOf(frame) {
  if (!frame?.url) return null;
  return `${hopUrl(frame.url)}:${Number(frame.lineNumber ?? 0) + 1}`;
}

const topFrameOf = (stack) => stack?.callFrames?.[0] ?? null;

const firstLine = (text) => String(text ?? "").split("\n")[0];

const textOf = (args = []) =>
  args
    .map((arg) => arg?.value ?? firstLine(arg?.description) ?? arg?.unserializableValue ?? "")
    .join(" ")
    .slice(0, TEXT_MAX);

/**
 * The watcher. `write(row)` appends a line to her trace; `cdpFor(page)` gives her tab's CDP session;
 * `blockedUrls` holds the full address of each request the harness aborted on purpose.
 * `{ watch(page), finish() }`.
 */
export function createPageTrace({ write, cdpFor, blockedUrls = new Set(), cap = PAGE_TRACE_CAP, log = () => {} }) {
  const tabs = new WeakMap();
  let nextTab = 1;
  let lines = 0;
  let dropped = 0;
  let harnessBlocked = 0;

  function emit(row) {
    if (lines >= cap) {
      dropped += 1;
      return;
    }
    lines += 1;
    write({ at: new Date().toISOString(), ...row });
  }

  async function watch(page) {
    if (!page || tabs.has(page)) return;
    const tab = nextTab++;
    tabs.set(page, tab);
    try {
      const session = await cdpFor(page);
      await session.send("Page.enable");
      const mainFrame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
      const requests = new Map();
      const pendingNav = new Map();

      const remember = (frameId, e) => {
        if (frameId === mainFrame) pendingNav.set(frameId, { ...e, url: withoutFragment(e.url) });
      };
      session.on("Page.frameRequestedNavigation", (e) => remember(e.frameId, { url: e.url, reason: e.reason, disposition: e.disposition }));
      session.on("Page.frameScheduledNavigation", (e) => remember(e.frameId, { url: e.url, reason: e.reason }));

      session.on("Network.requestWillBeSent", (e) => {
        requests.set(e.requestId, { url: e.request.url, type: e.type });
        if (e.type !== "Document" || e.frameId !== mainFrame) return;
        const pending = pendingNav.get(e.frameId);
        pendingNav.delete(e.frameId);
        const nav = pending && pending.url === withoutFragment(e.request.url) ? pending : null;
        const initiator = e.initiator ?? {};
        const where = whereOf(topFrameOf(initiator.stack));
        emit({
          kind: "navigation",
          tab,
          url: hopUrl(e.request.url),
          redirect: Boolean(e.redirectResponse),
          ...(e.redirectResponse ? { status: e.redirectResponse.status } : {}),
          ...(nav ? { reason: nav.reason, ...(nav.disposition ? { disposition: nav.disposition } : {}) } : {}),
          initiator: { type: initiator.type ?? null, ...(where ? { where } : {}) },
        });
      });
      session.on("Network.responseReceived", (e) => {
        const status = e.response?.status;
        if (!(status >= 400)) return;
        emit({ kind: "http", tab, status, resource: e.type, url: hopUrl(e.response.url) });
      });
      session.on("Network.loadingFailed", (e) => {
        const req = requests.get(e.requestId);
        requests.delete(e.requestId);
        if (req && blockedUrls.has(req.url)) {
          harnessBlocked += 1;
          return;
        }
        emit({
          kind: "failed",
          tab,
          resource: e.type,
          url: req ? hopUrl(req.url) : null,
          error: e.errorText,
          ...(e.canceled ? { canceled: true } : {}),
          ...(e.blockedReason ? { blocked: e.blockedReason } : {}),
        });
      });
      session.on("Network.loadingFinished", (e) => requests.delete(e.requestId));
      session.on("Runtime.consoleAPICalled", (e) => {
        if (e.type !== "error" && e.type !== "warning") return;
        emit({ kind: "console", tab, level: e.type, text: textOf(e.args), where: whereOf(topFrameOf(e.stackTrace)) });
      });
      session.on("Runtime.exceptionThrown", (e) => {
        const details = e.exceptionDetails ?? {};
        const text = firstLine(details.exception?.description ?? details.text ?? "").slice(0, TEXT_MAX);
        emit({ kind: "exception", tab, text, where: details.url ? whereOf({ url: details.url, lineNumber: details.lineNumber }) : null });
      });

      await session.send("Runtime.enable");
      await session.send("Network.enable");
    } catch (err) {
      log("the page trace was not attached:", err?.message ?? err);
    }
  }

  /** Writes the closing count line. Called once, when her visit ends. */
  function finish() {
    write({ at: new Date().toISOString(), kind: "page-trace", lines, dropped, harnessBlocked });
  }

  return { watch, finish };
}
