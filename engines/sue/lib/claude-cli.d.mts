export interface BrainResult {
  code: number | null;
  result: { is_error?: boolean; result?: unknown } | null;
  stderr: string;
  timedOut: boolean;
}

export function assertNotHaiku(model: string): string;
export function sealedEnv(base?: Record<string, string | undefined>): Record<string, string | undefined>;
export function resolveClaudeBin(env?: Record<string, string | undefined>): string;
export function spawnBrain(options: {
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdoutFile?: string;
  onEvent?: (event: unknown) => void;
  bin?: string;
  timeoutMs?: number;
}): { child: unknown; done: Promise<BrainResult> };
export function killBrainTree(child: unknown): void;
