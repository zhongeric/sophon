import type { RootFiles } from './profiles.ts'

/** A TOML value. Null is a number, boolean or date: the reader keeps no value for these scalars. */
export type TomlValue = string | null | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

/** Sets an own property, so that a key such as __proto__ cannot change a prototype. */
const put = <T extends TomlValue>(target: TomlTable, key: string, value: T): T => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  return value
}

const isTable = (value: TomlValue | undefined): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value)
const table = (value: TomlValue | undefined): TomlTable => (isTable(value) ? value : {})

const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' }
const bareKey = /[A-Za-z0-9_-]+/y
const scalar = /[^,\]}#\r\n]+/y

/**
 * A small TOML reader for pyproject.toml, without a package. It reads tables, dotted and quoted keys, strings, arrays
 * and inline tables. It ignores array tables. It throws on malformed input, so that the caller can ignore the file.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  const arrayTables: string[][] = []
  let current = root
  let i = 0

  const fail = (message: string): never => {
    throw new Error(`TOML line ${text.slice(0, i).split('\n').length}: ${message}`)
  }
  const blank = () => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  const comment = () => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
  }
  const newline = () => {
    if (text.startsWith('\r\n', i)) i += 2
    else if (text[i] === '\n') i++
    else return false
    return true
  }
  /** Blanks, comments and newlines, between lines and in arrays. */
  const gap = () => {
    do {
      blank()
      comment()
    } while (newline())
  }
  const endOfLine = () => {
    blank()
    comment()
    if (!newline() && i < text.length) fail(`unexpected ${text[i]}`)
  }

  const basic = (multi: boolean): string => {
    let value = ''
    for (;;) {
      if (i >= text.length) fail('unclosed string')
      if (multi ? text.startsWith('"""', i) : text[i] === '"') {
        if (!multi) {
          i++
          return value
        }
        // Up to two more quotes before the closing three belong to the string.
        let end = i + 3
        while (text[end] === '"' && end < i + 5) end++
        value += '"'.repeat(end - i - 3)
        i = end
        return value
      }
      const char = text.charAt(i)
      if (!multi && char === '\n') fail('unclosed string')
      if (char !== '\\') {
        value += char
        i++
        continue
      }
      const next = text.charAt(i + 1)
      if (multi && /[ \t\r\n]/.test(next)) {
        // A backslash at the end of a line removes the newline and the whitespace after it.
        let end = i + 1
        while (text[end] === ' ' || text[end] === '\t') end++
        if (text[end] === '\r' || text[end] === '\n') {
          i = end
          while (/[ \t\r\n]/.test(text.charAt(i))) i++
          continue
        }
      }
      const escape = escapes[next]
      if (escape !== undefined) {
        value += escape
        i += 2
        continue
      }
      const length = next === 'u' ? 4 : next === 'U' ? 8 : 0
      const hex = text.slice(i + 2, i + 2 + length)
      if (length === 0 || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail('bad escape in a string')
      value += String.fromCodePoint(parseInt(hex, 16))
      i += 2 + length
    }
  }

  const literal = (multi: boolean): string => {
    const close = multi ? "'''" : "'"
    let end = text.indexOf(close, i)
    if (end < 0 || (!multi && text.slice(i, end).includes('\n'))) return fail('unclosed string')
    if (multi) for (let more = 0; more < 2 && text[end + 3] === "'"; more++) end++
    const value = text.slice(i, end)
    i = end + close.length
    return value
  }

  const string = (): string => {
    for (const quotes of ['"""', "'''"])
      if (text.startsWith(quotes, i)) {
        i += 3
        // A newline right after the opening quotes is not part of the string.
        newline()
        return quotes === '"""' ? basic(true) : literal(true)
      }
    return text[i++] === '"' ? basic(false) : literal(false)
  }

  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      blank()
      if (text[i] === '"' || text[i] === "'") {
        if (text.startsWith('"""', i) || text.startsWith("'''", i)) fail('a key cannot be a multi-line string')
        parts.push(string())
      } else {
        bareKey.lastIndex = i
        const bare = bareKey.exec(text)?.[0] ?? fail('expected a key')
        parts.push(bare)
        i += bare.length
      }
      blank()
      if (text[i] !== '.') return parts
      i++
    }
  }

  /** The table at `path` under `parent`. It makes the tables that do not exist. */
  const tableAt = (parent: TomlTable, path: string[]): TomlTable => {
    let node = parent
    for (const part of path) {
      const next = Object.hasOwn(node, part) ? node[part] : put(node, part, {})
      if (!isTable(next)) return fail(`${part} is not a table`)
      node = next
    }
    return node
  }

  const assign = (target: TomlTable, path: string[]) => {
    const last = path.at(-1) ?? fail('expected a key')
    const parent = tableAt(target, path.slice(0, -1))
    blank()
    if (text[i] !== '=') fail('expected = after a key')
    i++
    blank()
    if (Object.hasOwn(parent, last)) fail(`duplicate key ${last}`)
    put(parent, last, value())
  }

  const value = (): TomlValue => {
    const char = text[i]
    if (char === '"' || char === "'") return string()
    if (char === '[') {
      i++
      const items: TomlValue[] = []
      for (;;) {
        gap()
        if (text[i] === ']') {
          i++
          return items
        }
        if (i >= text.length) fail('unclosed array')
        items.push(value())
        gap()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('unclosed array')
      }
    }
    if (char === '{') {
      i++
      const inline: TomlTable = {}
      for (;;) {
        gap()
        if (text[i] === '}') {
          i++
          return inline
        }
        if (i >= text.length) fail('unclosed inline table')
        assign(inline, key())
        gap()
        if (text[i] === ',') i++
        else if (text[i] !== '}') fail('unclosed inline table')
      }
    }
    scalar.lastIndex = i
    const raw = scalar.exec(text)?.[0] ?? ''
    if (raw.trim() === '') fail('expected a value')
    i += raw.length
    return null
  }

  for (;;) {
    gap()
    if (i >= text.length) return root
    if (text[i] !== '[') {
      assign(current, key())
      endOfLine()
      continue
    }
    const array = text[i + 1] === '['
    i += array ? 2 : 1
    const path = key()
    const close = array ? ']]' : ']'
    if (!text.startsWith(close, i)) fail('unclosed table header')
    i += close.length
    // The reader ignores array tables and the tables in them: no dependency list is in one.
    const inArray = arrayTables.some((prefix) => prefix.length <= path.length && prefix.every((part, n) => path[n] === part))
    if (array) arrayTables.push(path)
    current = array || inArray ? {} : tableAt(root, path)
    endOfLine()
  }
}

/** A dependency: its name with PEP 503 normalization, and its PEP 440 version constraint, or '' for none. */
export type Requirement = { name: string; constraint: string }

export const normalizeName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

const requirementShape = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*([^;@]*)/

/** A PEP 508 requirement, for example `pytest[testing] (>=8) ; python_version > "3.9"`, or null when it has no name. */
export function parseRequirement(text: string): Requirement | null {
  const match = requirementShape.exec(text)
  if (!match?.[1]) return null
  const constraint = (match[2] ?? '').trim().replace(/^\((.*)\)$/, '$1')
  return { name: normalizeName(match[1]), constraint: constraint.replace(/\s+/g, '') }
}

/** The requirements of a requirements file. Comments, blank lines and option lines such as `-r` or `-e` do not count. */
export function requirementsFile(text: string): Requirement[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const content = line.replace(/(^|\s)#.*$/, '').trim()
    if (content === '' || content.startsWith('-')) return []
    return parseRequirement(content) ?? []
  })
}

/** A Poetry constraint as a PEP 440 constraint: `^` and `~` become ranges, `*` is no constraint, a bare version is exact. */
export function poetryConstraint(spec: string): string {
  const parts = spec.split(',').map((part) => part.trim()).filter((part) => part !== '' && part !== '*')
  return parts
    .map((part) => {
      const range = /^([\^~])(?!=)\s*(\d+(?:\.\d+)*)(.*)$/.exec(part)
      if (range?.[1] && range[2]) {
        const numbers = range[2].split('.').map(Number)
        // A caret allows changes after the first nonzero part. A tilde allows changes after the minor part.
        const nonzero = numbers.findIndex((number) => number !== 0)
        const at = range[1] === '^' ? (nonzero < 0 ? numbers.length - 1 : nonzero) : Math.min(1, numbers.length - 1)
        const upper = [...numbers.slice(0, at), (numbers[at] ?? 0) + 1].join('.')
        return `>=${range[2]}${range[3] ?? ''},<${upper}`
      }
      return /^\d/.test(part) ? `==${part}` : part.replace(/\s+/g, '')
    })
    .join(',')
}

const pep508List = (value: TomlValue | undefined): Requirement[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? (parseRequirement(item) ?? []) : [])) : []

/** A Poetry dependency table: names to a constraint, to an inline table with a version, or to a list of these. */
const poetryList = (value: TomlValue | undefined): Requirement[] =>
  Object.entries(table(value))
    .filter(([name]) => normalizeName(name) !== 'python')
    .map(([name, spec]) => {
      const version = typeof spec === 'string' ? spec : table(spec).version
      return { name: normalizeName(name), constraint: typeof version === 'string' ? poetryConstraint(version) : '' }
    })

/** The dependencies of a Python repository, from its root requirements*.txt files and its pyproject.toml. */
export type PythonDependencies = {
  /** Each root requirements*.txt file, in name order. */
  requirements: { file: string; requirements: Requirement[] }[]
  /** True when pyproject.toml has a [project], [tool.poetry] or [build-system] table, so that pip can install the project. */
  installable: boolean
  /** The [project] dependencies and the Poetry main dependencies. */
  main: Requirement[]
  /** The optional dependencies of [project], by extra name. */
  extras: Record<string, Requirement[]>
  /** The dependency groups, the Poetry groups and the Poetry dev-dependencies. */
  groups: Requirement[]
}

/** The dependencies of the repository at `root`, or null when its pyproject.toml does not parse. */
export async function pythonDependencies(root: RootFiles): Promise<PythonDependencies | null> {
  const text = await root.read('pyproject.toml')
  let pyproject: TomlTable = {}
  try {
    if (text !== null) pyproject = parseToml(text)
  } catch {
    return null
  }
  const files = (await root.list()).filter((name) => /^requirements.*\.txt$/.test(name)).sort()
  const requirements = await Promise.all(files.map(async (file) => ({ file, requirements: requirementsFile((await root.read(file)) ?? '') })))
  const project = table(pyproject.project)
  const tool = table(pyproject.tool)
  const poetry = table(tool.poetry)
  return {
    requirements,
    installable: isTable(pyproject.project) || isTable(tool.poetry) || isTable(pyproject['build-system']),
    main: [...pep508List(project.dependencies), ...poetryList(poetry.dependencies)],
    extras: Object.fromEntries(Object.entries(table(project['optional-dependencies'])).map(([extra, list]) => [normalizeName(extra), pep508List(list)])),
    groups: [
      // pep508List skips the {include-group = "..."} tables of a dependency group.
      ...Object.values(table(pyproject['dependency-groups'])).flatMap(pep508List),
      ...poetryList(poetry['dev-dependencies']),
      ...Object.values(table(poetry.group)).flatMap((group) => poetryList(table(group).dependencies)),
    ],
  }
}

/** The tools that turn on the default lint check and the default tests. */
const pythonTools = ['ruff', 'pytest']
const pip = '.venv/bin/python -m pip install'

/** A shell argument, quoted when it holds a character that the shell reads, for example `[`, `<` or a space. */
const shellArg = (value: string) => (/^[\w.,=~+\-/:@%]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

/** An editable install with setuptools can write *.egg-info into the tree, and the host commits each file that git does not ignore. */
const ignoreEggInfo = `for d in *.egg-info src/*.egg-info; do if [ -d "$d" ]; then printf '*\\n' > "$d/.gitignore"; fi; done`

/**
 * The setup commands of a Python repository, and the tools of pythonTools that the setup installs. The setup makes
 * .venv and makes git ignore it. It installs requirements.txt, the other root requirements files and the project
 * extras that hold a tool, and the project. Then it installs by name each tool that only a group or another extra holds.
 */
export async function pythonSetup(root: RootFiles): Promise<{ commands: string[]; tools: string[] }> {
  const commands = ['python3 -m venv .venv', `printf '*\\n' > .venv/.gitignore`]
  if (await root.exists('requirements.txt')) commands.push(`${pip} -r requirements.txt`)
  const dependencies = await pythonDependencies(root)
  if (!dependencies) return { commands, tools: [] }
  const installed = new Set<string>()
  const holds = (list: Requirement[]) => pythonTools.filter((tool) => list.some((requirement) => requirement.name === tool))
  for (const { file, requirements } of dependencies.requirements) {
    const tools = holds(requirements)
    if (file !== 'requirements.txt' && tools.length > 0) commands.push(`${pip} -r ${shellArg(file)}`)
    for (const tool of tools) installed.add(tool)
  }
  if (dependencies.installable) {
    const extras = ['dev', 'test'].filter((extra) => holds(dependencies.extras[extra] ?? []).length > 0)
    commands.push(`${pip} -e ${shellArg(extras.length > 0 ? `.[${extras.join(',')}]` : '.')}`, ignoreEggInfo)
    for (const list of [dependencies.main, ...extras.map((extra) => dependencies.extras[extra] ?? [])]) for (const tool of holds(list)) installed.add(tool)
  }
  const others = [...dependencies.groups, ...Object.values(dependencies.extras).flat()]
  const byName = pythonTools.flatMap((tool) => (installed.has(tool) ? [] : others.filter((requirement) => requirement.name === tool).slice(0, 1)))
  if (byName.length > 0) commands.push(`${pip} ${byName.map((requirement) => shellArg(requirement.name + requirement.constraint)).join(' ')}`)
  for (const requirement of byName) installed.add(requirement.name)
  return { commands, tools: pythonTools.filter((tool) => installed.has(tool)) }
}
