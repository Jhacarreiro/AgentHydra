// Sign in with Connections (@cnct/connect, RFC 8252 loopback, tokens in a 0600 file under ~/.agenthydra). Connections
// only says who the person is and gives the token the people server checks; the people live on LunarWerx's server.
import { join } from 'node:path'
import { createConnect, nodeFileStore } from '@cnct/connect'
import { agentHydraDir } from './this-pc'
import { HomeUnavailable } from './types'

/** AgentHydra's public Connections client id (PKCE, no secret). */
export const CONNECTIONS_APP_ID = '521ca52b222454ad7aaa3aec93429dbd'
export const SCOPES = ['openid', 'profile', 'email', 'photo']
export const SIGNED_OUT = 'Sign in with Connections to use it.'

export interface ConnectionsAccount {
  name: string
  email: string | null
}

/** The parts of @cnct/connect the sign-in uses, so a test can stand in for it. */
export interface ConnectLike {
  isSignedIn(): Promise<boolean>
  getAccessToken(): Promise<string>
  getUser(): Promise<{ name?: string; email?: string }>
  signInLoopback(opts?: { openBrowser?: (url: string) => void | Promise<void> }): Promise<unknown>
  signOut(opts?: { revoke?: boolean }): Promise<void>
}

export interface ConnectionsSignInOptions {
  home?: string
  connect?: ConnectLike
  openBrowser?: (url: string) => void | Promise<void>
}

export interface ConnectionsSignIn {
  signedIn(): Promise<boolean>
  account(): Promise<ConnectionsAccount | null>
  signIn(): Promise<ConnectionsAccount | null>
  signOut(): Promise<void>
  /** A current access token; HomeUnavailable(SIGNED_OUT) when there is no session. */
  token(): Promise<string>
}

export function createConnectionsSignIn(opts: ConnectionsSignInOptions = {}): ConnectionsSignIn {
  let connect = opts.connect
  const client = (): ConnectLike => {
    connect ??= createConnect({
      clientId: CONNECTIONS_APP_ID,
      redirectUri: 'http://127.0.0.1/oauth/callback',
      scopes: SCOPES,
      store: nodeFileStore(join(agentHydraDir(opts.home), 'connections.json')),
    }) as unknown as ConnectLike
    return connect
  }
  const account = async (): Promise<ConnectionsAccount | null> => {
    const c = client()
    if (!(await c.isSignedIn())) return null
    const u = await c.getUser()
    return { name: u.name || u.email || 'Connections account', email: u.email ?? null }
  }
  return {
    signedIn: () => client().isSignedIn(),
    account,
    async signIn() {
      await client().signInLoopback({ openBrowser: opts.openBrowser })
      return account()
    },
    signOut: () => client().signOut(),
    async token() {
      const c = client()
      if (!(await c.isSignedIn())) throw new HomeUnavailable(SIGNED_OUT)
      return c.getAccessToken()
    },
  }
}
