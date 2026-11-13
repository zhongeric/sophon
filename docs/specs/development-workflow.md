# Spec: the development workflow

Status: draft. All decisions in section 8 made on 2026-11-13. Date: 2026-11-13.

This spec defines the second workflow of agent-factory: from a confirmed ask to a PR that is ready for Eric's
review. It also defines **profiles**, the mechanism that lets one workflow apply Eric's different rules for
Solidity, backend, frontend and other work.

Requirement IDs (`ALL-012`, `SOL-052`, and so on) refer to `docs/specs/requirements-catalog.json`. That file
holds 205 requirements extracted from Eric's skills, rules and repository configs, each with its sources.

## 1. Sources

| Source | Role in this spec |
| --- | --- |
| `~/.claude/skills/ship-quality-code` | The master map: lifecycle steps 0 to 14, roles, approval rules, checklists. This spec follows its order. |
| `~/.claude/skills/implementation-workflow` | Plan and build: confirmed ask, four plan components, lazy first draft, split, freeze. |
| `~/.claude/skills/code-review-loop` | The review sub-workflow. agent-factory already runs it. |
| `~/.claude/skills/auditor-workflow` | The Solidity security sub-workflow. Phase 2 of this spec. |
| `~/.claude/rules/*`, `~/uniswap/evm-cortex` | Solidity style, security, testing and deploy rules. |
| `~/.claude/CLAUDE.md` | STE writing rules. |
| Repo configs (`protocol-audit-hub`, `twap-auction`, `prospectus`, `tree-exploration`) | The only backend and frontend conventions that exist today. |

What the catalog shows:

- Solidity is fully specified (88 requirements). Backend has 5 and frontend has 12, and most of those come from
  team repos, not from Eric. Section 9 lists the gaps.
- 140 of the 205 requirements are checkable by a program. The host enforces those. The other 65 are judgment,
  and they go into role guidelines.
- 27 conflicts exist between sources. Section 8 lists the ones that need a decision.

## 2. Principles

These come from the review loop, and they hold here too.

1. **The flow is code.** The host decides what runs next. No agent decides the next stage.
2. **A rule that a program can check is a rail, not a prompt.** Guidelines carry only judgment.
3. **Context isolation.** The agent that wrote code never reviews it (`ALL-037`). One builder session per task,
   with follow-ups to the same session (`ALL-024`).
4. **Eric's approvals come from Eric.** The host accepts a go, a waiver or an answer only from an allowed login,
   through a signed webhook or the admin route. An agent can never relay one (`ALL-079`).
5. **Quiet until there is a PR or a blocker** (`ALL-022`). The host posts questions, blockers and the result.
   Agents post nothing (`ALL-085`, `ALL-086`).
6. **One workflow, many stacks.** Stack differences live in profiles (section 4), never in forks of the workflow.

## 3. The lifecycle

The host runs steps 0 to 9 of `ship-quality-code`. Steps 10 to 14 (dry run, Eric's go, broadcast, live verify,
records) become a separate deploy workflow later (section 10).

```
0 Intake ─▶ 1 Spec (larger changes) ─▶ 2 Plan ─▶ 3 Triage ─▶ Build ─▶ Split
  ─▶ 4 Freeze ─▶ 5 Review loop (light or full, x1 or x2) ─▶ 6 Auditor (Solidity src/)
  ─▶ 7 PR hygiene ─▶ 8 CI green ─▶ 9 Ready for Eric (Eric merges)
```

Each stage below lists who does the work, what the host enforces, and where Eric takes part.

### 0. Intake

- **Who:** the host, with the questions agent that the review loop already has.
- **Input:** Eric's ask, from `npm run remote -- develop <repo> "<ask>"`, a GitHub issue that Eric labels, or a
  `/develop` comment.
- **Work:** record the ask verbatim (`ALL-001`). A read-only intake agent reads the repo and the ask, and lists the
  open questions and product calls, each with a recommendation (`ALL-006`). It explores the code first instead of
  asking what the code answers.
- **Rails:** no plan and no code until the ask is **confirmed** (`ALL-010`). Confirmation is Eric's `/answer` to the
  intake questions, or `/confirm` when there are none. The host records which stack profiles apply (section 4).
- **Eric:** answers the intake questions. Small hotfixes can skip confirmation when Eric marks them so (`ALL-004`).

### 1. Spec, for larger changes

- **Who:** a spec agent (the PM role in `ship-quality-code`). Read-only.
- **When:** the intake marks the ask as a larger change, or Eric says "start with a spec" (`ALL-007`, `ALL-008`).
- **Output:** a short spec with edge cases, every product surface, out-of-scope items, and the PM decisions that Eric
  can overrule. The host posts it, and the run pauses for Eric's review when he asked for one.

### 2. Plan

- **Who:** a planner agent on the strongest writer model (`ALL-011`). Read-only.
- **Output, through a checked submit tool:** smallest change, goals, non-goals, and done-looks-like (`ALL-012`).
  Done-looks-like is a list of acceptance checks. Each check is a command (a test, a typecheck, a CI job) or a
  statement that the intent reviewer verifies later.
- **Rails:** the host refuses a plan without all four parts, or with a done-looks-like that has no checkable item.
  Profiles add plan sections. For example, a Solidity plan must list interfaces before implementations and the
  deployment sequence (`SOL-003`).
- **Decision for Eric:** the skill says "all four, in parallel". This spec proposes one planner that writes all four
  in one output, because the four constrain each other. Four parallel agents can disagree on scope. See D7.

### 3. Triage

- **Who:** the host, with profile rules. There is no Jev (D1).
- **Rails:** the light loop applies when every matched profile allows it and the diff matches the profile's light
  rule, for example "docs or tests only, no behavior change". Else the full loop applies. Solidity `src/` always gets
  the full loop (`SOL-004`). The host writes `TRIAGE path=light reason=docs-only` (or `path=full reason=...`) in the gate
  log and the PR description. The host checks triage again at freeze (`ALL-017`).
- **Count of review passes** comes from the change type table in `ship-quality-code` step 5 and from Eric's words:
  "heavy" means x2 with several reviewers (`ALL-061`), "double loop" means x2 then Auditor (`ALL-062`), "no code
  review loop" is a waiver that only Eric can give (`ALL-005`).

### Build

- **Who:** one builder agent per task, with write access to a worktree and to a real machine (section 7).
- **Work:** a lazy first draft: the narrowest change that meets done-looks-like (`ALL-019`). It follows the repo's
  existing patterns (`ALL-021`) and the coding rules of every matched profile at full intensity (`ALL-018`). The
  builder gets the problem, the constraints and the done criteria, never line edits (`ALL-020`).
- **Rails:**
  - Protected paths (check config, CI workflows, the profile's own list) refuse writes, as in the review loop.
  - The host commits checkpoints when the builder asks, so new test files become runnable through `run_tests`.
  - Forbidden committed paths (`out/`, `cache/`, logs, broadcast dumps) fail the checkpoint (`ALL-067`).
  - Profile static rules run on every checkpoint (section 4.3). A violation goes back to the builder as a tool error.
  - No secrets in the builder's environment. The same allowlist as the checks applies.
- **CI:** the host pushes the branch, opens the PR as draft, and watches CI. A red CI goes back to the same builder
  session, inside a budget (section 9, G6). The host reports only the PR or a blocker.

### Split

- When the change spans frontend and backend, or two repos, the host opens one PR per repo, each with its own
  profiles, checks and review loop (`FE-001`). The intake records the split, so the plan covers both.

### 4. Freeze

- The host records the frozen package: verbatim ask, plan, triage, head SHA (`ALL-040`). It closes the builder
  session for this step. The review loop reads only the frozen package.

### 5. Review loop

- The existing review loop, with its pass count and light or full path from triage. It already has D1 (no Jev)
  and D3 (allowed models).

### 6. Auditor

- Required when any matched profile says so: Solidity `src/` (`SOL-052`). Phase 2 builds it as a sub-workflow with
  the PR-delta mode first, then Core and Thorough.

### 7. PR hygiene

- **Host checks, not agent checks:**
  - Review threads resolved, "N of N, 0 open" (`ALL-066`), through the GitHub API.
  - No excess output in the diff (`ALL-067`).
  - No leftover code the ask does not need: a Minimize finding in the final pass blocks.
  - No force-push on a shared branch.
- The PR changes from draft to ready only after PASS (`ALL-069`, D4).

### 8. CI green

- All checks pass on the head SHA. A flaky rerun needs no Eric. A fix that needs more token scope, for example in
  `.github/workflows`, goes to Eric as a blocker.

### 9. Ready for Eric

- The host posts the report: PR link, head SHA, triage line, review loop and Auditor verdicts with models per step,
  checks. It keeps "ready for human review" separate from "merge-ready" (`ALL-071`).
- The host never merges, except in repos where Eric gave standing permission (`ALL-073`).

## 4. Profiles

A **profile** is one stack's rules, in one place. The workflow asks the matched profiles for guidelines, policy,
checks and rails. Adding a stack means adding a profile, not changing the workflow.

### 4.1 What a profile holds

```ts
type Profile = {
  id: string                               // 'solidity', 'typescript-backend', 'nextjs-frontend', 'docs', ...
  match: { markers: string[]; paths: string[] }  // for example foundry.toml + src/**/*.sol
  guides: Partial<Record<RoleId, string[]>>     // guideline files per role, added to the shared ones
  policy: {
    lightPathAllowed: boolean              // Solidity src/: false
    reviewPasses(change: Change): 1 | 2    // Solidity: 2 for a larger feature set
    auditor: 'never' | 'always' | 'when-matched'
    planSections: string[]                 // extra required plan sections
  }
  checks: Record<string, Check>            // commands, as in .agent-factory.json today
  tests: { pattern: string; command: string; naming?: string }  // naming is a regex the host checks
  rails: {
    protect: string[]                      // paths agents cannot write
    forbiddenInDiff: string[]              // paths that fail a checkpoint: out/, cache/, broadcast/
    staticRules: StaticRule[]              // section 4.3
  }
  machine: { image: string }               // the toolchain for builds and tests (section 7)
}
```

Profiles live in agent-factory (`profiles/<id>.ts` and `agents/profiles/<id>/*.md`). A repo can override fields in
`.agent-factory.json` on its base branch, so a PR cannot change its own rules.

### 4.2 Resolution

- Each changed file matches zero or more profiles. A monorepo matches per package (G8).
- When several profiles match, the **strictest value wins** on each field:
  - the light path is allowed only when every profile allows it,
  - the review pass count and the Auditor take the maximum,
  - guides, checks, protected paths and static rules are the union.
- Precedence, from strongest: Eric's words for this task ("heavy", "double loop", a waiver) > the repo config on the
  base branch > the profile > global defaults. A waiver is valid only from Eric (principle 4).

### 4.3 Static rules

Many of Eric's Solidity rules are mechanical. The host checks them on every builder checkpoint and every patch
commit, before any reviewer sees the code. Reviewers then spend their judgment on what a program cannot check.

| Rule | Check | Catalog |
| --- | --- | --- |
| Fixed pragma | no `pragma solidity ^` or `>=` in `src/` | `SOL-007` |
| Custom errors only | no `require(..., "...")` | `SOL-011` |
| Named imports | no `import "..."` without braces | `SOL-008` |
| Forbidden constructs | no `tx.origin` auth, `selfdestruct`, `abi.encodePacked` with dynamic types | `SOL-023` |
| NatSpec on public and external | the evm-cortex `natspec-enforcer` logic | `SOL-016` |
| Test names | plain `^test_[a-z][A-Za-z0-9]*_[a-z][A-Za-z0-9]*$`, or branching tree `^test_[A-Z][A-Za-z0-9]*(_(When\|Given)[A-Z][A-Za-z0-9]*)+_(succeeds\|revertsWith[A-Z][A-Za-z0-9]*)$`, and the same shapes for `testFuzz_` and `testFork_` (D9.1) | `SOL-042` |
| `unchecked` has a reason | a comment on the line before | `SOL-014` |
| No excess output | `forbiddenInDiff` globs | `ALL-067` |
| Builds clean | `forge build --deny-warnings`, `forge fmt --check` | `SOL-032` |

Your evm-cortex hooks already implement several of these checks, but `~/.claude/settings.json` does not enable them.
The profile can run the same code as host checks.

### 4.4 First profiles

| Profile | Matches | Policy | Checks | Notes |
| --- | --- | --- | --- | --- |
| `solidity` | `foundry.toml`, `src/**/*.sol` | no light path, x2 for a larger feature set, Auditor always, plan sections: interfaces, deployment sequence | `forge build`, `forge fmt --check`, `forge test --match-path`, coverage in CI | Style from D9. No gas check unless the ask is about gas. |
| `solidity-support` | `test/**/*.sol`, `script/**/*.sol` | light path allowed, except deploy scripts: review loop on every change (`SOL-054`) | same | Tests and scripts in a Foundry repo. |
| `typescript` | `package.json` + `tsconfig.json` | light path allowed | typecheck, lint, tests of changed files | Thin. Needs G1 and G3. |
| `nextjs-frontend` | `next.config.*` | light path allowed | typecheck, lint, build | App Router rules (`FE-009`), UI copy rules. Needs G2. |
| `docs` | `**/*.md` outside code | light path, STE and anti-slop only | none | |
| `ci-infra` | `.github/**` | full loop, Eric approves the merge | none | Token scope often blocks these (step 8). |

## 5. Roles

| Role | Model | Access | Output (checked by the host) |
| --- | --- | --- | --- |
| Intake | strongest writer | read-only | questions with options and a recommendation |
| Spec (PM) | strongest writer | read-only | spec with edge cases, surfaces, out of scope, overrulable decisions |
| Planner | strongest writer (`ALL-011`) | read-only | the four plan parts, done-looks-like with checkable items |
| Builder | an allowed model (`ALL-058`) | write to the worktree, `run_tests`, `checkpoint` | commits, and a build log with what changed and why |
| Review loop roles | as the loop defines them | as today | as today |
| Auditor roles (phase 2) | different models for variance | read-only, PoC tests only | threads, PoCs, findings |

Every role gets the shared guidelines, the guidelines of its matched profiles, and the STE rules where it writes
text that ships (`ALL-080`).

## 6. Where Eric takes part

| Moment | Why | Channel |
| --- | --- | --- |
| Intake questions and confirmation | product calls are his (`ALL-006`) | PR or issue comment, or the terminal |
| Spec review, when he asked for one | `ALL-009` | same |
| Held findings in the gate | decisions only he can make (A2) | same |
| Blockers | token scope, missing secrets, failed budgets | same |
| Merge | `ALL-073` | GitHub |
| Any paid, external or mainnet action | `ALL-079` | a `/go` that names the exact scope, deploy workflow only |

Everything else runs without him.

## 7. Platforms

The builder needs a real toolchain: `forge`, `node`, package installs. The review loop does not.

- **Local (Node):** works today. The builder uses a git worktree and runs commands on this machine, with the trust
  limits in the README.
- **Cloudflare:** the brain stays in the Durable Object. The builder's tools run on a machine attached to the run:
  - a Cloudflare Container per run, through nanocode-ts `sandbox/cloudflare`, with one image per profile (Foundry,
    Node), or
  - a hand on a build box (`nc hand`).
  
  The Container is the default proposal: no machine to keep running, and code under review never runs beside
  secrets. It needs Docker images for each profile and Cloudflare Containers on the account.

## 8. Decisions for Eric

Each decision lists the conflict, the sources, the recommendation and the status.

| # | Conflict | Recommendation | Status |
| --- | --- | --- | --- |
| D1 | **Jev keep rule.** `code-review-loop/references/jev-gate.md` keeps only `is_critical >= 0.75` (`ALL-052`). `ship-quality-code` says Jev is a noise filter, keeps findings of any severity when impact `>= 0.6` or the quality questions average `>= 0.6`, and uses severity for order only (`ALL-053`). agent-factory implements the first. | Use `ship-quality-code`. It is the newer, more specific text. Update the gate before the next real run. | **Decided: no Jev.** The evidence check filters. Patch agents apply or reject every finding. A rejected critical or high finding goes to Eric. Reviewers mark findings that need his decision. Built. |
| D2 | **Evidence track.** Four tracks with the evidence rule in each, or a fifth Evidence reviewer. | Keep four tracks. The host's evidence check (real quotes at real lines) is stronger than a fifth agent. | **Decided:** four tracks, the evidence rule in each, checked by the host. |
| D3 | **Models.** Allowed: Fable, Opus 5.5, Sol (`ALL-058`). agent-factory's defaults use Sonnet for two roles, which is not allowed. Only Sol is another family. | Step 1 on Fable and Opus 5.5 (split across tracks for variance), Step 2 on Sol. Remove Sonnet. Which Fable version? | **Decided: Fable 5.2, Opus 5.5, Sol.** Step 1: Bugs on Fable 5.2, Rules on Sol, Minimize, Anti-slop and Patch on Opus 5.5. Each step 2 role swaps family. The host refuses other models. Built. |
| D4 | **Draft during review.** "Never draft" against "draft until PASS". | Draft while the run works, ready after PASS. | **Decided:** draft during review, ready after PASS. |
| D5 | **Audit-fix PRs in `src/`.** "Two passes" against the full Solidity carve-out. | The stricter Solidity carve-out wins. | **Decided:** the Solidity carve-out wins for fixes in `src/`. |
| D6 | **Local test scope.** The loop runs touched tests only. The cortex rules want the full suite, Slither and coverage before every PR. | Touched tests locally, the full suite in CI. Make the cortex pre-PR list a CI requirement of the `solidity` profile. | **Decided:** touched tests locally. CI runs the full suite and the cortex pre-PR list. |
| D7 | **Plan in parallel.** "All four, in parallel" against one consistent plan. | One planner writes all four parts in one checked output. | **Decided:** one planner, one checked output with all four parts. |
| D8 | **TDD against lazy draft.** The cortex says tests first. `implementation-workflow` says lazy first draft. | The draft includes its tests, and done-looks-like names them. Bug fixes start with a failing test (the evm-cortex bug-fix flow). | **Decided:** the draft includes its tests. Bug fixes start with a failing test. |
| D9 | **Solidity style conflicts.** Test names (three schemes), error names (`ManagerLocked` or `Oracle_StalePrice`), event tense, immutable case, pinned compiler (0.8.24, 0.8.26, 0.8.28), NatSpec on internal functions, coverage (90% or 100%), ReentrancyGuard scope (all external calls or value paths only). | One precedence rule: repo rules > `~/.claude/rules/solidity-style-guide.md` > evm-cortex agent templates. Then the profile takes its values from the style guide, and a repo can override in its config. | **Decided**, see the D9 picks below. In `agents/shared/solidity.md` now. |
| D10 | **Questions at once or one at a time.** The loop batches. The grilling skills ask one at a time. | Batch per stage. On an async channel, each round trip costs minutes or hours. | **Decided:** one batch of questions per stage. |
| D11 | **`~/.claude/commands/auto-spec.md`** never asks Eric and skips every review. | Retire it, or never route to it. It breaks the approval rules. | **Decided and done:** renamed to `auto-spec.md.retired`. |

### D9 picks

| # | Topic | Pick |
| --- | --- | --- |
| 1 | Test names | Plain tests: `test_{action}_{scenario}` (`test_swap_revertsWhenAmountIsZero`). Branching tree tests: an underscore between branches, `test_{Function}_{WhenCondition}[_{WhenCondition}...]_{outcome}`, outcome `succeeds` or `revertsWith{Error}` (`test_Swap_WhenLocked_revertsWithManagerLocked`). |
| 2 | Error names | Descriptive PascalCase, no module prefix (`ManagerLocked`). |
| 3 | Event names | Past tense (`Deposited`, `FeeUpdated`). Existing repos keep their style. |
| 4 | Immutables | camelCase (`poolManager`). |
| 5 | Compiler | Fixed everywhere, at the version that the repo's `foundry.toml` pins. |
| 6 | NatSpec | Full on the interface, `@inheritdoc` on implementations, internal and private functions get `@dev` only when needed. |
| 7 | Coverage | 90% line, 80% branch, 95% function, in CI. Repos can raise it. |
| 8 | ReentrancyGuard | Not needed when the code follows checks-effects-interactions. Use it sparingly, only where that pattern cannot hold. |
| 9 | Gas | No gas check or gas findings unless the ask is about gas. |
| 10 | Layout | using, structs and enums, constants, immutables, state, events, errors, modifiers, constructor, external, public, internal, private. View and pure last inside each visibility group. |
| 11 | Imports | Named imports everywhere, also in tests and PoCs. |

## 9. Gaps

No source defines these. Each has a proposed default that Eric can replace.

| # | Gap | Proposed default |
| --- | --- | --- |
| G1 | Backend tests: framework, coverage, integration tests | Tests next to the code. Every behavior change has a test. Integration tests for external interfaces. No coverage number until Eric sets one. |
| G2 | Frontend tests: component, e2e, accessibility | Typecheck, lint and build in the profile. Component tests for logic. No e2e by default. |
| G3 | Backend conventions: API shape, errors, logging, config, migrations | Follow the repo. Validate external input at the boundary (from `protocol-audit-hub`). Additive migrations first. |
| G4 | A security path for non-Solidity code | Dependency and secret scans as host checks in the `typescript` profile. A focused security track in the review loop for auth and data paths. |
| G5 | Frontend and backend deploys | Out of scope until the deploy workflow. The PR is the end of this workflow. |
| G6 | Budgets: CI-fix rounds, review rounds, cost | Two CI-fix rounds, then a blocker. The pass count from triage, then FAIL. A cost budget per run, recorded in the report. |
| G7 | Where the frozen package and notes live | The PR description, written by the host, plus the run ledger. |
| G8 | Mixed-stack monorepos | Profiles match per package. Each package's strictest policy applies to its files. |
| G9 | Docs, config and CI changes | `docs` and `ci-infra` profiles (section 4.4). |
| G10 | Accessibility and i18n | None until Eric defines them. |

## 10. Build plan

| Phase | Scope | Exit |
| --- | --- | --- |
| 0 | Review loop matches D1 and D3 (done). Next: the light loop for docs and tests only changes. | A real run on one of Eric's PRs. |
| 1 | Profiles in code. Intake, plan, build, freeze, review loop, hygiene, CI, ready PR, on the local platform. Profiles `solidity`, `solidity-support`, `typescript`, `docs`. | A small real feature from ask to ready PR. |
| 2 | The Auditor as a sub-workflow, PR-delta mode first. | A Solidity change with the review loop and the Auditor. |
| 3 | The builder on Cloudflare, through a Container per run. | The phase 1 feature, run from `npm run remote`. |
| 4 | The deploy workflow: dry run, Eric's `/go` for an exact scope, broadcast in chunks with a progress file, live verify, record. | A testnet deploy. |
