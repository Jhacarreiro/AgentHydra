// Not built yet: the core rebuild's chatgpt backend (core/README.md). Replaced by its builder.
import type { Backend } from '../types'

export function chatgptBackend(): Backend {
  throw new Error('the chatgpt backend is not built yet')
}
