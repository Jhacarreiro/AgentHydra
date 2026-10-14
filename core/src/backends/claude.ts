// Not built yet: the core rebuild's claude backend (core/README.md). Replaced by its builder.
import type { Backend } from '../types'

export function claudeBackend(): Backend {
  throw new Error('the claude backend is not built yet')
}
