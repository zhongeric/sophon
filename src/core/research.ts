import { hostSecrets } from './secrets.ts'
import { StopError } from './stop.ts'

/** A header that the egress adds for one host. `secret` is the name of a host environment variable, never its value. */
export type ResearchCredential = { header: string; secret: string }

/**
 * The research field of .agent-factory.json (section 6.3 of docs/specs/research-workflow.md). Host names are lowercase.
 * Paths are normalized and relative to the repository root, with no leading or trailing slash.
 */
export type ResearchConfig = {
  egress: string[]
  holdout: string
  lenses: { survey: string[]; skeptic: string[] }
  guides: string
  checklist: string
  prereg_sections: string[]
  commands: { known: string; inject: string; evaluate: string; reproduce: string; sweep?: string }
  credentials?: Record<string, ResearchCredential>
}

/** The holdout file. `refuse` is the list of URL prefixes that the egress refuses to agents. */
export type Holdout = { refuse: string[]; targets: string[] }

/** The domain of a notebook: its config and the files that the config names. `guides` maps a file name with .md to its text. */
export type ResearchDomain = { config: ResearchConfig; holdout: Holdout; checklist: string[]; guides: Record<string, string> }

/**
 * The files of a repository at one ref, by path relative to the root. `read` gives null when no file is there.
 * `list` gives the names of the files (not directories) directly in a directory, or null when the directory does not exist.
 */
export type ResearchFiles = {
  read(path: string): Promise<string | null>
  list(dir: string): Promise<string[] | null>
}

type Fail = (key: string, problem: string) => never

const failAt = (source: string): Fail => (key, problem) => {
  throw new StopError(`${source}: ${key} ${problem}`)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function object(value: unknown, key: string, keys: string[], fail: Fail, child = (name: string) => `${key}.${name}`): Record<string, unknown> {
  if (!isObject(value)) return fail(key, 'must be an object')
  for (const name of Object.keys(value)) if (!keys.includes(name)) fail(child(name), `is not a known key (known: ${keys.join(', ')})`)
  return value
}

const nonEmptyString = (value: unknown, key: string, fail: Fail): string =>
  typeof value === 'string' && value.trim() !== '' ? value : fail(key, 'must be a non-empty string')

function stringList(value: unknown, key: string, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0) return fail(key, 'must be a non-empty list of strings')
  return value.map((item, index) => nonEmptyString(item, `${key}[${index}]`, fail))
}

const dnsLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function hostName(value: unknown, key: string, fail: Fail): string {
  const host = nonEmptyString(value, key, fail).toLowerCase()
  if (host.length > 253 || !host.split('.').every((label) => dnsLabel.test(label)))
    fail(key, `must be a host name only, without a scheme, path, port, user or query: ${JSON.stringify(value)}`)
  return host
}

function egressList(value: unknown, key: string, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0) return fail(key, 'must be a non-empty list of host names')
  const hosts: string[] = []
  value.forEach((item, index) => {
    const host = hostName(item, `${key}[${index}]`, fail)
    if (hosts.includes(host)) fail(`${key}[${index}]`, `repeats the host ${host}`)
    hosts.push(host)
  })
  return hosts
}

/** A placeholder is {name} that does not follow a $, so that a shell ${VAR} stays permitted. */
const placeholder = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function command(value: unknown, key: string, permitted: string[], fail: Fail): string {
  const text = nonEmptyString(value, key, fail)
  for (const [found] of text.matchAll(placeholder))
    if (!permitted.includes(found.slice(1, -1))) fail(key, `uses the placeholder ${found}, but only ${permitted.map((item) => `{${item}}`).join(' and ')} are permitted`)
  return text
}

/** Normalizes . and .. segments and extra slashes. The path must stay in the repository. */
function relativePath(value: unknown, key: string, fail: Fail): string {
  const path = nonEmptyString(value, key, fail)
  if (path.startsWith('/')) fail(key, `must be relative to the repository root: ${path}`)
  if (path.includes('\\')) fail(key, `must use / and not a backslash: ${path}`)
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.pop() === undefined) fail(key, `goes above the repository root: ${path}`)
  }
  if (segments.length === 0) fail(key, `names the repository root, not a path in it: ${path}`)
  return segments.join('/')
}

const headerToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/

function credentials(value: unknown, key: string, egress: string[], fail: Fail): Record<string, ResearchCredential> {
  if (!isObject(value)) return fail(key, 'must be an object of host name to { header, secret }')
  const parsed: Record<string, ResearchCredential> = {}
  for (const [name, entry] of Object.entries(value)) {
    const at = `${key}[${JSON.stringify(name)}]`
    const host = name.toLowerCase()
    if (!egress.includes(host)) fail(at, `names a host that is not in research.egress`)
    if (host in parsed) fail(at, `repeats the host ${host}`)
    const credential = object(entry, at, ['header', 'secret'], fail)
    const header = nonEmptyString(credential.header, `${at}.header`, fail)
    if (!headerToken.test(header)) fail(`${at}.header`, `must be an HTTP header name: ${JSON.stringify(header)}`)
    const secret = nonEmptyString(credential.secret, `${at}.secret`, fail)
    if (!envName.test(secret)) fail(`${at}.secret`, `must be the name of an environment variable: ${JSON.stringify(secret)}`)
    if (hostSecrets.includes(secret)) fail(`${at}.secret`, `must not name a secret of the host: ${secret}`)
    parsed[host] = { header, secret }
  }
  return parsed
}

const researchKeys = ['egress', 'holdout', 'lenses', 'guides', 'checklist', 'prereg_sections', 'commands', 'credentials']

/** Parses the research field of .agent-factory.json. Each error names `source` and the bad key. */
export function parseResearchConfig(value: unknown, source: string): ResearchConfig {
  const fail = failAt(source)
  const research = object(value, 'research', researchKeys, fail)
  const egress = egressList(research.egress, 'research.egress', fail)
  const lenses = object(research.lenses, 'research.lenses', ['survey', 'skeptic'], fail)
  const commands = object(research.commands, 'research.commands', ['known', 'inject', 'evaluate', 'reproduce', 'sweep'], fail)
  const prereg = ['prereg']
  const config: ResearchConfig = {
    egress,
    holdout: relativePath(research.holdout, 'research.holdout', fail),
    lenses: { survey: stringList(lenses.survey, 'research.lenses.survey', fail), skeptic: stringList(lenses.skeptic, 'research.lenses.skeptic', fail) },
    guides: relativePath(research.guides, 'research.guides', fail),
    checklist: relativePath(research.checklist, 'research.checklist', fail),
    prereg_sections: stringList(research.prereg_sections, 'research.prereg_sections', fail),
    commands: {
      known: command(commands.known, 'research.commands.known', prereg, fail),
      inject: command(commands.inject, 'research.commands.inject', prereg, fail),
      evaluate: command(commands.evaluate, 'research.commands.evaluate', prereg, fail),
      reproduce: command(commands.reproduce, 'research.commands.reproduce', prereg, fail),
    },
  }
  if (commands.sweep !== undefined) config.commands.sweep = command(commands.sweep, 'research.commands.sweep', [...prereg, 'partition'], fail)
  if (research.credentials !== undefined) config.credentials = credentials(research.credentials, 'research.credentials', egress, fail)
  return config
}

function parseHoldout(text: string, egress: string[], fail: Fail): Holdout {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return fail('the file', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const holdout = object(value, 'the file', ['refuse', 'targets'], fail, (name) => name)
  const refuse = stringList(holdout.refuse, 'refuse', fail)
  refuse.forEach((prefix, index) => {
    const url = URL.canParse(prefix) ? new URL(prefix) : null
    if (url?.protocol !== 'https:') fail(`refuse[${index}]`, `must be an https URL prefix: ${prefix}`)
    if (!egress.includes(url.hostname)) fail(`refuse[${index}]`, `must be on a host of research.egress, not ${url.hostname}`)
  })
  return { refuse, targets: stringList(holdout.targets, 'targets', fail) }
}

const listMarker = /^(?:[-*+]|\d+[.)]) /
const heading = /^ {0,3}#{1,6}(?:\s|$)/

/**
 * The top-level list items of a Markdown file. An item holds its first line and the indented lines after it. A heading,
 * or a line without indent after a blank line, ends the item.
 */
export function checklistItems(text: string): string[] {
  const items: string[][] = []
  let current: string[] | null = null
  let blank = false
  for (const line of text.split(/\r?\n/)) {
    const marker = listMarker.exec(line)
    if (marker) {
      current = [line.slice(marker[0].length)]
      items.push(current)
      blank = false
    } else if (current === null) continue
    else if (line.trim() === '') blank = true
    else if (heading.test(line) || (blank && !/^[ \t]/.test(line))) current = null
    else {
      current.push(line)
      blank = false
    }
  }
  return items.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== '').join('\n')).filter((item) => item !== '')
}

async function readFile(files: ResearchFiles, path: string, fail: Fail): Promise<string> {
  return (await files.read(path)) ?? fail('the file', 'does not exist')
}

/** Reads the holdout, the checklist and the guides that the research config names. A missing or bad file stops the run. */
export async function loadResearchDomain(research: ResearchConfig, files: ResearchFiles, source: string): Promise<ResearchDomain> {
  const holdoutFail = failAt(`${research.holdout} ${source}`)
  const holdout = parseHoldout(await readFile(files, research.holdout, holdoutFail), research.egress, holdoutFail)

  const checklistFail = failAt(`${research.checklist} ${source}`)
  const checklist = checklistItems(await readFile(files, research.checklist, checklistFail))
  if (checklist.length === 0) checklistFail('the file', 'has no top-level list item')

  const guidesFail = failAt(`${research.guides} ${source}`)
  const names = (await files.list(research.guides)) ?? guidesFail('the directory', 'does not exist')
  const guides: Record<string, string> = {}
  for (const name of names.filter((name) => name.endsWith('.md')))
    guides[name] = await readFile(files, `${research.guides}/${name}`, failAt(`${research.guides}/${name} ${source}`))
  if (Object.keys(guides).length === 0) guidesFail('the directory', 'has no .md file')

  return { config: research, holdout, checklist, guides }
}
