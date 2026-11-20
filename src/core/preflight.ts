import { MissingCredentialError, type Credential, type Provider } from './providers.ts'
import type { ModelChoice } from './roles.ts'

/** One failed prerequisite of a run and its fix, for the comment and the state note (D17). */
export type FailedCheck = { check: string; problem: string; fix: string }

export type ProbeOptions = { fetch?: typeof fetch; timeoutMs?: number }

/**
 * The output limit of each provider probe (D17). The Responses API refuses a limit below 16,
 * so 16 is its smallest accepted request.
 */
export const probeOutputTokens: Record<Provider, number> = { claude: 1, codex: 16 }

const keyNames: Record<Provider, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' }

export function failedChecksText(failed: FailedCheck[]): string {
  return failed.map(({ check, problem, fix }) => `- **${check}**: ${problem}. Fix: ${fix}`).join('\n')
}

/**
 * Sends one small model request (D17). A refusal is a failed check. A network error, a timeout,
 * a 408, a 429 without a quota cause and a 5xx are transient.
 */
export async function probeProvider(
  provider: Provider,
  credential: Credential,
  model: string,
  options: ProbeOptions = {},
): Promise<{ failed: FailedCheck | null; transient: string | null }> {
  const send = options.fetch ?? fetch
  const claude = provider === 'claude'
  const url = claude ? credential.endpoint : `${credential.endpoint}/responses`
  const body = claude
    ? { model, max_tokens: probeOutputTokens.claude, messages: [{ role: 'user', content: 'ping' }] }
    : { model, input: 'ping', max_output_tokens: probeOutputTokens.codex }
  const headers: [string, string][] = [...credential.headers(), ['content-type', 'application/json']]
  if (claude) headers.push(['anthropic-version', '2023-06-01'])
  let status: number
  let text: string
  try {
    const response = await send(url, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
    status = response.status
    if (status >= 200 && status < 300) {
      await response.body?.cancel()
      return { failed: null, transient: null }
    }
    text = await response.text()
  } catch (error) {
    return { failed: null, transient: `the ${provider} probe of ${model} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  const failed = (problem: string) => ({
    failed: { check: checkName(provider), problem, fix: `check ${keyNames[provider]} and the credit or quota of its account` },
    transient: null,
  })
  if (status === 401 || status === 403) return failed(`${provider} refused the key (HTTP ${status})`)
  if ((status === 400 || status === 429) && /quota|credit|billing/i.test(text))
    return failed(`the ${provider} account has no credit or quota (HTTP ${status}: ${excerpt})`)
  if (status === 408 || status === 429 || status >= 500)
    return { failed: null, transient: `the ${provider} probe of ${model} got HTTP ${status}: ${excerpt}` }
  return failed(`the ${provider} probe of ${model} got HTTP ${status} (${excerpt})`)
}

/** Probes each provider of `models` at the same time, with its first model (D17). A missing key gets no request. */
export async function checkProviders(
  models: ModelChoice[],
  credential: (provider: Provider) => Credential,
  options: ProbeOptions = {},
): Promise<{ failed: FailedCheck[]; transient: string[] }> {
  const first = new Map<Provider, string>()
  for (const choice of models) if (!first.has(choice.provider)) first.set(choice.provider, choice.model)
  const results = await Promise.all(
    [...first].map(async ([provider, model]) => {
      let signer: Credential
      try {
        signer = credential(provider)
      } catch (error) {
        if (!(error instanceof MissingCredentialError)) throw error
        const key = keyNames[provider]
        return { failed: { check: checkName(provider), problem: `${key} is not set`, fix: `set ${key} as a Worker secret` }, transient: null }
      }
      return probeProvider(provider, signer, model, options)
    }),
  )
  return {
    failed: results.flatMap(({ failed }) => (failed ? [failed] : [])),
    transient: results.flatMap(({ transient }) => (transient ? [transient] : [])),
  }
}

function checkName(provider: Provider): string {
  return `Provider key (${provider})`
}
