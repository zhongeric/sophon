import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apiKeyCredential, defaultEndpoints, MissingCredentialError, type Credential, type Provider } from '../core/providers.ts'

const claudeOauthBeta = 'oauth-2025-04-20'
const planRefreshMarginMs = 60_000

export type CredentialOptions = {
  claudePlan?: boolean
  env?: NodeJS.ProcessEnv
}

export function credential(provider: Provider, options: CredentialOptions = {}): Credential {
  const env = options.env ?? process.env
  if (provider === 'codex') return apiKeyCredential('codex', env.OPENAI_API_KEY)
  if (!options.claudePlan) {
    if (!env.ANTHROPIC_API_KEY) throw new MissingCredentialError('Claude models need ANTHROPIC_API_KEY, or --claude-plan with an nc login')
    return apiKeyCredential('claude', env.ANTHROPIC_API_KEY)
  }
  const home = env.NANOCODE_HOME ?? join(homedir(), '.nanocode')
  planToken(home)
  return {
    endpoint: defaultEndpoints.claude,
    subscription: true,
    headers: () => [
      ['authorization', `Bearer ${planToken(home)}`],
      ['anthropic-beta', claudeOauthBeta],
    ],
  }
}

/**
 * Reads the access token of the Claude plan that `nc` signed in. The host never refreshes it:
 * a refresh rotates the token, and `nc` would lose its login.
 */
function planToken(home: string): string {
  type Stored = { claude?: { payload?: string } }
  type Envelope = { state?: { kind?: string; token?: { access?: string; expires_at?: number } } }
  let stored: Stored
  try {
    stored = JSON.parse(readFileSync(join(home, 'claude.json'), 'utf8')) as Stored
  } catch {
    throw new MissingCredentialError(`no Claude login in ${home}; run nc and /login claude`)
  }
  const envelope = JSON.parse(stored.claude?.payload ?? '{}') as Envelope
  const token = envelope.state?.kind === 'Ready' ? envelope.state.token : undefined
  if (!token?.access || !token.expires_at) throw new MissingCredentialError('the nc Claude login is not ready; run nc and /login claude')
  if (token.expires_at < Date.now() + planRefreshMarginMs)
    throw new MissingCredentialError('the nc Claude login expired; run nc once so that it refreshes the login')
  return token.access
}
