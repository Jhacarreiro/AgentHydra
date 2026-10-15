// vendored from Connections packages/connections-arkitect/src/core/scan-observer-slot.mjs @ dd3d47a7ad
// Shared factory behind every scan module's per-module observer slot (fs-walk.mjs,
// portable-files.mjs, scan-directory.mjs, source-catalog.mjs each used to retype this
// verbatim: a single-install callback that defaults to a no-op returning `false`, throws on
// a second install, and validates the observer is a function before accepting it).
//
// Each caller keeps its own top-level `observeScanEvidence` wrapper function delegating to
// `slot.observe`, so every existing internal call site (`observeScanEvidence({...})`) is
// completely unchanged - only the install/validate/store boilerplate that used to be
// retyped per file, four times, is shared. `label` reproduces that module's own error text
// verbatim ("fs walk scan observer is already installed", etc.) so a thrown error still
// names which seam double-installed.
export function createScanObserverSlot(label) {
  let observe = () => false;
  let installed = false;
  return {
    install(observer) {
      if (installed) throw new Error(`${label} scan observer is already installed`);
      if (typeof observer !== "function") throw new TypeError(`${label} scan observer must be a function`);
      observe = observer;
      installed = true;
    },
    observe(...args) {
      return observe(...args);
    },
  };
}
