/** Environment variables that hold the host's own secrets. Agents and code under review never receive them. */
export const hostSecrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'GITHUB_TOKEN', 'NANOCODE_RUNNER_TOKEN', 'CF_AIG_TOKEN', 'CLOUDFLARE_API_TOKEN']

export function withoutHostSecrets<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env }
  for (const name of hostSecrets) delete copy[name]
  return copy
}
