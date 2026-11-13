# Spec: the development workflow

Status: phases 0, 1 and 3 are built (section 10). Phases 2 and 4 are not built yet.

This spec defines the second workflow of agent-factory: from a confirmed ask to a PR that is ready for the user's
review. It also defines **profiles**, the mechanism that lets one workflow apply different rules for Solidity,
backend, frontend and other work.

"The user" in this spec is the person who owns the work: that person gives the ask, answers the questions and
merges. On GitHub, the user is a login in `ALLOWED_USERS` or in the `answerers` of the repository config.

## 1. Scope

The workflow follows one lifecycle for every change: intake, spec, plan, build, freeze, review, audit, PR hygiene, CI
and a ready PR (section 3). The code review loop that agent-factory already runs is step 5 of this lifecycle.

The rules of the lifecycle are of two types:

- Rules that a program can check. The host enforces them, for example the plan parts, the write scope of a builder,
  the static rules of a profile and the forbidden paths.
- Rules that need judgment. They go into the role guidelines in `agents/`.

Solidity has the most rules. Backend and frontend have few rules today. Section 9 lists the gaps and the defaults
that apply until the user replaces them. Section 8 records the decisions where two rules disagreed.

## 2. Principles

These come from the review loop, and they hold here too.

1. **The flow is code.** The host decides what runs next. No agent decides the next stage.
2. **A rule that a program can check is a rail, not a prompt.** Guidelines carry only judgment.
3. **Context isolation.** The agent that wrote code never reviews it. One builder session per task, with
   follow-ups to the same session.
4. **The user's approvals come from the user.** The host accepts a go, a waiver or an answer only from an allowed
   login, through a signed webhook or the admin route. An agent can never relay one.
5. **Quiet until there is a PR or a blocker.** The host posts questions, blockers and the result. Agents post
   nothing.
6. **One workflow, many stacks.** Stack differences live in profiles (section 4), never in forks of the workflow.

## 3. The lifecycle

The host runs steps 0 to 9. Steps 10 to 14 (dry run, the user's go, broadcast, live verify, records) become a
separate deploy workflow later (section 10).

```
0 Intake ─▶ 1 Spec (larger changes) ─▶ 2 Plan ─▶ 3 Triage ─▶ Build ─▶ Split
  ─▶ 4 Freeze ─▶ 5 Review loop (light or full, x1 or x2) ─▶ 6 Auditor (Solidity src/)
  ─▶ 7 PR hygiene ─▶ 8 CI green ─▶ 9 Ready for the user (the user merges)
```

Each stage below lists who does the work, what the host enforces, and where the user takes part.

### 0. Intake

- **Who:** the host, with a read-only intake agent.
- **Input:** the user's ask. Locally: `npm run develop -- --ask "<ask>"`. On Cloudflare: `npm run remote -- develop`,
  the `agent-develop` label on a GitHub issue, or a `/develop` comment.
- **Work:** record the ask verbatim. A read-only intake agent reads the repo and the ask, and lists the open
  questions and product calls, each with a recommendation. It explores the code first instead of asking what the
  code answers.
- **Rails:** no plan and no code until the ask is **confirmed**. The host adds three questions to the intake agent's
  batch: "Is this the ask?" with the agent's summary, a spec or not, and one or two review passes, each with the
  agent's recommendation and reason (P4). The user's `/answer` to that one batch is the confirmation. A
  free-text correction of the summary goes on, as a decision for the planner. The host records which stack profiles
  apply (section 4).
- **The user:** answers the intake questions. A small hotfix can skip the confirmation when the user marks it so
  (`--hotfix`).

### 1. Spec, for larger changes

- **Who:** a spec agent, in the role of a product manager. Read-only.
- **When:** the intake marks the ask as a larger change, or the user says "start with a spec".
- **Output:** a short spec with edge cases, every product surface, out-of-scope items, and the product decisions
  that the user can overrule. The host posts it, and the run pauses for the user's answers to its decisions.

### 2. Plan

- **Who:** a planner agent on the strongest writer model. Read-only.
- **Output, through a checked submit tool:** smallest change, goals, non-goals, and done-looks-like.
  Done-looks-like is a list of acceptance checks. Each check is a command (a test, a typecheck, a CI job) or a
  statement that the intent reviewer verifies later.
- **Rails:** the host refuses a plan without all four parts, or with a done-looks-like that has no checkable item.
  Profiles add plan sections. For example, a Solidity plan must list interfaces before implementations and the
  deployment sequence.
- **One planner, not four in parallel (D7).** Each part sets limits on the other parts.

### 3. Triage

- **Who:** the host, with profile rules. No model scores the change (D1).
- **Rails:** the light loop applies when every matched profile allows it and the diff matches the profile's light
  rule, for example "docs or tests only, no behavior change". Else the full loop applies.

  Solidity `src/` and `script/` always get the full loop.
  Agent prompts under `agents/` and rule files named `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING*` also get the full loop.
  The rule files can be at any directory level. Triage checks deleted paths and old paths of renames.

  The host writes `TRIAGE path=light reason=docs-or-tests-only` (or `path=full reason=...`) in the gate log and the PR description.
  The host checks triage again at freeze.
- **Light loop:** one context-free reviewer that also fixes, on Opus 5.5. It makes only anti-slop and STE fixes,
  and applies or rejects the host findings. The host refuses its writes outside docs and tests, so the change cannot
  grow into behavior. No step 2, no intent check. Checks must be green.
- **Count of review passes:**

  | Change | Review loop | Auditor |
  | --- | --- | --- |
  | Docs or tests only, per triage | light, x1 | no |
  | A feature in any stack | full, or light per triage, x1 at least | only for Solidity |
  | Solidity `src/`, also a merge resolution that touches it | full, x1 at least | always |
  | A larger Solidity feature set: a new module or strategy, parameters across many files, economic or tick math, or a new launch path | full, x2 with the model swap | always |
  | A deploy or broadcast script | full, on every change | a quick pass |
  | An audit-fix PR | x2 at least. A fix in Solidity `src/` gets the Solidity rows above (D5). | always |

  The user's words for one task come first: "heavy" means x2 with several reviewers, "double loop" means x2 and
  then the Auditor, and "no code review loop" is a waiver that only the user can give.

### Build

- **Who:** one builder agent per task, with write access to a worktree and to a real machine (section 7). The host
  runs the plan's tasks in waves: a task starts when its dependencies are merged, and tasks whose files do not
  overlap run at the same time, each on its own branch (`factory/task-<run>-<task>`) and worktree. The host merges
  each wave into the run's branch, `factory/dev-<slug>` (P3). A builder can start nanocode subagents for parts of
  its task. Only the builder checkpoints and submits.
- **Work:** a lazy first draft: the narrowest change that meets done-looks-like. It follows the existing patterns of
  the repo and the coding rules of every matched profile at full strength. The builder gets the problem, the
  constraints and the done criteria, never line edits.
- **Rails:**
  - A builder can write only the files and directories of its task, from the plan.
  - Protected paths (check config, CI workflows, the profile's own list) refuse writes, as in the review loop.
  - The host commits checkpoints when the builder asks, so new test files become runnable through `run_tests`.
  - Forbidden committed paths (`out/`, `cache/`, logs, broadcast dumps) fail the checkpoint.
  - Profile static rules run on every checkpoint (section 4.3). A violation goes back to the builder as a tool error.
  - No secrets in the builder's environment. The same allowlist as the checks applies.
- **CI:** the host pushes the branch, opens the PR as draft, and watches CI. A red CI goes back to a builder with the
  failure logs, inside a budget of two rounds (P5, G6). With one task, that is the same builder session. With
  several tasks, one fixer session gets the union of their files. The host reports only the PR or a blocker.

### Split

- When the change spans frontend and backend, or two repos, the host opens one PR per repo, each with its own
  profiles, checks and review loop. The intake records the split, so the plan covers both.

### 4. Freeze

- The host records the frozen package: verbatim ask, plan, triage, head SHA. It closes the builder session for this
  step. The review loop reads only the frozen package.

### 5. Review loop

- The existing review loop, with its pass count and light or full path from triage. The evidence check is its
  filter (D1), and it accepts only the allowed models (D3).

### 6. Auditor

- Required when any matched profile says so: Solidity `src/`. Phase 2 builds it as a sub-workflow with the
  PR-delta mode first, then Core and Thorough.

### 7. PR hygiene

- **Host checks, not agent checks:**
  - Review threads resolved, "N of N, 0 open", through the GitHub API.
  - No excess output in the diff.
  - No leftover code the ask does not need: a Minimize finding in the final pass blocks.
  - No force-push on a shared branch.
- The PR changes from draft to ready only after PASS (D4).

### 8. CI green

- All checks pass on the head SHA. A rerun of a flaky job needs no approval. A fix that needs more token scope, for
  example in `.github/workflows`, goes to the user as a blocker.

### 9. Ready for the user

- The host posts the report: PR link, head SHA, triage line, review loop and Auditor verdicts with models per step,
  checks. It keeps "ready for human review" separate from "merge-ready".
- The host never merges, except in repos where the user gave standing permission.

## 4. Profiles

A **profile** is one stack's rules, in one place. The workflow asks the matched profiles for guidelines, policy,
checks and rails. To add a stack, add a profile. Do not change the workflow.

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

Profiles live in agent-factory (`src/core/profiles.ts` and `agents/profiles/<id>.md`). A profile gives the default
checks, tests, setup and protected paths of its stack. A repo can override fields in `.agent-factory.json` on its base
branch. The host reads both from the base branch, so a PR cannot change its own rules.

The code has a part of this type now: `markers`, `files`, `light`, `guides`, `forbidden`, `rules` and `defaults` (the
checks, tests, setup and protected paths of the stack). The review loop uses them for triage, guides, host findings
and the repository config. Policy, checks, tests, protected paths, the machine and repo
overrides come with phase 1.

### 4.2 Resolution

- Each changed file matches zero or more profiles. A monorepo matches per package (G8).
- When several profiles match, the **strictest value wins** on each field:
  - the light path is allowed only when every profile allows it,
  - the review pass count and the Auditor take the maximum,
  - guides, checks, protected paths and static rules are the union.
- Precedence, from strongest: the user's words for this task ("heavy", "double loop", a waiver) > the repo config on
  the base branch > the profile > global defaults. A waiver is valid only from the user (principle 4).

### 4.3 Static rules

Many Solidity rules are mechanical. The host checks them on every builder checkpoint and every patch commit, before
any reviewer sees the code. Reviewers then spend their judgment on what a program cannot check.

| Rule | Check |
| --- | --- |
| Fixed pragma | no floating pragma in `src/**/*.sol`, `test/**/*.sol` or `script/**/*.sol` |
| Custom errors only | no `require(..., "...")` or `revert("...")` in `src/**/*.sol` |
| Named imports | no imports without braces in `src/**/*.sol`, `test/**/*.sol` or `script/**/*.sol` |
| Forbidden constructs | no `tx.origin` or `selfdestruct` in `src/**/*.sol`. Planned: `abi.encodePacked` with dynamic types |
| NatSpec on public and external | the logic of the evm-cortex `natspec-enforcer` hook |
| Test names in `test/**/*.sol` and `script/**/*.sol` | plain `^test_[a-z][A-Za-z0-9]*_[a-z][A-Za-z0-9]*$`, or branching tree `^test_[A-Z][A-Za-z0-9]*(_(When\|Given)[A-Z][A-Za-z0-9]*)+_(succeeds\|revertsWith[A-Z][A-Za-z0-9]*)$`, and the same shapes for `testFuzz_`, `testFork_` and `invariant_` (D9.1) |
| `unchecked` and `assembly` have a reason | a comment on the same line or the line before, in `src/**/*.sol` |
| No excess output | `forbiddenInDiff` globs |
| Builds clean | `forge build --deny-warnings`, `forge fmt --check` |

The hooks of [evm-cortex](https://github.com/ccashwell/evm-cortex) implement several of these checks. The profile
can run the same code as host checks.

The review loop runs these rules now, on the lines that each reviewed diff adds: fixed pragma, custom errors, named
imports, `tx.origin`, `selfdestruct`, test names, a reason before `unchecked` and `assembly`, and forbidden paths.
Solidity rules apply only when `foundry.toml` exists.
Tests and scripts use only the pragma, named import and test name rules.
The `docs` profile checks `.md`, `.mdx` and `.rst` files for Latin abbreviations.

Forbidden paths include `.log` and `.env` files in every repository, except `.env.example`, `.env.sample` and `.env.template`.
Foundry repositories also forbid `out/`, `cache/` and `broadcast/`.
Each break becomes a `host-NNN` finding of the rules track.

Not built yet: `abi.encodePacked` with dynamic types and NatSpec, because they need a Solidity parser.

### 4.4 First profiles

| Profile | Matches | Policy | Checks | Notes |
| --- | --- | --- | --- | --- |
| `solidity` | `foundry.toml`, `src/**/*.sol` | no light path, x2 for a larger feature set, Auditor always, plan sections: interfaces, deployment sequence | `forge build`, `forge fmt --check`, `forge test --match-path`, coverage in CI | Style from D9. No gas check unless the ask is about gas. |
| `solidity-support` | `test/**/*.sol`, `script/**/*.sol` | light path allowed, except deploy scripts: review loop on every change | same | Tests and scripts in a Foundry repo. |
| `typescript` | `package.json` + `tsconfig.json` | light path allowed | typecheck, lint, tests of changed files | Thin. Needs G1 and G3. |
| `nextjs-frontend` | `next.config.*` | light path allowed | typecheck, lint, build | App Router rules, UI copy rules. Needs G2. |
| `docs` | `.md`, `.mdx` and `.rst` files | light path, STE and anti-slop only, except agent prompts and rule files | none | `agents/**`, `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING*` always get the full loop. Triage includes deleted paths and old paths of renames. |
| `ci-infra` | `.github/**` | full loop, the user approves the merge | none | Token scope often blocks these (step 8). |

## 5. Roles

| Role | Model | Access | Output (checked by the host) |
| --- | --- | --- | --- |
| Intake | strongest writer | read-only | questions with options and a recommendation |
| Spec (product manager) | strongest writer | read-only | spec with edge cases, surfaces, out of scope, decisions that the user can overrule |
| Planner | strongest writer | read-only | the four plan parts, done-looks-like with checkable items |
| Builder | an allowed model (D3) | write to the worktree, `run_tests`, `checkpoint` | commits, and a build log with what changed and why |
| Review loop roles | as the loop defines them | as today | as today |
| Auditor roles (phase 2) | different models for variance | read-only, PoC tests only | threads, PoCs, findings |

Every role gets the shared guidelines, the guidelines of its matched profiles, and the STE rules where it writes
text that ships.

## 6. Where the user takes part

| Moment | Why | Channel |
| --- | --- | --- |
| Intake questions and confirmation | product calls belong to the user | PR or issue comment, or the terminal |
| Spec review, when the user asks for one | the spec makes product decisions | same |
| Held findings in the gate | decisions that only the user can make | same |
| Blockers | token scope, missing secrets, failed budgets | same |
| Merge | the user owns the merge | GitHub |
| Any paid, external or mainnet action | an agent never approves spend or a broadcast | a `/go` that names the exact scope, deploy workflow only |

Everything else runs without the user.

## 7. Platforms

The builder needs a real toolchain: `forge`, `node`, package installs. The review loop does not.

- **Local (Node):** the builder uses a git worktree and runs commands on this machine, with the trust limits in the
  README.
- **Cloudflare:** the brain stays in the Durable Object. The builder's tools run on a Cloudflare Container, one per
  run, attached to the run. Built in phase 3:
  - One `DevelopmentRuns` Durable Object per issue holds the ledger, the agent sessions, the GitHub token, and each
    branch as a tree in SQL with in-process git. Builders keep the in-process shell and the same rails as on the
    local platform.
  - The container only runs commands: `setup`, checks and tests on a copy of a branch that the object syncs in.
    It gets no secret and no git remote. One image (Node 22, git, Foundry) serves every profile for now.
  - Pushes go through the Git Data API. The review loop runs as a review run of the new PR, in its own object.
  - Entry: `npm run remote -- develop owner/repo#<issue>`, a `/develop` comment, or the `agent-develop` label. The
    issue is the ask, verbatim, and its comments carry the intake and spec questions and the report.

## 8. Decisions

Each decision records a conflict between two rules, and the choice.

| # | Conflict | Decision |
| --- | --- | --- |
| D1 | **Findings filter.** A scoring gate that keeps only the findings above a score, or a filter that keeps every finding with real evidence. | **No scoring gate.** The evidence check filters. Patch agents apply or reject every finding. A rejected critical or high finding goes to the user. Reviewers mark findings that need the user's decision. Triage uses profile rules, not a score. |
| D2 | **Evidence track.** Four tracks with the evidence rule in each, or a fifth Evidence reviewer. | Four tracks. The host's evidence check (real quotes at real lines) is stronger than a fifth agent. |
| D3 | **Models.** Which models, and how the passes get variance. | Step 1 spreads the tracks over Fable 5.2, Opus 5.5 and Sol: Bugs on Fable 5.2, Rules on Sol, Minimize, Anti-slop and Patch on Opus 5.5. Each step 2 role swaps family. The host refuses models outside the allowed list. `ALLOWED_MODELS` replaces the list. |
| D4 | **Draft during review.** "Never draft" against "draft until PASS". | Draft while the run works, ready after PASS. |
| D5 | **Audit-fix PRs in `src/`.** "Two passes" against the full Solidity rules. | The stricter Solidity rules win. |
| D6 | **Local test scope.** The loop runs touched tests only. The evm-cortex rules want the full suite, Slither and coverage before every PR. | Touched tests locally, the full suite in CI. The evm-cortex pre-PR list is a CI requirement of the `solidity` profile. |
| D7 | **Plan in parallel.** Four planners in parallel, against one consistent plan. | One planner writes all four parts in one checked output. |
| D8 | **Tests first against a lazy draft.** evm-cortex says tests first. The plan rules say a lazy first draft. | The draft includes its tests, and done-looks-like names them. A bug fix starts with a failing test. |
| D9 | **Solidity style conflicts.** Test names (three schemes), error names (`ManagerLocked` or `Oracle_StalePrice`), event tense, immutable case, pinned compiler (0.8.24, 0.8.26, 0.8.28), NatSpec on internal functions, coverage (90% or 100%), ReentrancyGuard scope (all external calls or value paths only). | One precedence rule: repo rules > the `solidity` profile > evm-cortex. The D9 picks below are the values of the profile, in `agents/profiles/solidity.md`. |
| D10 | **Questions at once or one at a time.** | Batch per stage. On an async channel, each round trip costs minutes or hours. |

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

### Phase 1 picks

| # | Topic | Pick |
| --- | --- | --- |
| P1 | Entry point | `npm run develop` first. GitHub issues and `/develop` on Cloudflare come in phase 3. |
| P2 | Platform | Phase 1 runs on the local platform. |
| P3 | Branch and PR | The work goes to `factory/dev-<slug>` from the base. The host opens a draft PR through `gh`. |
| P4 | Larger changes | The intake agent recommends a spec stage and one or two review passes, with a reason. The user can overrule both in the answers. |
| P5 | CI-fix budget | Two rounds, then a blocker. |
| P6 | Models | Intake, spec, planner and builders on Opus 5.5. |
| P7 | Static rules | They gate each builder checkpoint, and they are host findings in the review loop. |
| P8 | Gaps | The defaults in section 9 apply. |

## 9. Gaps

No rule covers these yet. Each default applies until the user replaces it.

| # | Gap | Default |
| --- | --- | --- |
| G1 | Backend tests: framework, coverage, integration tests | Tests next to the code. Every behavior change has a test. Integration tests for external interfaces. No coverage number. |
| G2 | Frontend tests: component, e2e, accessibility | Typecheck, lint and build in the profile. Component tests for logic. No e2e by default. |
| G3 | Backend conventions: API shape, errors, logging, config, migrations | Follow the repo. Validate external input at the boundary. Additive migrations first. |
| G4 | A security path for code that is not Solidity | Dependency and secret scans as host checks in the `typescript` profile. A focused security track in the review loop for auth and data paths. |
| G5 | Frontend and backend deploys | Out of scope until the deploy workflow. The PR is the end of this workflow. |
| G6 | Budgets: CI-fix rounds, review rounds, cost | Two CI-fix rounds, then a blocker. The pass count from triage, then FAIL. A cost budget per run, recorded in the report. |
| G7 | Where the frozen package and notes live | The PR description, written by the host, plus the run ledger. |
| G8 | Mixed-stack monorepos | Profiles match per package. Each package's strictest policy applies to its files. |
| G9 | Docs, config and CI changes | `docs` and `ci-infra` profiles (section 4.4). |
| G10 | Accessibility and i18n | None by default. |

## 10. Build plan

| Phase | Scope | Exit |
| --- | --- | --- |
| 0 | Review loop matches D1 and D3. The light loop, first profiles and static rules. Built. | A real run on a real PR. |
| 1 | Profiles in code. Intake, plan, build, freeze, review loop, hygiene, CI, ready PR, on the local platform. Profiles `solidity`, `solidity-support`, `typescript`, `docs`. Built: `npm run develop`, with parallel builders for the plan's tasks. Not yet: review thread checks in hygiene, repo overrides of profiles. | A small real feature from ask to ready PR. |
| 2 | The Auditor as a sub-workflow, PR-delta mode first. | A Solidity change with the review loop and the Auditor. |
| 3 | The builder on Cloudflare, through a Container per run. Built: `DevelopmentRuns`, the build container, `/develop` on issues. | The phase 1 feature, run from `npm run remote`. |
| 4 | The deploy workflow: dry run, the user's `/go` for an exact scope, broadcast in chunks with a progress file, live verify, record. | A testnet deploy. |
