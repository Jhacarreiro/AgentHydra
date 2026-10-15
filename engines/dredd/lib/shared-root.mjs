// dredd/lib/shared-root.mjs - where the fleet's shared checkouts (Odin) live, found once.
//
// Dredd used to assume its own checkout sits BESIDE them (engine root + "/.." + "zswarm"). That holds when
// Connections is cloned into the shared folder itself and fails everywhere else: on the owner's PC the repo is on
// the Desktop and the zswarm is at D:/NEWProjects/shared/zswarm, so every Boardroom turn died "zswarm checkout
// not found" before a model was asked (2026-09-22). One resolver, three places it looks, in order: the
// override, the sibling of this checkout, then the fleet's shared folder the bench's runner paths already name.
// Its Python half (lib/shared_root.py) went with the zswarm checkout: HSwarm is an installed package (2026-10-03).
import { existsSync } from "node:fs";
import path from "node:path";

/** The fleet's shared folder, spelled the way bench.json's runner paths spell it. */
export const FLEET_SHARED_ROOT = "D:/NEWProjects/shared";

/** Where the shared checkout `name` lives: `override` when set; else the first of this checkout's sibling and the
 *  fleet folder that exists; else the sibling, so a "not found" names the place it looked first. */
export function sharedCheckout(name, { engineRoot, override, fleetRoot = FLEET_SHARED_ROOT } = {}) {
  if (override) return override;
  const sibling = path.join(path.resolve(engineRoot, ".."), name);
  return [sibling, path.join(fleetRoot, name)].find((p) => existsSync(p)) ?? sibling;
}

/** A runner path the bench writes under the fleet folder, moved beside this checkout only when that CHECKOUT (the
 *  path's first folder) lives there - so a missing runner file is reported inside the checkout that is really here. */
export function localSharedPath(file, { engineRoot, fleetRoot = FLEET_SHARED_ROOT }) {
  const prefix = `${fleetRoot.replace(/\\/g, "/")}/`;
  const norm = String(file).replace(/\\/g, "/");
  if (!norm.startsWith(prefix)) return file;
  const rel = norm.slice(prefix.length);
  const parent = path.resolve(engineRoot, "..");
  return existsSync(path.join(parent, rel.split("/")[0])) ? path.join(parent, rel).replace(/\\/g, "/") : norm;
}
