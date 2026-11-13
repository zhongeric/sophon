import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { profiles, staticFindings, triage, triageLine } from '../src/core/profiles.ts'
import { guideFiles } from '../src/core/roles.ts'

const diff = `diff --git a/docs/guide.md b/docs/guide.md
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,2 +1,3 @@
 # Guide
+++ e.g. a counter
 End
diff --git a/src/Vault.sol b/src/Vault.sol
new file mode 100644
--- /dev/null
+++ b/src/Vault.sol
@@ -0,0 +1,14 @@
+// SPDX-License-Identifier: MIT
+pragma solidity ^0.8.28;
+
+import "./IVault.sol";
+import {Math} from "./Math.sol";
+
+contract Vault {
+    function pull(uint256 amount) external {
+        require(tx.origin == owner, "not owner");
+        unchecked {
+            total -= amount;
+        }
+        // total is below the cap, so it cannot overflow
+        unchecked { total += 1; }
diff --git a/test/Vault.t.sol b/test/Vault.t.sol
--- a/test/Vault.t.sol
+++ b/test/Vault.t.sol
@@ -10,3 +10,6 @@ contract VaultTest is Test {
     function setUp() public {}
+    function test_pull_revertsWhenNotOwner() public {}
+    function test_Pull_WhenLocked_WhenPaused_revertsWithLocked() public {}
+    function testStuff() public {}
     function helper() internal {}
`

test('static rules check only added lines, in the files of the profiles that govern them', () => {
  const changed = ['docs/guide.md', 'src/Vault.sol', 'test/Vault.t.sol', 'out/Vault.json', '.env', '.env.example', 'logs/run.log']
  const found = staticFindings(diff, changed, profiles).map((finding) => `${finding.location} ${finding.severity} ${/host rule ([\w-]+)/.exec(finding.trigger)?.[1] ?? finding.title}`)
  assert.deepEqual(found, [
    'out/Vault.json:1 medium Remove out/Vault.json from the change',
    '.env:1 high Remove .env from the change',
    'logs/run.log:1 medium Remove logs/run.log from the change',
    'docs/guide.md:2 low docs-latin',
    'src/Vault.sol:2 medium sol-floating-pragma',
    'src/Vault.sol:4 low sol-wildcard-import',
    'src/Vault.sol:9 medium sol-revert-string',
    'src/Vault.sol:9 high sol-tx-origin',
    'src/Vault.sol:10 low sol-unchecked-reason',
    'test/Vault.t.sol:13 low sol-test-name',
  ])
  const pragma = staticFindings(diff, changed, profiles).find((finding) => finding.location === 'src/Vault.sol:2')!
  assert.equal(pragma.evidence, 'pragma solidity ^0.8.28;')
})

const supportDiff = `diff --git a/script/Deploy.s.sol b/script/Deploy.s.sol
new file mode 100644
--- /dev/null
+++ b/script/Deploy.s.sol
@@ -0,0 +1,8 @@
+pragma solidity ^0.8.28;
+import "forge-std/Script.sol";
+import  {Script} from "forge-std/Script.sol";
+contract Deploy is Script {
+    /// @dev Uses msg.sender, never tx.origin
+    function run() external { require(tx.origin != address(0), "no origin"); // tx.origin
+        selfdestruct(payable(msg.sender));
+    }
diff --git a/test/My Vault.t.sol b/test/My Vault.t.sol
new file mode 100644
--- /dev/null
+++ b/test/My Vault.t.sol\t
@@ -0,0 +1,7 @@
+pragma solidity ^0.8.28;
+import "forge-std/Test.sol";
+    // require(ok, "quoted in a comment")
+    require(tx.origin == owner, "not owner"); selfdestruct(payable(owner));
+    unchecked { total += 1; }
+    assembly { mstore(0, 0) }
+    function testStuff() public {}
diff --git a/docs/café.md b/docs/café.md
new file mode 100644
--- /dev/null
+++ b/docs/café.md
@@ -0,0 +1 @@
+e.g. a cafe
`

test('tests and scripts use only pragma, named import and test name rules, with raw Unicode paths and tabs', () => {
  assert.equal(supportDiff.includes('+++ b/test/My Vault.t.sol\t\n'), true)
  assert.equal(supportDiff.includes('+++ b/docs/café.md\n'), true)
  const found = staticFindings(supportDiff, [], profiles).map((finding) => `${finding.location} ${finding.severity} ${/host rule ([\w-]+)/.exec(finding.trigger)?.[1]}`)
  assert.deepEqual(found, [
    'script/Deploy.s.sol:1 medium sol-floating-pragma',
    'script/Deploy.s.sol:2 low sol-wildcard-import',
    'test/My Vault.t.sol:1 medium sol-floating-pragma',
    'test/My Vault.t.sol:2 low sol-wildcard-import',
    'test/My Vault.t.sol:7 low sol-test-name',
    'docs/caf\u00e9.md:1 low docs-latin',
  ])
})

test('contract rules preserve quoted comment delimiters and code after closed block comments', () => {
  const lines = [
    'require(keccak256(bytes(url)) == keccak256(bytes("https://example.com")), "bad URL");',
    'string memory url = "https://example.com"; tx.origin; selfdestruct(payable(owner));',
    String.raw`string memory note = "escaped \" // /* text */"; tx.origin;`,
    String.raw`string memory note = 'escaped \' // /* text */'; selfdestruct(payable(owner));`,
    '/* note */ selfdestruct(payable(owner));',
    '/* note */ require(tx.origin == owner, "not owner");',
    '// require(tx.origin == owner, "not owner"); selfdestruct(payable(owner));',
    '/* require(tx.origin == owner, "not owner"); selfdestruct(payable(owner));',
    ' * selfdestruct(payable(owner));',
    ' */ string memory url = "https://example.com"; // tx.origin; selfdestruct(payable(owner));',
    '/* note */ /* another note */ tx.origin;',
  ]
  const patch = ['diff --git a/src/Vault.sol b/src/Vault.sol', '--- a/src/Vault.sol', '+++ b/src/Vault.sol', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
  const found = staticFindings(patch, [], profiles).map((finding) => `${finding.location} ${/host rule ([\w-]+)/.exec(finding.trigger)?.[1]}`)
  assert.deepEqual(found, [
    'src/Vault.sol:1 sol-revert-string',
    'src/Vault.sol:2 sol-tx-origin',
    'src/Vault.sol:2 sol-selfdestruct',
    'src/Vault.sol:3 sol-tx-origin',
    'src/Vault.sol:4 sol-selfdestruct',
    'src/Vault.sol:5 sol-selfdestruct',
    'src/Vault.sol:6 sol-revert-string',
    'src/Vault.sol:6 sol-tx-origin',
    'src/Vault.sol:11 sol-tx-origin',
  ])
})

test('contract rules check code after multiline comments and multiplication continuations', () => {
  const lines = [
    ' */ require(tx.origin == owner, "not owner"); selfdestruct(payable(owner));',
    'uint256 total = amount',
    ' * uint160(tx.origin);',
    '/* a comment with an unmatched " quote',
    ' * require(tx.origin == owner, "not owner");',
    'selfdestruct(payable(owner));',
    ' */ revert("closed comment"); selfdestruct(payable(owner));',
    'uint256 other = amount',
    ' * /* rate */ uint160(tx.origin);',
  ]
  const patch = ['diff --git a/src/Vault.sol b/src/Vault.sol', '--- a/src/Vault.sol', '+++ b/src/Vault.sol', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
  const found = staticFindings(patch, [], profiles).map((finding) => `${finding.location} ${/host rule ([\w-]+)/.exec(finding.trigger)?.[1]}`)
  assert.deepEqual(found, [
    'src/Vault.sol:1 sol-revert-string',
    'src/Vault.sol:1 sol-tx-origin',
    'src/Vault.sol:1 sol-selfdestruct',
    'src/Vault.sol:3 sol-tx-origin',
    'src/Vault.sol:7 sol-revert-string',
    'src/Vault.sol:7 sol-selfdestruct',
    'src/Vault.sol:9 sol-tx-origin',
  ])
})

test('contract rules track block comments through context lines, but not deleted lines or separate hunks', () => {
  const patch = [
    'diff --git a/src/Vault.sol b/src/Vault.sol', '--- a/src/Vault.sol', '+++ b/src/Vault.sol',
    '@@ -10,3 +10,5 @@',
    ' /* note',
    '+ * tx.origin;',
    '  */',
    '-/* removed comment',
    '+require(tx.origin == owner, "not owner");',
    '+/* another comment',
    '@@ -30,0 +32,1 @@',
    '+selfdestruct(payable(owner));',
  ].join('\n')
  const found = staticFindings(patch, [], profiles).map((finding) => `${finding.location} ${/host rule ([\w-]+)/.exec(finding.trigger)?.[1]}`)
  assert.deepEqual(found, [
    'src/Vault.sol:13 sol-revert-string',
    'src/Vault.sol:13 sol-tx-origin',
    'src/Vault.sol:32 sol-selfdestruct',
  ])
})

test('static rules of a profile apply only when the profile matched', () => {
  const docsOnly = profiles.filter((profile) => profile.id === 'docs')
  assert.deepEqual(staticFindings(diff, [], docsOnly).map((finding) => finding.location), ['docs/guide.md:2'])
})

const repo = (...files: string[]) => async (path: string) => files.includes(path)

test('triage takes the light loop only when every changed file is docs or tests of a matched profile', async () => {
  const foundry = repo('foundry.toml')
  const typescript = repo('package.json', 'tsconfig.json')
  const path = async (changed: string[], exists = repo(), full = false) => {
    const result = await triage(changed, exists, full)
    return `${result.path} ${result.reason}${result.files.length ? ` ${result.files.join(',')}` : ''}`
  }
  assert.equal(await path(['README.md', 'docs/a.md']), 'light docs-or-tests-only')
  assert.equal(await path(['test/Vault.t.sol', 'README.md'], foundry), 'light docs-or-tests-only')
  assert.equal(await path(['src/Vault.sol', 'test/Vault.t.sol'], foundry), 'full not-docs-or-tests src/Vault.sol')
  assert.equal(await path(['script/Deploy.s.sol'], foundry), 'full not-docs-or-tests script/Deploy.s.sol')
  assert.equal(await path(['test/Vault.t.sol']), 'full not-docs-or-tests test/Vault.t.sol')
  assert.equal(await path(['src/a.test.ts', 'test/support/b.ts'], typescript), 'light docs-or-tests-only')
  assert.equal(await path(['src/a.ts', 'src/a.test.ts', 'package.json'], typescript), 'full not-docs-or-tests src/a.ts,package.json')
  assert.equal(await path(['src/Vault.sol', 'README.md'], foundry), 'full not-docs-or-tests src/Vault.sol')
  assert.equal(await path(['src/a.ts', 'test/a.ts'], typescript), 'full not-docs-or-tests src/a.ts')
  assert.equal(await path(['src/commands/test/run.ts', 'packages/test/src/index.ts'], typescript), 'full not-docs-or-tests src/commands/test/run.ts,packages/test/src/index.ts')
  assert.equal(await path(['packages/x/test/a.ts', 'src/__tests__/b.ts', 'tests/c.ts'], typescript), 'light docs-or-tests-only')
  assert.equal(
    await path(['agents/patch.md', 'AGENTS.md', 'pkg/CLAUDE.md', 'CONTRIBUTING.md', 'docs/a.md']),
    'full not-docs-or-tests agents/patch.md,AGENTS.md,pkg/CLAUDE.md,CONTRIBUTING.md',
  )
  assert.equal(await path(['README.md'], repo(), true), 'full full-asked')
  assert.equal(await path([]), 'full empty-diff')
})

test('triage records the matched profiles and the guides of the profiles that govern a changed file', async () => {
  const result = await triage(['README.md', 'test/Vault.t.sol'], repo('foundry.toml', 'package.json'), false)
  assert.deepEqual(result.profiles, ['solidity', 'solidity-support', 'docs'])
  assert.deepEqual(result.guides, ['profiles/solidity.md'])
  assert.equal(triageLine(result), 'TRIAGE path=light reason=docs-or-tests-only profiles=solidity,solidity-support,docs')
  assert.deepEqual((await triage(['contracts/Vault.sol'], repo(), false)).guides, [])
  assert.deepEqual((await triage(['foundry.toml'], repo('foundry.toml'), false)).guides, [])
  assert.deepEqual((await triage(['README.md'], repo('foundry.toml'), false)).guides, [])
  const many = await triage(['a.json', 'b.json', 'c.json', 'd.json', 'e.json', 'f.json', 'g.json'], repo(), false)
  assert.equal(triageLine(many), 'TRIAGE path=full reason=not-docs-or-tests files=a.json,b.json,c.json,d.json,e.json,+2 profiles=docs')
})

test('every guide file exists, and the Worker bundles it', () => {
  const bundle = readFileSync(new URL('../src/cloudflare/guides.ts', import.meta.url), 'utf8')
  for (const file of guideFiles) {
    assert.ok(existsSync(new URL(`../agents/${file}`, import.meta.url)), `agents/${file} does not exist`)
    assert.ok(bundle.includes(`'${file}':`), `src/cloudflare/guides.ts does not bundle ${file}`)
  }
})
