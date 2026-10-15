/**
 * manager-refresh - the Sue Manager moves itself onto the checkout's new code, without stopping a run.
 * ================================================================================================
 *
 * The Manager stays this checkout's manager.mjs (the Chair, 2026-09-25: source only), and the checkout's
 * code changes every few minutes while about twenty chats land into it. A Manager keeps the code it
 * loaded, so it goes stale: 2026-09-22 (ARGUS) one answered 884 requests with HTTP 500 off a persona
 * loader the disk had moved past, until somebody restarted it. Waves no longer hold it in place: each
 * runs to its end on its own snapshot (lib/engine-store.mjs), and a stop or a word to its room is
 * carried out by that snapshot (sue.mjs routeLiveRun), so a Manager can be replaced under a running
 * wave. The only things a wave asks of the Manager are a file or an idea it serves (/material/<id>) and
 * a human host's words to a focus group, and both come back as soon as the new one listens.
 *
 * So about once a minute the Manager asks what the checkout's code is now (currentEngineId: files are
 * only read again when a size or a modification time moved), plus the landed SUE number once that has
 * moved (lib/version-skew.mjs). When it differs from the code the Manager booted on, and has held still
 * for one more look (a change lands over several files and minutes), and nothing only this process
 * carries is in flight (a sign-in window it is waiting on, a live wave its Sues are reading a file or an
 * idea from), it hands its port to a fresh Manager started from the checkout (version-skew.mjs
 * handOver: close, start, wait up to 15 s for an answer) and exits. A successor that never answers
 * leaves this one listening again, and the same code is not tried twice: a broken change cannot make
 * the Manager loop, and the page is never left with no Manager at all.
 *
 * DEPENDED ON BY: manager.mjs main. Spec: tests/manager-refresh.spec.mjs.
 */
import { sameLandedSue } from "./version-skew.mjs";

/**
 * What the Manager does about the code on disk. `boot` is the code key it started on, `now` the key on
 * disk, `previous` the key the last look saw, `failed` one a hand-over already failed on, `busy` whether
 * something only this process carries is in flight: "stay", "wait" (look again next tick) or "refresh".
 */
export function refreshDecision({ boot, now, previous, failed = null, busy = false }) {
  if (!now || now === boot || now === failed) return "stay";
  if (now !== previous || busy) return "wait";
  return "refresh";
}

/** The code key: the engine id, plus the landed SUE number when git says it moved past the one running. */
export function codeKey(id, running, disk) {
  return id && sameLandedSue(running, disk) === false ? `${id} ${disk.version}` : id;
}

/**
 * Every `everyMs`, ask `currentKey()` and act on `refreshDecision`: `handOver()` resolves "handed-over"
 * or "kept", and `done()` ends this Manager once its successor answers. `busy()` counts what a refresh
 * would cut short. Returns `{ check, stop }`; `check` is what each tick runs, and what it decided.
 */
export function watchCode({ bootKey, currentKey, busy, handOver, done, everyMs = 60_000, log = console }) {
  let previous = bootKey;
  let failed = null;
  let checking = false;
  async function check() {
    if (checking) return "checking";
    checking = true;
    let now = null;
    try {
      now = await currentKey();
      const decision = refreshDecision({ boot: bootKey, now, previous, failed, busy: Boolean(await busy()) });
      previous = now;
      if (decision !== "refresh") return decision;
      log.log(`Sue's code on this disk is now ${now} and this Manager runs ${bootKey}: handing the port to a Manager on the new code.`);
      const outcome = await handOver();
      if (outcome === "handed-over") {
        done();
        return outcome;
      }
      failed = now;
      if (outcome === "supervised") {
        // Another process runs this Manager and restarts it (version-skew.mjs supervisedManager): its hello says it is stale.
        log.log(`Sue's code on this disk is now ${now}; this Manager's supervisor restarts it, so it keeps serving ${bootKey} until then.`);
        return outcome;
      }
      log.error(
        `No Manager on ${now} answered (see state/manager/manager.log); this one keeps serving ${bootKey} until the code changes again.`,
      );
      return outcome;
    } catch (err) {
      failed = now ?? failed;
      log.error(`Moving this Manager onto the new code failed: ${err?.stack ?? err}`);
      return "failed";
    } finally {
      checking = false;
    }
  }
  const timer = setInterval(() => void check(), everyMs);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}
