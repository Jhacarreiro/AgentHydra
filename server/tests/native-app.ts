// A stand-in of Claude Desktop's main process for the native program: its module cache holds one session manager with one
// chat (`local_a`, CLI id CLI), so a test runs the shipped expression and checks what it would call in the app.
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'
import { type NativeProgramRequest, nativeProgram } from '../src/core/claude-native/native-program'

export const CLI = '0b6f2b0e-1111-4c4c-9a9a-123456789abc'
const PID = 4242
const appPath = path.resolve('/example-app/resources/app')
export const PROFILE_DIR = path.resolve('/Users/me/.claude-instances/example')

/** The app with one chat holding `session`; `methods` are the manager's own calls a test watches (interruptSession,
 *  setModel ...), each free to change `chat` as the app would. */
export function nativeApp(session: Record<string, unknown>, methods: Record<string, unknown>) {
  const chat: Record<string, any> = {
    sessionId: 'local_a',
    cliSessionId: CLI,
    isArchived: false,
    isRunning: true,
    ...session,
  }
  const manager = {
    sessions: new Map([['local_a', chat]]),
    currentAccountId: 'acct',
    currentOrgId: 'org',
    userDataPath: PROFILE_DIR,
    waitForInitialization: async () => {},
    getSessionList: async () => [],
    archiveSession: async () => {},
    archiveCascadeClosureOf: () => [],
    losableWorkKind: () => null,
    startingSessionIds: new Set<string>(),
    hasPendingUserInput: () => false,
    localLineageIds: () => [],
    ...methods,
  }
  const file = path.join(appPath, 'index.chunk-example.js')
  const appRequire = Object.assign(
    (name: string) => (name === 'node:fs' ? { readFileSync: () => 'bundle' } : crypto),
    { cache: { [file]: { loaded: true, exports: { claudeCodeSessionManager: manager } } } },
  )
  const app = {
    getAppPath: () => appPath,
    isReady: () => true,
    getPath: () => PROFILE_DIR,
    getVersion: () => '1.0.0',
  }
  const rootRequire = (name: string) =>
    name === 'electron'
      ? { app }
      : name === 'node:path'
        ? path
        : { createRequire: () => appRequire }
  const fakeProcess = { pid: PID, platform: process.platform, mainModule: { require: rootRequire } }
  /** Runs the shipped expression for `request` (this app's pid, profile and chat unless it names others). */
  const run = (
    request: Omit<NativeProgramRequest, 'pid' | 'profileDir'> & { profileDir?: string },
  ) =>
    runInNewContext(
      nativeProgram({ profileDir: PROFILE_DIR, cliSessionId: CLI, ...request, pid: PID }),
      { process: fakeProcess, setTimeout, clearTimeout },
    ) as Promise<any>
  return { chat, run }
}
