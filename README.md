# agent-factory

A host for workflows of specialized agents, built on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts).
It has two workflows:

- the **code review loop** from `~/.claude/skills/code-review-loop`, and
- the **development workflow** from `~/.claude/skills/ship-quality-code`: from an ask to a PR that is ready for
  your review, with builder agents for the plan's tasks and the code review loop before the PR is ready.

The host owns the flow and the hard rules. Each agent gets one role: its guidelines (`agents/*.md`),
its workspace, its tools, and a submit tool whose input the host checks. No agent sees another agent's
conversation, and no agent decides what runs next.

The same workflow runs on two platforms:

- **Local** (`src/node`): a CLI on your machine, with a git worktree, real check commands, and answers in
  the terminal or on the PR.
- **Cloudflare** (`src/cloudflare`): a Worker and one Durable Object per PR. A `/review` comment starts a run;
  questions and the result appear as PR comments; the fixes go to a `factory/<run>` branch, and the repo's own CI
  is the check.

## How a run works

```
freeze ─▶ triage: light or full

full:  step 1: minimize │ rules │ bugs │ anti-slop   (Opus 5.5, Sol, Fable 5.2: read-only, parallel)
       + host findings ─▶ gate ─▶ patch (Opus 5.5) ─▶ commit
       ─▶ step 2: late-minimize │ late-rules on the new diff   (each role on the other family)
       + host findings ─▶ gate ─▶ patch (Sol) ─▶ commit
       ─▶ late bugs on every fix since the freeze ─▶ gate ─▶ patch ─▶ commit
       ─▶ checks ─▶ intent ─▶ PASS criteria ─▶ (optional) push + mark the PR ready

light: host findings ─▶ gate ─▶ one reviewer that also fixes (Opus 5.5) ─▶ commit
       ─▶ checks ─▶ PASS criteria ─▶ (optional) push + mark the PR ready
```

Triage comes from the **profiles** in `src/core/profiles.ts`, one for each stack: `solidity` (`src/**/*.sol`),
`solidity-support` (Foundry tests and scripts), `typescript` and `docs`. A profile applies when its marker files
exist, for example `foundry.toml`. It gives the guides for its files, the paths that a change must not commit,
and static rules. The light loop runs only when every changed file is docs or tests of a profile that allows it.
Solidity `src/` and `script/` always get the full loop. Agent prompts and rule files (`agents/`, `AGENTS.md`,
`CLAUDE.md`, `CONTRIBUTING*`) also always get the full loop. Triage also checks deleted paths and old paths of renames.
`--full` forces the full loop. The host writes the decision as `TRIAGE path=light|full reason=...` at the top of
the gate log and in the report.

The static rules are the mechanical rules that a program can check: a fixed pragma, named imports, no revert
strings, no `tx.origin` or `selfdestruct`, a comment before `unchecked` and `assembly`, the two test name shapes,
no Latin abbreviations in docs, and no build output, logs or `.env` files in the change. The host checks the lines
that the change adds, and gives each break to the patch agent as a `host-NNN` finding of the rules track.

Each agent is a fresh nanocode session with its own journal scope. Each step's result goes into the run's
ledger before the next step starts. A resumed run returns the recorded results of finished steps, and an
agent that was mid-turn resumes from its journal. Locally, resume with `--run <id>`; on Cloudflare, an alarm
resumes the run by itself.

## Rules in code, not in prompts

| Skill rule | How the host enforces it |
| --- | --- |
| Context-free reviewers | Every agent is a new session. Reviewers get only the ask, the diff and the repo. |
| Read-only tracks | Reviewers' `/repo` is a read-only file system. Writes fail with EROFS, in the file tools and in the shell. |
| Agents stay in their workspace | The agent shell is nanocode's in-process virtual bash with its own environment. Cell `fetch`, shell network and web search are off. Paths cannot leave the tree, `.git` is hidden, and writes never follow a symlink. |
| Test scope; one test run at a time | `run_tests` accepts only committed test files, runs the repository's configured command, and runs one command at a time across the host. |
| Finding schema and evidence rule | `submit_findings` rejects a finding with a missing field, a location that is not a real file and line, or a quote that is not in the file near that line (or in the diff). The agent sees the reasons and can correct the call. |
| Findings filter (no Jev) | The evidence check is the noise filter. Every finding that passes it goes to the patch agent, which applies it or rejects it with a reason. A rejected critical or high finding becomes a question to you, and the run passes only if you accept the rejection. |
| Patch: log why for each item | `submit_patch_log` must list every finding ID one time, in applied or skipped. |
| Light or full loop | Profile rules decide, not an agent. The light reviewer cannot write outside docs and tests. |
| Mechanical style rules | The profiles' static rules run on the added lines before each gate. Their findings skip the evidence check, because the host quotes the line. |
| Never weaken checks | Patch agents cannot write `.agent-factory.json` or the `protect` paths. Check commands come from the config only. The report lists patch edits outside the change and the findings. |
| Model swap across passes | The run stops before any work if a step 2 agent uses the same family as its step 1 counterpart. The gate log records the families. |
| Allowed models | Fable 5.2, Opus 5.5 and Sol only (`allowedModels`). The run stops before any work on another model. |
| No API keys in prompts or files | Keys stay in the host's dispatch. They go only to their own provider's origin. Check commands get an allowlisted environment, never the host's keys. |
| Open questions (A2) | A read-only questions agent runs beside the step 1 reviewers and posts its questions at once. A reviewer marks a finding that depends on your decision, and the gate holds it until you answer. Patch agents, later reviewers and the intent check read your answers. |
| Missing key or input: stop | The run stops before it freezes anything. |
| Ready PR, never draft | `--ship` pushes the fixes to the PR branch (no force) and marks the PR ready, only on PASS. |
| A PR cannot change its own rails | On Cloudflare, `.agent-factory.json` comes from the base branch. Locally, it comes from your working copy. |

### Trust boundary

Checks and `run_tests` run the repository's code on this machine, as CI does. That code is the change under
review plus the patch agents' edits, so a prompt-injected patch agent can get code to run there. The host limits
that: test files must be committed by the host, the environment is an allowlist (`PATH`, `HOME`, locale, and the
config's `env` list), and host git ignores repository hooks and fsmonitor. `HOME` stays, so that code can read
files in it, such as the `nc` login that `--claude-plan` uses. For unattended runs, use a machine or VM that holds
only what the run needs. On Cloudflare, no code under review runs in the Worker: agents use the in-process shell
only, and the checks are the repository's own CI.

## Local setup

```bash
npm install
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...
```

`--claude-plan` signs Claude requests with your `nc` Claude login instead of `ANTHROPIC_API_KEY`.
The host never refreshes that login, because a refresh would sign `nc` out. Run `nc` once when it expires.

Each target repository needs `.agent-factory.json` at its root:

```json
{
  "stack": "Solidity+Foundry",
  "checks": {
    "build": "forge build",
    "format": { "command": "forge fmt --check {files}", "files": "\\.sol$" }
  },
  "tests": { "pattern": "\\.t\\.sol$", "command": "forge test --match-path {test}" },
  "guides": { "evm-cortex": "~/uniswap/evm-cortex" },
  "protect": ["foundry.toml", "remappings.txt"]
}
```

```json
{
  "stack": "TypeScript",
  "checks": { "typecheck": "npm run typecheck", "lint": { "command": "npx eslint {files}", "files": "\\.tsx?$" } },
  "tests": { "pattern": "\\.test\\.tsx?$", "command": "npx vitest run {tests}" },
  "protect": ["package.json", "tsconfig.json", "eslint.config.js"]
}
```

- `{files}` is the changed files that match `files`. A check with no matching files is skipped.
- `{tests}` runs the targeted tests in one command; `{test}` runs one command per test file.
- Targeted tests are the changed test files plus the test files that name a changed source file.
- `guides` are mounted read-only at `/guides/<name>`. The STE dictionary is always at `/guides/ste`.
- `env` lists extra environment variables that the checks need, for example `["ETH_RPC_URL", "FOUNDRY_PROFILE"]`.
- `setup` runs one time in each new worktree before its first check, for example
  `"npm ci --prefer-offline --no-audit --no-fund"` or `"forge install"`. Worktrees start without dependencies.

## Local usage

```bash
npm run review -- --repo ~/src/app --pr 123                 # base, head and ask from the PR
npm run review -- --repo ~/src/app --base main --ask-file ask.md
npm run review -- --run 20261113-101500-1a2b3c4d             # resume
npm run review -- --repo ~/src/app --pr 123 --ship          # on PASS, push the fixes and mark the PR ready
npm run review -- --repo ~/src/app --pr 123 --full          # the full loop, also for a docs or tests only change
```

### Your answers

Questions go to the PR as a comment with `--pr`, to the terminal when it is interactive, and otherwise to
`runs/<run>/questions-<batch>.md`. Reply with `/answer` and one line per question (`Q1: b`, or your own words);
`/answer recommended` takes every recommendation. Only replies from `answerers` in the config count (default: your
`gh` login). With `--pr`, the run polls for your reply for `--wait` minutes (default 60), then exits with status 3.
Resume it with `--run <id>` after you answer. A held finding is kept unless you answer "Do not fix it"; any other
text goes to the patch agent as an instruction for that fix.

The fixes stay on a local branch, `factory/<run>`, in a worktree at `runs/<run>/tree`. Apply them with
`git merge --ff-only factory/<run>`. Remove a run with `git worktree remove runs/<run>/tree` and
`git branch -D factory/<run>`. The host commits with your git config, so commit signing must work without a prompt.

Each run writes:

- `report.md`: PASS or FAIL, the triage line, the criteria, each step, the checks and the intent verdict
- `gate-log.txt`: the triage line, then one line per finding in the skill's format, with the model family of each step
- `state.json`: the ledger, with every finding, gate decision, patch log and turn report
- `agents/<step>.events.jsonl` and `agents/<step>.sqlite`: each agent's event log and journal

`--models file.json` overrides models per step and role, for example
`{ "step1": { "bugs": { "provider": "claude", "model": "claude-opus-5-5", "thinking": "high" } } }`.
The light loop's model is `light`.

## Development workflow

```
intake ─▶ your answers confirm the ask and the route (spec or not, one or two review passes)
       ─▶ spec, for a larger change ─▶ your answers to its decisions
       ─▶ plan: smallest change, goals, non-goals, done checks, profile sections, tasks
       ─▶ build: one builder for each task, each on its own branch; a wave of tasks with separate files
          runs at the same time; the host merges each wave into factory/dev-<slug>
       ─▶ push, draft PR ─▶ CI, with two fix rounds
       ─▶ code review loop, once or twice, on the frozen package (ask, decisions, plan)
       ─▶ push the review fixes ─▶ CI ─▶ criteria ─▶ ready PR and a report comment. You merge.
```

Intake, spec, planner and builders run on Opus 5.5. The review loop uses its own models.

| Rule | How the host enforces it |
| --- | --- |
| No plan and no code before you confirm the ask | The intake questions and the host's route questions are one batch. The run waits for your answer. `--hotfix` takes every recommendation without asking. |
| One planner, four parts | `submit_plan` refuses a plan with an empty part, with no done check that has a command, without the sections of its profiles (Solidity: interfaces, deployment sequence), or with tasks that depend on unknown tasks or on each other. |
| A builder stays in its task | A builder can write only the files and directories of its task, never protected paths. Parallel builders work in separate worktrees, so one builder's half-done work never breaks another's checks. |
| Static rules and forbidden paths gate every commit | `checkpoint` checks the added lines and the paths before it commits, and returns each problem to the builder. Build output, logs and `.env` files never enter the history. |
| Nothing uncommitted, every file explained | `submit_build_log` refuses uncommitted work, and needs each changed file with a reason. A builder that cannot finish says why, and the run stops with that blocker. |
| CI budget | Two CI-fix rounds after the build, then a blocker. A single task's fixes go to the same builder session. |
| Review before ready | The code review loop runs on the result, once or twice. A red CI after the review fails the run, because a fix there would skip the review. |
| Ready only on PASS | The PR stays draft unless the review loop passed, CI is green, and no forbidden path is in the change. A change to Solidity `src/` stays draft, because the Auditor workflow is not built yet. |

```bash
npm run develop -- --repo ~/src/app --ask "Add a fee switch to the vault, off by default"
npm run develop -- --repo ~/src/app --ask-file ask.md --base develop --parallel 2
npm run develop -- --run dev-20261113-201500                # resume after a pause
```

The repository needs `.agent-factory.json` (as for the review loop), an origin on GitHub, and CI that runs on
pull requests. The `gh` CLI must be logged in. Questions go to the terminal when it is interactive. Otherwise the
intake and spec questions go to `runs/<run>/questions-<batch>.md`, and the review questions go to the PR. A run
that waits for answers or for CI exits with status 3. Resume it with `--run <id>`.

Each run writes `runs/<run>/`: `report.md`, `plan.md`, `spec.md` for a larger change, `state.json`, the agents'
journals, and a worktree for each branch under `branches/`. Each review pass is a run of its own,
`runs/<run>-review-<pass>/`. Remove the worktrees with `git worktree prune` after you delete a run directory.

## Cloudflare

### What it needs

- A Cloudflare account on **Workers Paid**. The Worker bundle is 5.3 MB gzipped (the Free plan allows 3 MB),
  and a run uses up to 5 minutes of CPU per alarm (`limits.cpu_ms`).
- For development runs: Cloudflare Containers on the account, and Docker on the machine that deploys.
  `wrangler deploy` builds the build image from `containers/build/Dockerfile` (Node 22, git, Foundry) and pushes it.
- A GitHub fine-grained token for the target repositories with: Contents read and write, Pull requests read and
  write, Issues read and write, Actions read, Commit statuses read. Fine-grained tokens cannot call the Checks API,
  so the run reads CI from GitHub Actions workflow runs and commit statuses.
- `.agent-factory.json` on each repository's base branch. Review runs use `stack`, `protect` and `answerers`, and
  CI is their check. Development runs also use `checks`, `tests` and `setup`, on the build container. The
  config's `env` list does not reach the container.
- CI that runs on pushes to `factory/**` branches, for example `on: { push: { branches: ['factory/**'] } }`.
  That CI runs the PR's code and the patch agents' edits with the repository's secrets. A PR author in the same
  repository can already push such a branch, so this gives no new access. Fork PRs are refused for this reason.

### Deploy

```bash
npx wrangler login
npx wrangler deploy
for name in GITHUB_TOKEN GITHUB_WEBHOOK_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY ADMIN_TOKEN; do
  npx wrangler secret put $name
done
```

Set `ALLOWED_USERS` in `wrangler.jsonc` to the GitHub logins that may start runs and answer questions.

The webhook is optional. Without it, start runs with `npm run remote` (below); the run still picks up your
`/answer` comments and CI results by polling. With it, `/review` comments start runs and answers take effect at
once: add a webhook to each repository with payload URL `https://<worker>/github/webhook`, content type
`application/json`, the `GITHUB_WEBHOOK_SECRET`, and the events Issue comments, Issues, Pull requests, Workflow
runs and Statuses.

### Use

```bash
npm run remote -- start acme/app#123            # or a PR URL; --ship pushes the fixes and marks the PR ready on PASS
npm run remote -- start acme/app#123 --full     # the full loop, also for a docs or tests only change
npm run remote -- develop acme/app#45           # a development run: the issue's title and body are the ask
npm run remote -- develop acme/app#45 --base develop --parallel 2
npm run remote -- resume acme/app#123           # a PR or an issue: after you answer, instead of waiting for the next poll
npm run remote -- status acme/app#123
npm run remote -- report acme/app#123
```

`npm run remote` reads `FACTORY_URL` and `ADMIN_TOKEN` from the environment or from `.secrets/cloudflare.env`.

- With the webhook: comment `/review` on a PR, or add the `agent-review` label. `/review --ship` also pushes the
  fixes to the PR branch and marks it ready on PASS. `/review --full` forces the full loop.
- With the webhook: comment `/develop` on an issue, or add the `agent-develop` label. `/develop` takes the options
  `--base <branch>`, `--hotfix`, `--full` and `--parallel <n>`. The intake and spec questions and the final report
  go to the issue. The review questions go to the new PR.
- Answer questions with a `/answer` comment, as in [Your answers](#your-answers). The webhook resumes the run at
  once; without it, the run checks again every `PAUSE_POLL_SECONDS` (default 60). Only unedited comments from
  `ALLOWED_USERS` count. The config's `answerers` can narrow that list, never widen it.
- The result is a PR comment with the criteria and the full report. The fixes are on `factory/<run>`.
- The routes behind `Authorization: Bearer <ADMIN_TOKEN>`: `POST /runs/<owner>/<repo>/<pr>` starts a review run
  (body `{"ship": true}` to ship, `{"full": true}` for the full loop), `POST /develop/<owner>/<repo>/<issue>` starts
  a development run (body `{"base", "hotfix", "full", "parallel"}`), `POST /runs/.../resume` wakes the run of a PR or
  issue and returns `resumed`, the `state` of the latest run and a `reason`, and `GET /runs/<owner>/<repo>/<number>`
  and `.../report` return the status and the report. `npm run remote -- resume` prints the state and the reason,
  and exits 1 when the run did not wake. `npx wrangler tail` shows each agent's tool calls.

### How it works

- `PullRequestRuns` is one Durable Object per PR. Its SQLite holds the run's ledger and artifacts, the
  repository tree (nanocode's `SqlFileSystem`), and every agent session, each in its own journal scope.
- The freeze downloads the PR head tarball, steps the PR's files back to the merge base for one commit and
  forward for a second, so nanocode's in-process git can diff and commit. The fixes go back through the Git Data API.
- Alarms drive the run. A heartbeat alarm stays a minute ahead while the run works, so a run whose isolate
  died (or hit the CPU limit) resumes from its ledger. A paused run (answers or CI) re-checks on an alarm, and
  webhooks wake it early. A run that dies 5 times without finishing a step stops with a PR comment.
- Limits: a PR with 3,000 or more files stops (GitHub lists no more). Files over the tree's size limit are
  skipped. The whole tarball is held in memory during the freeze, so very large repositories can hit the 128 MB
  limit.
- `DevelopmentRuns` is one Durable Object per issue, with one Cloudflare Container. The brain stays in the object:
  the ledger, every agent session, the GitHub token, and each branch as a tree in SQL with in-process git. A new
  branch copies its start tree, `.git` included, so commit IDs agree across branches. Builders read and write the
  tree through the same rails as on the local platform.
- The container only runs commands. Before a check or a test, the object copies the branch's tree into a
  directory of the container: all of it the first time, then only the files that changed. After a full copy it
  runs `setup`. The container gets no secret and no git remote, so code under development never runs beside a
  token. It stops after 30 minutes without a command, and the next copy starts again from the full tree.
- Pushes go through the Git Data API. The review loop runs as a review run of the new PR, in that PR's object,
  as a `/review` would. The development run waits for it, then takes its fixes from GitHub.

## Layout

```
agents/                    guidelines, one file per role, and shared rules (factory, reviewer, STE)
agents/profiles/           the guides of each profile (Solidity, TypeScript)
agents/guides/ste/         the STE dictionary, mounted at /guides/ste
src/core/                  platform-neutral: it typechecks without Node types (tsconfig.core.json)
  workflows/               the code review loop and the development workflow
  profiles.ts              profiles: triage, guides, forbidden paths, plan sections and static rules for each stack
  plan.ts                  intake, spec and plan: their submit tools, the host checks, and the build waves
  develop-steps.ts         intake, spec, planner and builder steps; checkpoint, run_checks and the build log
  ci.ts                    the CI of a commit on GitHub: Actions runs and commit statuses
  platform.ts              what a platform supplies: Repo, Checker, Files, AgentStore, Guides
  agent.ts                 one isolated nanocode agent: durable session, drive loop, host tools
  steps.ts                 reviewer, patch, light, intent and questions steps with their submit tools
  workspace.ts             the agent shell and the rails: read-only, protected paths, no symlink writes, .git hidden
  findings.ts gate.ts      the evidence check; the gate that holds findings for your decision
  questions.ts checks.ts   questions and /answer parsing; repository config and command checks
src/node/                  the CLIs: git worktrees and branches, local machine, terminal/file/gh channels, PRs and
                           CI through gh, nc plan login. develop.ts runs the development workflow, remote.ts
                           drives the deployed Worker
src/cloudflare/            the Worker and webhooks; the PullRequestRuns and DevelopmentRuns Durable Objects on one base
                           (runs.ts); the GitHub repo, branches, PRs and CI; the build container (box.ts)
containers/build/          the build image of development runs
scripts/smoke.ts           one live reviewer against the test fixture (npm run smoke, uses --claude-plan auth)
```

## Where this differs from the skill

- The late bugs pass runs when any patch changed code since the freeze, and reviews every fix since then.
  The skill runs it only after a step 2 patch, so step 1 fixes could skip a bugs review.
- Step 2 has no diff to review when the step 1 patch changed nothing. The run records that and goes on.
- Missing credentials stop the run before it starts; the host does not ask for them (A2 item 4).
- On Cloudflare, review agents cannot run tests during their turns; CI checks the result. Builders of development
  runs can, on the build container.
- On Cloudflare, in-process git reads a symlink as its target's content, so a PR that only retargets a symlink
  shows no change to the reviewers. The fixes never change a symlink.
- Triage uses profile rules, not a Jev chore score (D1). The light reviewer also applies the host findings.
- Not built yet: the review bot loop after the PR is ready, and the Auditor workflow.

## Development

```bash
npm run check   # types: Node, the core without Node types, and Cloudflare
npm test        # unit tests; the review loop and the development workflow on Node against scripted Claude and
                # Codex models, a local git origin and fake PRs and CI; and the Worker under wrangler dev
                # against local GitHub, model and machine mocks
FACTORY_CONTAINERS=1 node --test --test-name-pattern=develop test/cloudflare.test.ts
                # the development run on the Worker with a real local build container (needs Docker)
```
