import type { Contracts } from 'nanocode-ts'
import { StopError } from './stop.ts'

export type Provider = Contracts.ModelProvider

/** How the host signs one provider's model requests. The SDK never sees the secret. */
export type Credential = {
  endpoint: string
  subscription: boolean
  headers(): [string, string][]
}

export type Credentials = Partial<Record<Provider, Credential>>

export class MissingCredentialError extends StopError {
  override name = 'MissingCredentialError'
}

export const defaultEndpoints: Record<Provider, string> = {
  claude: 'https://api.anthropic.com/v1/messages',
  codex: 'https://api.openai.com/v1',
}

/** A provider API key credential. `endpoint` replaces the provider's own, for a gateway. */
export function apiKeyCredential(provider: Provider, key: string | undefined, endpoint = defaultEndpoints[provider]): Credential {
  if (!key) throw new MissingCredentialError(provider === 'claude' ? 'Claude models need ANTHROPIC_API_KEY' : 'Codex models need OPENAI_API_KEY')
  const header: [string, string] = provider === 'claude' ? ['x-api-key', key] : ['authorization', `Bearer ${key}`]
  return { endpoint, subscription: false, headers: () => [header] }
}

/**
 * Sends the SDK's model requests. Credentials go only to their own provider's origin,
 * so a misdirected endpoint never receives a key.
 */
export function dispatcher(credentials: Credentials, fallback: Provider): Contracts.RuntimeOptions['dispatch'] {
  return async (request, signal) => {
    const provider = request.provider ?? fallback
    const credential = credentials[provider]
    if (!credential) throw new MissingCredentialError(`no credential for ${provider}`)
    if (new URL(request.endpoint).origin !== new URL(credential.endpoint).origin)
      throw new Error(`refusing to sign a ${provider} request to ${request.endpoint}`)
    return fetch(request.endpoint, {
      body: request.body as Uint8Array<ArrayBuffer>,
      headers: mergeHeaders(request.headers, credential.headers()),
      method: request.method,
      // The SDK fails a 3xx answer itself. Workers do not implement redirect: 'error'.
      redirect: 'manual',
      signal,
    })
  }
}

function mergeHeaders(base: [string, string][], added: [string, string][]): [string, string][] {
  const merged = base.map(([name, value]): [string, string] => [name, value])
  for (const [name, value] of added) {
    const existing = merged.find(([key]) => key.toLowerCase() === name)
    if (existing && name === 'anthropic-beta') existing[1] = `${existing[1]},${value}`
    else if (existing) existing[1] = value
    else merged.push([name, value])
  }
  return merged
}
