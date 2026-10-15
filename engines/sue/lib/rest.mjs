/**
 * rest - her tab stops painting while her brain thinks, and paints again before her next move.
 * ============================================================================================
 *
 * WHY THIS EXISTS: a Sue spends most of her visit waiting on her brain, and a live page does not
 * wait with her. Measured 2026-09-24 on the owner's 20-core box, 10 Sues idle on a local page with a
 * spinner, a pulsing banner, a 100 ms clock and a 1 s poll (headless, one shared browser, 30 s):
 * 1.48-1.91 cores doing nothing anybody would ever see - ~15% of a core per Sue, and a wave is
 * mostly Sues thinking. the owner approved "slow, not frozen" that day: freezing the page
 * (Page.setWebLifecycleState frozen) had cost 3-9 failed moves per 50-Sue run, so it is not used.
 * With this in place, REAL bodies (scratchpad sue-scale/bodies2.mjs, 10 Sues, 30 s idle): that page
 * went from 1.84 to 0.17 cores, a spinner-and-requestAnimationFrame page from 0.56 to 0.14.
 *
 * What was measured, same page, same 10 Sues, same 30 s:
 *   - Emulation.setCPUThrottlingRate 4x / 20x / 50x: 10.7 / 10.9 / 10.5 cores. Chrome's throttler
 *     suspends and resumes the renderer thread from a thread of its own, and on Windows that costs
 *     far more than it saves. Never use it for this.
 *   - Animation.setPlaybackRate 0.05: 1.55 cores (a slow animation still paints every frame);
 *     0 paused them: 0.41 cores, but a paused clock changes what she sees next (a toast that should
 *     have faded is still up), so it is not used either.
 *   - Her window minimized (Browser.setWindowBounds): 0.07 cores. Nothing is frozen: her scripts,
 *     timers and requests run as before and the page still says it is visible (Playwright's own
 *     launch flags keep Chrome from backgrounding it); only painting stops. Restoring it puts the
 *     next frame back before anything reads the screen, so her next look is the page as it is.
 *
 * HEADLESS ONLY. A headed window restored from minimized takes the foreground: measured the same
 * day, the desktop's focus moved from the owner's own Chrome to the Sue browser on every restore. A
 * headed Sue is never rested, exactly as before.
 *
 * `settle()` after she is answered (the window goes down `afterMs` later, so a brain that answers at
 * once never pays for it); `wake()` first thing in every move, awaited, so no move ever runs on a
 * resting tab. Best-effort throughout: a window that cannot be minimized just keeps painting.
 *
 * DEPENDED ON BY: body.mjs (`wrap`). Spec: tests/rest.spec.mjs.
 */

/**
 * How long after her answer her tab keeps painting, in case her brain moves again at once. Putting a
 * window down and bringing it back is not free: measured the same day, 10 Sues moving every 2.5-4 s
 * (a faster brain than any real one) spent ~40 ms more CPU per rest than they saved, while a resting
 * tab saves 40-170 ms a second (the two pages above). So a short pause never rests, and one that
 * does rests long enough to pay for itself.
 */
export const REST_AFTER_MS = 3_000;

/**
 * `pages()` lists her open tabs now (her context can be swapped for a fresh one, so it is asked each
 * time); `sessionFor(page)` gives a CDP session on that tab. `enabled` false makes both calls no-ops.
 */
export function createRest({
  enabled,
  pages,
  sessionFor,
  afterMs = REST_AFTER_MS,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  /** The windows put down, as `{ session, windowId }`, or the promise of them while that is in flight. */
  let down = null;
  /** Moves still running. The CLI tier's HTTP path runs parallel tool calls side by side, so one move
   *  settling must not start the pause while another is still on her page. */
  let busy = 0;

  async function lieDown() {
    const seen = new Map();
    for (const page of pages()) {
      try {
        const session = await sessionFor(page);
        const { windowId } = await session.send("Browser.getWindowForTarget");
        if (!seen.has(windowId)) seen.set(windowId, session);
      } catch {
        /* a tab closing as she rests has no window to put down */
      }
    }
    const done = [];
    for (const [windowId, session] of seen) {
      try {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
        done.push({ session, windowId });
      } catch (err) {
        log("rest: her window would not go down:", err?.message ?? err);
      }
    }
    return done;
  }

  return {
    settle() {
      if (!enabled) return;
      busy = Math.max(0, busy - 1);
      if (busy > 0) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        down = lieDown();
      }, afterMs);
      timer?.unref?.();
    },
    async wake() {
      if (enabled) busy += 1;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      if (!down) return;
      const windows = await down;
      down = null;
      for (const { session, windowId } of windows)
        await session
          .send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } })
          .catch((err) => log("rest: her window did not come back up:", err?.message ?? err)); // a tab that closed while she rested has nothing to restore
    },
    /** Her visit is over: nothing is put down after this. */
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
