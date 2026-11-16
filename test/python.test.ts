import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RootFiles } from '../src/core/profiles.ts'
import { parseRequirement, parseToml, poetryConstraint, pythonDependencies, requirementsFile } from '../src/core/python.ts'

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
  const cases: [string, string][] = [
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
    ['^8.0.0rc1', '>=8.0.0rc1,<9'],
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
    main: [
      { name: 'requests', constraint: '>=2' },
      { name: 'numpy', constraint: '>=2.1,<3' },
      { name: 'pandas', constraint: '' },
    ],
    extras: { dev: [{ name: 'pytest', constraint: '>=8' }], docs: [{ name: 'sphinx', constraint: '' }] },
    groups: [
      { name: 'ruff', constraint: '==0.6.*' },
      { name: 'pytest', constraint: '' },
      { name: 'black', constraint: '' },
      { name: 'mypy', constraint: '>=1.10,<1.11' },
    ],
  })
  assert.equal((await pythonDependencies(root({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' })))?.installable, false)
  assert.equal(await pythonDependencies(root({ 'pyproject.toml': '[project\n', 'requirements.txt': 'ruff\n' })), null)
})
