// The CrAInium people add-on: whether this PC has people at all. Without it every people feature is absent (no first
// run, no Settings section, no manager tools, timers or router hook). The test is the door itself (findDoor), so
// there is one resolver for it.
import { findDoor } from './people-store/crainium-home'

export type AddonOpts = Parameters<typeof findDoor>[0]

export function peopleAddonPresent(opts: AddonOpts = {}): boolean {
  return findDoor(opts) !== null
}
