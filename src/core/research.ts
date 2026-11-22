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
  /**
   * analyze is optional: without it, the host runs the fixed entry point of analyzeCommand in research-commands.ts.
   * plan, fetch, unit and merge are all present or all absent. With them, stage 6 fans out (fansOut).
   */
  commands: { known: string; inject: string; evaluate: string; reproduce: string; analyze?: string; sweep?: string } & Partial<Record<FanOutCommand, string>>
  credentials?: Record<string, ResearchCredential>
  /** The timeout in ms of each domain command. A missing key takes the timeout of the checks. */
  timeouts?: ResearchTimeouts
  /** Normalized https URLs for scout (R4). The host reads them, thus egress does not limit their hosts. */
  feeds?: string[]
}

/** The notebook commands of a stage 6 fan-out (section 6.3 of docs/specs/research-workflow.md). */
export type FanOutCommand = 'plan' | 'fetch' | 'unit' | 'merge'

export const fanOutCommands: readonly FanOutCommand[] = ['plan', 'fetch', 'unit', 'merge']

/** Tells if stage 6 of the config fans out over scan boxes. parseResearchConfig permits only all four commands or none. */
export const fansOut = (research: ResearchConfig): boolean => fanOutCommands.every((name) => research.commands[name] !== undefined)

export type ResearchTimeouts = Partial<Record<'known' | 'inject' | 'evaluate' | 'reproduce' | 'analyze' | FanOutCommand, number>>

/**
 * The holdout file. `refuse` is the list of URL prefixes that the egress refuses to agents. Each prefix has the
 * normalized form of the URL parser (lowercase host, no default port), because the egress compares normalized request URLs.
 */
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

/** Gives each URL in the normalized form of the URL parser, as parseHoldout does. */
function feedList(value: unknown, key: string, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0) return fail(key, 'must be a non-empty list of https URLs')
  const feeds: string[] = []
  value.forEach((item, index) => {
    const at = `${key}[${index}]`
    const text = nonEmptyString(item, at, fail)
    const url = URL.canParse(text) ? new URL(text) : null
    if (url?.protocol !== 'https:') return fail(at, `must be an https URL: ${text}`)
    if (url.username !== '' || url.password !== '') fail(at, `must not have a user or a password: ${text}`)
    if (feeds.includes(url.href)) fail(at, `repeats the URL ${url.href}`)
    feeds.push(url.href)
  })
  return feeds
}

/** A placeholder is {name} that does not follow a $, so that a shell ${VAR} stays permitted. */
const placeholder = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `required` is a placeholder that the command must use, because without it each call runs the same command. */
function command(value: unknown, key: string, permitted: string[], fail: Fail, required?: string): string {
  const text = nonEmptyString(value, key, fail)
  const used = [...text.matchAll(placeholder)].map(([found]) => found.slice(1, -1))
  for (const name of used) if (!permitted.includes(name)) fail(key, `uses the placeholder {${name}}, but only ${permitted.map((item) => `{${item}}`).join(' and ')} are permitted`)
  if (required !== undefined && !used.includes(required)) fail(key, `must use the placeholder {${required}}`)
  return text
}

/** Replaces each placeholder of a command that `values` names with its value. A value is not searched for placeholders again. */
export const fillCommand = (template: string, values: Record<string, string>): string =>
  template.replace(placeholder, (found, name: string) => values[name] ?? found)

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
    if (Object.hasOwn(parsed, host)) fail(at, `repeats the host ${host}`)
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

const timeoutKeys: readonly (keyof ResearchTimeouts)[] = ['known', 'inject', 'evaluate', 'reproduce', 'analyze', ...fanOutCommands]

function timeouts(value: unknown, key: string, fail: Fail): ResearchTimeouts {
  const entries = object(value, key, [...timeoutKeys], fail)
  const parsed: ResearchTimeouts = {}
  for (const name of timeoutKeys) {
    const ms = entries[name]
    if (ms === undefined) continue
    parsed[name] = typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 ? ms : fail(`${key}.${name}`, 'must be a positive integer of milliseconds')
  }
  return parsed
}

const researchKeys = ['egress', 'holdout', 'lenses', 'guides', 'checklist', 'prereg_sections', 'commands', 'credentials', 'timeouts', 'feeds']

/** Parses the research field of .agent-factory.json. Each error names `source` and the bad key. */
export function parseResearchConfig(value: unknown, source: string): ResearchConfig {
  const fail = failAt(source)
  const research = object(value, 'research', researchKeys, fail)
  const egress = egressList(research.egress, 'research.egress', fail)
  const lenses = object(research.lenses, 'research.lenses', ['survey', 'skeptic'], fail)
  const commands = object(research.commands, 'research.commands', ['known', 'inject', 'evaluate', 'reproduce', 'analyze', 'sweep', ...fanOutCommands], fail)
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
  if (commands.analyze !== undefined) config.commands.analyze = command(commands.analyze, 'research.commands.analyze', prereg, fail)
  if (commands.sweep !== undefined) config.commands.sweep = command(commands.sweep, 'research.commands.sweep', [...prereg, 'partition'], fail)
  const present = fanOutCommands.filter((name) => commands[name] !== undefined)
  if (present.length > 0 && present.length < fanOutCommands.length) {
    const missing = fanOutCommands.filter((name) => !present.includes(name))
    fail('research.commands', `has ${present.join(', ')} but not ${missing.join(', ')}: give all of plan, fetch, unit and merge, or none of them`)
  }
  const fanOutPlaceholders: Record<FanOutCommand, string[]> = { plan: prereg, fetch: [...prereg, 'target'], unit: [...prereg, 'unit'], merge: [...prereg, 'units'] }
  const fanOutRequired: Partial<Record<FanOutCommand, string>> = { fetch: 'target', unit: 'unit', merge: 'units' }
  for (const name of present) config.commands[name] = command(commands[name], `research.commands.${name}`, fanOutPlaceholders[name], fail, fanOutRequired[name])
  if (research.credentials !== undefined) config.credentials = credentials(research.credentials, 'research.credentials', egress, fail)
  if (research.timeouts !== undefined) config.timeouts = timeouts(research.timeouts, 'research.timeouts', fail)
  if (research.feeds !== undefined) config.feeds = feedList(research.feeds, 'research.feeds', fail)
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
  const refuse = stringList(holdout.refuse, 'refuse', fail).map((prefix, index) => {
    const url = URL.canParse(prefix) ? new URL(prefix) : null
    if (url?.protocol !== 'https:') return fail(`refuse[${index}]`, `must be an https URL prefix: ${prefix}`)
    if (!egress.includes(url.hostname)) fail(`refuse[${index}]`, `must be on a host of research.egress, not ${url.hostname}`)
    if (url.username !== '' || url.password !== '') fail(`refuse[${index}]`, `must not have a user or a password: ${prefix}`)
    // A request URL has no fragment, so a prefix with a fragment does not match a request.
    if (url.href.includes('#')) fail(`refuse[${index}]`, `must not have a fragment: ${prefix}`)
    return url.href
  })
  return { refuse, targets: stringList(holdout.targets, 'targets', fail) }
}

const listMarker = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)/
const heading = /^ {0,3}#{1,6}(?:\s|$)/
const fenceOpen = /^ {0,3}(`{3,}(?!.*`)|~{3,})/
const fenceClose = /^ {0,3}(`+|~+)[ \t]*$/

/**
 * The top-level list items of a Markdown file. An item holds its first line and the indented lines after it. A heading,
 * a line without indent after a blank line, or a code fence with less indent than the item text ends the item. A list
 * marker in a code fence does not start an item.
 */
function checklistItems(text: string): string[] {
  const items: string[][] = []
  let current: string[] | null = null
  // The column of the text of the current item. A list marker with less indent starts the next top-level item.
  let content = 0
  let blank = false
  // The backticks or tildes that opened the current code fence.
  let fence: string | null = null
  let fenceOffset = 0
  for (const line of text.split(/\r?\n/)) {
    const indent = line.search(/[^ ]|$/)
    if (fence !== null && fenceOffset > 0 && line.trim() !== '' && indent < fenceOffset) {
      fence = null
      current = null
    }
    if (fence !== null) {
      const close = indent >= fenceOffset ? fenceClose.exec(line.slice(fenceOffset))?.[1] : undefined
      if (close !== undefined && close.charAt(0) === fence.charAt(0) && close.length >= fence.length) fence = null
      current?.push(line)
      continue
    }
    const offset = current !== null && indent >= content ? content : 0
    const open = fenceOpen.exec(line.slice(offset))?.[1]
    if (open !== undefined) {
      fence = open
      fenceOffset = offset
      if (current !== null && indent < content) current = null
      current?.push(line)
      blank = false
      continue
    }
    const marker = listMarker.exec(line)
    if (marker && (current === null || indent < content)) {
      const [whole, before = '', bullet = '', after = ''] = marker
      content = before.length + bullet.length + (/^ {1,4}$/.test(after) ? after.length : 1)
      current = [line.slice(whole.length)]
      fence = fenceOpen.exec(line.slice(content))?.[1] ?? null
      fenceOffset = content
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
