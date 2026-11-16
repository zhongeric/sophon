import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RootFiles } from '../src/core/profiles.ts'
import { parseRequirement, parseToml, poetryConstraint, pythonDependencies, pythonSetup, requirementsFile } from '../src/core/python.ts'

const root = (files: Record<string, string>): RootFiles => ({
  exists: async (name) => name in files,
  read: async (name) => files[name] ?? null,
  list: async () => Object.keys(files),
})

test('the TOML reader reads tables, dotted and quoted keys, strings, arrays and inline tables', () => {
  const toml = [
    '# a comment',
    'title = "x" # a comment after a value',
    'site."example.com".port = 80',
    '',
    '[ tool . "my.tool" ]',
    'basic = "tab\\there \\"q\\" \\u00e9 # not a comment"',
    "literal = 'C:\\path # not a comment'",
    'multi = """',
    'one \\',
    '    two"""""',
    "raw = '''",
    "a\\b ''quoted'''",
    'list = [',
    '  "a", # first',
    '  [1, 2.5, true],',
    '  { name = "b", nested.flag = false },',
    ']',
    'empty = []',
    'when = 1979-05-27 07:32:00Z',
    '',
    '[[tool.poetry.source]]',
    'name = "private"',
    '[tool.poetry.source.extra]',
    'url = "https://x"',
    '[[tool.poetry.source]]',
    'name = "other"',
    '[tool.poetry]',
    'name = "app"',
  ].join('\n')
  assert.deepEqual(parseToml(toml), {
    title: 'x',
    site: { 'example.com': { port: null } },
    tool: {
      'my.tool': {
        basic: 'tab\there "q" \u00e9 # not a comment',
        literal: 'C:\\path # not a comment',
        multi: 'one two""',
        raw: "a\\b ''quoted",
        list: ['a', [null, null, null], { name: 'b', nested: { flag: null } }],
        empty: [],
        when: null,
      },
      poetry: { name: 'app' },
    },
  })
  assert.deepEqual(parseToml('a = "x"\r\n[b]\r\nc = [\r\n  "d",\r\n]\r\n'), { a: 'x', b: { c: ['d'] } })
  const proto = parseToml('[__proto__]\npolluted = "x"\n[a]\n__proto__ = "y"')
  assert.deepEqual(Object.keys(proto), ['__proto__', 'a'])
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(Object.getPrototypeOf(proto.a), Object.prototype)
})

test('the TOML reader throws on malformed input', () => {
  for (const [text, error] of [
    ['a = "x', /unclosed string/],
    ['a = "x\nb = 1', /unclosed string/],
    ["a = 'x", /unclosed string/],
    ['a = """x', /unclosed string/],
    ["a = '''x", /unclosed string/],
    ['a = [1, 2', /unclosed array/],
    ['a = ["x" "y"]', /unclosed array/],
    ['a = { b = 1', /unclosed inline table/],
    ['[project', /unclosed table header/],
    ['[[tool.x]', /unclosed table header/],
    ['name "x"', /expected = after a key/],
    ['a =', /expected a value/],
    ['a = 1\na = 2', /duplicate key a/],
    ['a = "x" b', /unexpected b/],
    ['a = "\\q"', /bad escape/],
    ['a = 1\n[a.b]', /a is not a table/],
  ] as const)
    assert.throws(() => parseToml(text), error, text)
})

test('a requirement gives its normalized name and its version constraint', () => {
  assert.deepEqual(parseRequirement('Pytest_Cov[toml] (>= 4.0, < 5) ; python_version > "3.8"'), { name: 'pytest-cov', constraint: '>=4.0,<5' })
  assert.deepEqual(parseRequirement('ruff==0.4.*'), { name: 'ruff', constraint: '==0.4.*' })
  assert.deepEqual(parseRequirement('Ruff @ https://example.com/ruff.whl'), { name: 'ruff', constraint: '' })
  assert.deepEqual(parseRequirement('PyTest;sys_platform=="linux"'), { name: 'pytest', constraint: '' })
  assert.equal(parseRequirement('./local/package'), null)
  assert.deepEqual(
    requirementsFile(['# pytest', '', '-r requirements-base.txt', '-e .', '  --index-url https://x', 'numpy>=2 # pinned', 'my.package', '\truff '].join('\n')),
    [
      { name: 'numpy', constraint: '>=2' },
      { name: 'my-package', constraint: '' },
      { name: 'ruff', constraint: '' },
    ],
  )
})

test('a Poetry constraint becomes a PEP 440 constraint', () => {
  const cases: [string, string | null][] = [
    ['^1.2.3', '>=1.2.3,<2'],
    ['^0.2.3', '>=0.2.3,<0.3'],
    ['^0.0.3', '>=0.0.3,<0.0.4'],
    ['^0.0', '>=0.0,<0.1'],
    ['^0', '>=0,<1'],
    ['~1.2.3', '>=1.2.3,<1.3'],
    ['~1', '>=1,<2'],
    ['*', ''],
    ['', ''],
    ['>= 1.2, < 2', '>=1.2,<2'],
    ['~=1.4', '~=1.4'],
    ['1.2.3', '==1.2.3'],
    ['==0.4.2+company.1', '==0.4.2+company.1'],
    ['0.4.2+company-1', '==0.4.2+company-1'],
    ['==1!0.4.2', '==1!0.4.2'],
    ['>=1!0.4.2, <2!0', '>=1!0.4.2,<2!0'],
    ['!=1!0.4.2+company_1', '!=1!0.4.2+company_1'],
    ['^8.0.0rc1', '>=8.0.0rc1,<9'],
    ['^2.0, !=2.1.0', '>=2.0,<3,!=2.1.0'],
    ['1.2.*', '==1.2.*'],
    ['>=0.4 <0.6', '>=0.4,<0.6'],
    ['>= 0.4 < 0.6, != 0.5', '>=0.4,<0.6,!=0.5'],
    ['^7.0 || ^8.0', null],
    ['^7.0 | ^8.0', null],
    ['^8.*', null],
    ['>=1.2.*', null],
    ['>=0.4.2+company.1', null],
    ['==0.4.2+company.*', null],
    ['>=1.0, latest', null],
  ]
  for (const [spec, constraint] of cases) assert.equal(poetryConstraint(spec), constraint, spec)
})

test('the dependencies come from every root requirements file and every dependency list of pyproject.toml', async () => {
  const pyproject = [
    '[build-system]',
    'requires = ["setuptools"]',
    '[project]',
    'name = "app"',
    'dependencies = ["Requests>=2", { not = "a string" }]',
    '[project.optional-dependencies]',
    'Dev = ["PyTest>=8"]',
    'docs = ["sphinx"]',
    '[dependency-groups]',
    'lint = ["ruff==0.6.*", { include-group = "test" }]',
    'test = ["pytest"]',
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'numpy = { version = "^2.1", optional = true }',
    'pandas = { git = "https://x" }',
    '[tool.poetry.dev-dependencies]',
    'black = "*"',
    '[tool.poetry.group.typing.dependencies]',
    'mypy = "~1.10"',
  ].join('\n')
  const files = { 'pyproject.toml': pyproject, 'requirements.txt': 'flask\n', 'requirements-dev.txt': 'ruff\n', 'requirements.in': 'x\n', 'dev-requirements.txt': 'y\n' }
  assert.deepEqual(await pythonDependencies(root(files)), {
    requirements: [
      { file: 'requirements-dev.txt', requirements: [{ name: 'ruff', constraint: '' }] },
      { file: 'requirements.txt', requirements: [{ name: 'flask', constraint: '' }] },
    ],
    installable: true,
    main: [{ name: 'requests', constraint: '>=2' }],
    extras: { dev: [{ name: 'pytest', constraint: '>=8' }], docs: [{ name: 'sphinx', constraint: '' }] },
    groups: [
      { name: 'ruff', constraint: '==0.6.*' },
      { name: 'pytest', constraint: '' },
      { name: 'black', constraint: '' },
      { name: 'mypy', constraint: '>=1.10,<1.11' },
      { name: 'numpy', constraint: '>=2.1,<3' },
      { name: 'pandas', constraint: '' },
    ],
    project: { name: 'app', dependencies: ['Requests>=2'], extras: { dev: ['PyTest>=8'], docs: ['sphinx'] } },
  })

  const poetry = [
    '[build-system]',
    'build-backend = "poetry.core.masonry.api"',
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'numpy = "^2.1"',
    'pytest = { version = "^8.0", optional = true }',
    'ruff = { version = "^0.4", optional = true }',
    '[tool.poetry.extras]',
    'Dev = ["PyTest"]',
  ].join('\n')
  assert.deepEqual(await pythonDependencies(root({ 'pyproject.toml': poetry })), {
    requirements: [],
    installable: true,
    main: [{ name: 'numpy', constraint: '>=2.1,<3' }],
    extras: { dev: [{ name: 'pytest', constraint: '>=8.0,<9' }] },
    groups: [
      { name: 'pytest', constraint: '>=8.0,<9' },
      { name: 'ruff', constraint: '>=0.4,<0.5' },
    ],
    project: { name: null, dependencies: [], extras: {} },
  })
  assert.equal((await pythonDependencies(root({ 'pyproject.toml': '[project]\nname = "app"\n' })))?.installable, true)
  assert.equal((await pythonDependencies(root({ 'pyproject.toml': '[project]\nname = "app"\n', 'setup.cfg': '' })))?.installable, true)
  assert.equal((await pythonDependencies(root({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' })))?.installable, false)
  assert.equal(await pythonDependencies(root({ 'pyproject.toml': '[project\n', 'requirements.txt': 'ruff\n' })), null)
})

const venv = ['python3 -m venv .venv', "printf '*\\n' > .venv/.gitignore"]
const pip = '.venv/bin/python -m pip install'
const eggInfo = `for d in *.egg-info src/*.egg-info; do if [ -d "$d" ]; then printf '*\\n' > "$d/.gitignore"; fi; done`

test('setup tries an editable install and uses the project dependencies and tool extras if pip fails', async () => {
  const app = [
    '[project]',
    'name = "app"',
    'dependencies = [\'numpy; sys_platform == "linux"\', "lib @ https://example.com/lib.whl"]',
    '[project.optional-dependencies]',
    'test = ["pytest>=8", \'numpy; sys_platform == "linux"\']',
    'docs = ["sphinx"]',
  ].join('\n')
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': app, 'main.py': '', 'train.py': '' })), {
    commands: [...venv, `(${pip} -e '.[test]' || ${pip} 'numpy; sys_platform == "linux"' 'lib @ https://example.com/lib.whl' 'pytest>=8')`, eggInfo],
    tools: ['pytest'],
  })
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': '[project]\nname = "app"\n' })), { commands: [...venv, `(${pip} -e . || :)`, eggInfo], tools: [] })
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': '[build-system]\n' + app })), {
    commands: [...venv, `(${pip} -e '.[test]' || ${pip} 'numpy; sys_platform == "linux"' 'lib @ https://example.com/lib.whl' 'pytest>=8')`, eggInfo],
    tools: ['pytest'],
  })
})

test('a Poetry dependency counts as installed by the project install only when poetry-core builds the project and it is not optional', async () => {
  const dependencies = [
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'ruff = "^0.4"',
    'pytest = { version = "^8.0", optional = true }',
    '[tool.poetry.extras]',
    'dev = ["pytest"]',
  ].join('\n')
  const poetryCore = '[build-system]\nrequires = ["poetry-core"]\nbuild-backend = "poetry.core.masonry.api"\n'
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': poetryCore + dependencies })), {
    commands: [...venv, `(${pip} -e '.[dev]' || ${pip} 'ruff>=0.4,<0.5' 'pytest>=8.0,<9')`, eggInfo],
    tools: ['ruff', 'pytest'],
  })
  const setuptools = '[build-system]\nrequires = ["setuptools"]\n'
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': setuptools + dependencies })), {
    commands: [...venv, `(${pip} -e . || :)`, eggInfo, `${pip} 'ruff>=0.4,<0.5' 'pytest>=8.0,<9'`],
    tools: ['ruff', 'pytest'],
  })
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': dependencies })), {
    commands: [...venv, `(${pip} -e . || :)`, eggInfo, `${pip} 'ruff>=0.4,<0.5' 'pytest>=8.0,<9'`],
    tools: ['ruff', 'pytest'],
  })
})

test('a src-layout project without build markers still gets an editable install', async () => {
  const files = {
    'pyproject.toml': '[project]\nname = "app"\nversion = "1.0"\n',
    'src/app/__init__.py': '',
  }
  assert.deepEqual(await pythonSetup(root(files)), { commands: [...venv, `(${pip} -e . || :)`, eggInfo], tools: [] })
})

test('the dependency fallback excludes the project itself with a normalized name', async () => {
  for (const name of ['app', 'My_App']) {
    const self = name.toLowerCase().replace('_', '-')
    const pyproject = [
      '[project]',
      `name = "${name}"`,
      '[project.optional-dependencies]',
      'test = ["pytest"]',
      `dev = ["${self}[test]", "ruff"]`,
    ].join('\n')
    assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': pyproject, 'main.py': '', 'train.py': '' })), {
      commands: [...venv, `(${pip} -e '.[dev,test]' || ${pip} ruff pytest)`, eggInfo],
      tools: ['ruff', 'pytest'],
    })
  }
})

test('Poetry group tools keep local versions and epochs in the setup command', async () => {
  const pyproject = '[tool.poetry.group.dev.dependencies]\nruff = "==0.4.2+company.1"\npytest = "==1!8.0"\n'
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': pyproject })), {
    commands: [...venv, `(${pip} -e . || :)`, eggInfo, `${pip} ruff==0.4.2+company.1 'pytest==1!8.0'`],
    tools: ['ruff', 'pytest'],
  })
})

test('Poetry group tools keep whitespace-separated version bounds in the setup command', async () => {
  const pyproject = '[tool.poetry.group.dev.dependencies]\nruff = ">=0.4 <0.6"\npytest = ">=7 <9"\n'
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': pyproject })), {
    commands: [...venv, `(${pip} -e . || :)`, eggInfo, `${pip} 'ruff>=0.4,<0.6' 'pytest>=7,<9'`],
    tools: ['ruff', 'pytest'],
  })
})

test('setup rejects unsupported Poetry constraints instead of installing an unconstrained tool', async () => {
  for (const section of ['tool.poetry.group.dev.dependencies', 'tool.poetry.dependencies']) {
    const pyproject = `[build-system]\nbuild-backend = "poetry.core.masonry.api"\n[${section}]\npytest = "^7.0 || ^8.0"\n`
    await assert.rejects(pythonSetup(root({ 'pyproject.toml': pyproject })), /Cannot install pytest:.*Poetry constraint.*pyproject.toml.*PEP 440 constraint or set a custom setup command/)
  }
})

test('the non-package Poetry fallback includes runtime dependencies and selected extras with their constraints', async () => {
  const pyproject = [
    '[build-system]',
    'requires = ["poetry-core"]',
    'build-backend = "poetry.core.masonry.api"',
    '[tool.poetry]',
    'package-mode = false',
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'numpy = "^2.1"',
    'pytest = "^8.0"',
    'ruff = { version = ">=0.4 <0.6", optional = true }',
    'pandas = { version = "^2.2", optional = true }',
    'sphinx = { version = "^7", optional = true }',
    '[tool.poetry.extras]',
    'dev = ["ruff", "pandas"]',
    'docs = ["sphinx"]',
  ].join('\n')
  assert.deepEqual(await pythonSetup(root({ 'pyproject.toml': pyproject })), {
    commands: [...venv, `(${pip} -e '.[dev]' || ${pip} 'numpy>=2.1,<3' 'pytest>=8.0,<9' 'ruff>=0.4,<0.6' 'pandas>=2.2,<3')`, eggInfo],
    tools: ['ruff', 'pytest'],
  })
})

test('the setup shell command uses the fallback only on failure and preserves a dependency install failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-python-'))
  try {
    mkdirSync(join(dir, '.venv/bin'), { recursive: true })
    writeFileSync(join(dir, '.venv/bin/python'), [
      '#!/bin/sh',
      'printf "<%s>\\n" "$@" >> installs.log',
      'if [ "$4" = "-e" ]; then exit "$EDITABLE_STATUS"; fi',
      'exit "$DEPENDENCY_STATUS"',
    ].join('\n'), { mode: 0o755 })
    const projects = [
      {
        pyproject: '[build-system]\nrequires = ["setuptools"]\n[project]\nname = "app"\ndependencies = [\'numpy; sys_platform == "linux"\']\n',
        requirements: ['numpy; sys_platform == "linux"'],
      },
      {
        pyproject: '[build-system]\nbuild-backend = "poetry.core.masonry.api"\n[tool.poetry]\npackage-mode = false\n[tool.poetry.dependencies]\nnumpy = "^2.1"\npytest = "^8.0"\n',
        requirements: ['numpy>=2.1,<3', 'pytest>=8.0,<9'],
      },
    ]
    for (const { pyproject, requirements } of projects) {
      const { commands } = await pythonSetup(root({ 'pyproject.toml': pyproject, 'main.py': '', 'train.py': '' }))
      for (const [editableStatus, dependencyStatus, expectedStatus, expectedCalls] of [[0, 7, 0, 1], [1, 0, 0, 2], [1, 6, 6, 2]]) {
        writeFileSync(join(dir, 'installs.log'), '')
        const result = spawnSync('sh', ['-c', commands.slice(2).join(' && ') + ' && printf finished'], {
          cwd: dir,
          env: { ...process.env, EDITABLE_STATUS: String(editableStatus), DEPENDENCY_STATUS: String(dependencyStatus) },
          encoding: 'utf8',
        })
        assert.equal(result.status, expectedStatus, result.stderr)
        assert.equal(result.stdout, expectedStatus === 0 ? 'finished' : '')
        const log = readFileSync(join(dir, 'installs.log'), 'utf8')
        assert.equal(log.split('<-m>').length - 1, expectedCalls)
        for (const requirement of requirements) assert.equal(log.includes(`<${requirement}>`), expectedCalls === 2)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
