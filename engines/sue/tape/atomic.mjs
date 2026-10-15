/**
 * tape/atomic.mjs - one file write that a reader never sees half done: the bytes go to a temp file beside it, then a
 * rename puts them in place. Every file of a tape (screens, edges.json, manifest.json, the recorder's own files) is
 * written this way, because Sues read a tape while its one writer saves into it.
 */
import { rmSync, writeFileSync } from "node:fs";

import { renameSyncRetrying } from "../../lib/shared/rename-retrying.mjs";

/** Windows refuses a rename while a reader holds the target for a moment; the shared rename waits that out. */
export function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  try {
    renameSyncRetrying(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
