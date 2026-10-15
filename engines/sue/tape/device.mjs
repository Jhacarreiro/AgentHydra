/**
 * tape/device.mjs - one headless screen of the tape: the browser context a device gets, the virtual-clock settle,
 * the capture, and the hand that moves from one screen to the next.
 *
 * WHY IT EXISTS: the recorder (tape/record.mjs) must read every screen exactly as SUE's live body reads it, or a
 * student walking the tape sees a different page from the one a live Sue would. So everything a page can observe
 * comes from body.mjs itself (its context options, its print and phone init scripts, the Sue marker) and the
 * inventory is body.mjs's own `runInventory` call on lib/perception.mjs's INVENTORY_SCRIPT, imported, never copied.
 * What differs is only WHEN the page is read: the live body waits in real time; the tape runs the page on Chrome's
 * virtual clock (CDP `Emulation.setVirtualTimePolicy`), so every timer, transition and animation the page started
 * has run to its end before the read, in a fraction of the wall time, and never half-way on a busy box.
 *
 * DEPENDS ON: sue/body.mjs (contextOptions, viewportFor, quietPrint, PRINT_DOOR, dressAsPhone),
 * lib/sue-marker.mjs, lib/perception.mjs. Its callers: tape/record.mjs and tape/selftest.mjs.
 */
import { contextOptions, dressAsPhone, PRINT_DOOR, quietPrint } from "../body.mjs";
import { INVENTORY_SCRIPT } from "../lib/perception.mjs";
import { installSueMarker } from "../lib/sue-marker.mjs";

/** The three screens a tape is recorded at. `as` is the body's own device (phone or desktop); a Chromebook is a desktop at its own size. */
export const TAPE_DEVICES = {
  phone: { as: "phone", target: {} },
  chromebook: { as: "desktop", target: { viewport: { width: 1366, height: 768 } } },
  desktop: { as: "desktop", target: {} },
};

/** Virtual milliseconds a screen is given to finish what it started (timers, fades, slide-ins) before it is read. */
export const SETTLE_BUDGET_MS = 2500;
/** Extra budgets granted to a page still animating after the first; a page still moving after them is marked mid-animation. */
const EXTRA_BUDGETS = 3;
/** Real milliseconds one budget may take: a fetch that never ends holds virtual time still, so the wall clock ends it. */
const BUDGET_REAL_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 8_000;

export function deviceSpec(name) {
  const spec = TAPE_DEVICES[name];
  if (!spec) throw new Error(`unknown device "${name}" (one of: ${Object.keys(TAPE_DEVICES).join(", ")})`);
  return spec;
}

/** What a device's context is, for the manifest: its viewport, touch, pixel ratio and user agent. */
export function deviceFacts(name) {
  const { as, target } = deviceSpec(name);
  const options = contextOptions(as, target);
  return {
    as,
    viewport: options.viewport,
    isMobile: Boolean(options.isMobile),
    hasTouch: Boolean(options.hasTouch),
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  };
}

/**
 * A fresh context for one walk from the start: the body's own context options and init scripts for this device,
 * then the config's (its init script, its stubbed routes).
 */
export async function openDevicePage(browser, deviceName, config = {}) {
  const { as, target } = deviceSpec(deviceName);
  const context = await browser.newContext({
    ...contextOptions(as, target),
    ...(config.timezoneId ? { timezoneId: config.timezoneId } : {}),
  });
  await installSueMarker(context, { run: "tape", id: `tape-${deviceName}` });
  await context.addInitScript(quietPrint, PRINT_DOOR);
  if (as === "phone") await dressAsPhone(context);
  if (config.initScript) await context.addInitScript(config.initScript);
  for (const stub of config.routes ?? [])
    await context.route(stub.url, (route) => (typeof stub.handle === "function" ? stub.handle(route) : route.fulfill(stub.fulfill)));
  if (typeof config.prepareContext === "function") await config.prepareContext(context, { device: deviceName });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return {
    context,
    page,
    cdp,
    device: deviceName,
    as,
    close: () => context.close().catch(() => {}), // a context the browser already dropped is closed
  };
}

/** One virtual-time budget; resolves true when it ran out in virtual time, false when the wall clock ended it. */
function runBudget(cdp, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cdp.off("Emulation.virtualTimeBudgetExpired", expired);
      resolve(value);
    };
    const expired = () => finish(true);
    const timer = setTimeout(() => finish(false), BUDGET_REAL_TIMEOUT_MS);
    cdp.on("Emulation.virtualTimeBudgetExpired", expired);
    cdp.send("Emulation.setVirtualTimePolicy", { policy: "pauseIfNetworkFetchesPending", budget: ms }).catch(() => finish(false));
  });
}

/** Before a move or a navigation the clock runs normally, so the page loads and takes the touch as it would for her. */
export async function releaseClock(cdp) {
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => {}); // a page mid-teardown has no clock to free
}

/** Finite animations still running (a looping spinner never ends and is not waited on, exactly as the body's look). */
const MOVING = () =>
  document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming?.().endTime)).length;

/** Two real frames on the normal clock (rAF does not fire while virtual time is paused). */
const TWO_FRAMES = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/**
 * Two real frames, so the page's frame-bound state catches up with its clock: an animation that has not had its
 * first frame has no start time and never advances on the virtual clock (the start screen read mid-slide at
 * desktop size), and a phone's layout viewport is only resized on a frame (a slide-in that overflowed the
 * screen left `innerWidth` wide after it ended).
 */
async function frames(screen) {
  await releaseClock(screen.cdp);
  await screen.page.evaluate(TWO_FRAMES).catch(() => {}); // a page navigating away has no frames to wait for; the next load is waited on
}

/**
 * Settle the screen on the virtual clock: let it load and paint, give it `budgetMs` virtual milliseconds (network
 * fetches pause the clock, so a reply is never outrun), let two real frames land, and grant up to three more
 * budgets while a finite animation is still running. Returns what the settle saw; `midAnimation` is true only when
 * the page was still moving after them.
 */
export async function settle(screen, { budgetMs = SETTLE_BUDGET_MS } = {}) {
  const { page } = screen;
  await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {}); // a page that never fires load is still read as it stands
  await frames(screen);
  let virtualMs = 0;
  let timedOut = false;
  let moving = 0;
  for (let i = 0; i <= EXTRA_BUDGETS; i++) {
    const ran = await runBudget(screen.cdp, budgetMs);
    virtualMs += budgetMs;
    if (!ran) timedOut = true;
    await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {}); // a navigation the budget let start finishes loading
    await frames(screen);
    moving = await page.evaluate(MOVING).catch(() => 0);
    if (!moving) break;
  }
  return { virtualMs, timedOut, stillMoving: moving, midAnimation: moving > 0 };
}

/** The inventory, read exactly as the body's `runInventory` reads it. */
export async function inventoryOf(page) {
  let inventory = await page.evaluate(INVENTORY_SCRIPT).catch(() => null);
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.blocks)) {
    inventory = await page.evaluate(`(${INVENTORY_SCRIPT})()`);
  }
  return inventory;
}

/** The screen as she would see it: the viewport only, at CSS pixels, never a full-page stitch. */
export function screenshotOf(page) {
  return page.screenshot({ scale: "css", timeout: 15_000 });
}

/** `[data-sue-id="..."]`: how the body finds an element the inventory named. */
export function sueLocator(page, sueId) {
  return page.locator(`[data-sue-id="${String(sueId).replace(/"/g, '\\"')}"]`).first();
}

/**
 * One move from a screen: fill its fields as the step says, then the control itself (a tap, a click, or a choice
 * in a list). Before each part the inventory is read again, as the body's hands read it before they act, so
 * the stamps it leaves on the page are the ones a live Sue's would leave. Resolves to the tab the move left her
 * on: a link that opened a new tab hands her that tab, as the body does.
 */
export async function act(screen, step) {
  const { page, as } = screen;
  await releaseClock(screen.cdp);
  for (const fill of step.typed ?? []) {
    await inventoryOf(page);
    const box = sueLocator(page, fill.sueId);
    if (fill.check) await box.check({ timeout: ACTION_TIMEOUT_MS });
    else if (fill.role === "select") await box.selectOption({ label: String(fill.value) }, { timeout: ACTION_TIMEOUT_MS });
    else await box.fill(String(fill.value), { timeout: ACTION_TIMEOUT_MS });
  }
  await inventoryOf(page);
  const target = sueLocator(page, step.sueId);
  let tab = null;
  const onTab = (opened) => (tab = opened);
  page.context().on("page", onTab);
  try {
    await moveOn(page, as, target, step);
    await new Promise((resolve) => setTimeout(resolve, 50)); // a tab a click opens is announced just after the click returns
  } finally {
    page.context().off("page", onTab);
  }
  if (tab) {
    screen.page = tab;
    screen.cdp = await page.context().newCDPSession(tab);
    await tab.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {}); // settle() waits for load
  }
  return screen;
}

async function moveOn(page, as, target, step) {
  if (step.kind === "choose") {
    await target.selectOption({ label: step.option }, { timeout: ACTION_TIMEOUT_MS });
  } else if (as === "phone") {
    await target.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    const box = await target.boundingBox({ timeout: ACTION_TIMEOUT_MS });
    if (!box) throw new Error("it is not on the screen");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await target.click({ timeout: ACTION_TIMEOUT_MS });
  }
}

/** Open the start of the walk: the start URL (a screen is only ever reached by replaying its steps from there). */
export async function arrive(screen, url) {
  await releaseClock(screen.cdp);
  await screen.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
}
