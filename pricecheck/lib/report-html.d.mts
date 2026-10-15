import type { Scan } from './model.mjs'
import type { Progress } from './history.mjs'

export function renderReport(args: { scan: Scan; progress?: Progress | null; now?: Date }): string
