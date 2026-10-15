// vendored from Connections packages/connections-arkitect/src/core/execution-scope-activation.mjs @ dd3d47a7ad
import { AsyncLocalStorage } from "node:async_hooks";

const activeExecutionScope = new AsyncLocalStorage();
let validateActivation = null;

/**
 * Private runner seam. This module is intentionally absent from package exports:
 * production checks receive a scope through ctx and cannot activate one themselves.
 */
export function installExecutionScopeActivationValidator(validator) {
  if (validateActivation) throw new Error("execution scope activation validator was already installed");
  if (typeof validator !== "function") throw new TypeError("execution scope activation validator must be a function");
  validateActivation = validator;
}

/** @internal - only core/runner.mjs may import this activation authority. */
export function activateExecutionScope(scope, work) {
  if (!validateActivation) throw new Error("execution scope activation validator is not installed");
  validateActivation(scope);
  if (typeof work !== "function") throw new TypeError("execution scope activation requires a function");
  return activeExecutionScope.run(scope, work);
}

export function readActiveExecutionScope() {
  return activeExecutionScope.getStore() ?? null;
}
