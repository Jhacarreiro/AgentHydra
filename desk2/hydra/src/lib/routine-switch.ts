// The on/off switch on each routine card of the Tools overview (ToolsOverview.vue; owner, 2026-10-17: "every routine ...
// a very small toggle ... that I can just enable or disable there"). On is not paused: a routine is paused when the owner
// paused it (`paused`) or when its state reads paused, the same test RoutineDetail.vue makes for its Pause button. A flip
// sends the pause or resume request that routines-api.ts's postRoutines takes.
import type { Routine, RoutinesRequest } from '@desk/shared/routines'

export const isRoutinePaused = (x: Pick<Routine, 'paused' | 'state'>): boolean => x.paused || x.state === 'paused'

/** The request that flips a routine's switch: a running (on) routine is paused, a paused (off) one is resumed. */
export const routineSwitchRequest = (x: Pick<Routine, 'id' | 'paused' | 'state'>): RoutinesRequest =>
  isRoutinePaused(x) ? { resume: x.id } : { pause: x.id }
