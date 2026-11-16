# agent-factory

agent-factory runs workflows of specialized agents on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts).
A host program owns the flow and the rules. Each agent gets one role, a new session, its own workspace, and a submit
tool whose input the host checks. No agent sees another agent's conversation or decides what runs next.

| Workflow | What it does | Status |
| --- | --- | --- |
| Code review loop | Context-free reviewers at the same time, a gate, patch agents, and a second pass on another model family | Built |
| Development workflow | From an issue to a reviewed PR: intake, plan, builders, CI, then the review loop | Built |
| Research workflow | Hypotheses and tests on public data, with preregistration and blinding | In progress |

Each workflow runs locally as a CLI, or on Cloudflare as a Worker with one Durable Object for each PR or issue. The
designs and their decisions are in [docs/specs](docs/specs).

## The review loop

```
freeze ─▶ triage: light or full

full:  step 1: minimize │ rules │ bugs ×1-4 │ anti-slop     read-only, at the same time
       ─▶ gate ─▶ patch ×1-4 by file ─▶ commit
       ─▶ step 2: late-minimize │ late-rules on the new diff   each on the other model family
       ─▶ gate ─▶ patch ─▶ commit ─▶ late bugs on every fix ─▶ gate ─▶ patch ─▶ commit
       ─▶ checks ─▶ intent ─▶ PASS or FAIL

light: one reviewer that also fixes ─▶ commit ─▶ checks ─▶ PASS or FAIL
```

- **Triage.** A change to docs and tests only takes the light loop. Solidity `src/` and `script/`, agent prompts and
  rule files (`agents/`, `AGENTS.md`, `CLAUDE.md`) always take the full loop. `--full` forces the full loop.
- **Scale.** A diff over 600 lines splits across up to 4 bugs reviewers. Patch agents split the findings by file.
- **Static rules.** Each profile has mechanical rules, for example a fixed Solidity pragma, or no `.env` file in the
  change. The host checks the added lines and gives each break to the patch agent.
- **Models.** Step 1 runs on Opus 5.5, with the rules track on Sol. Step 2 swaps the family of each role.
- **Resume.** Each step's result goes to the run's ledger, so a stopped run continues where it stopped.

## Rules the host enforces

| Rule | How |
| --- | --- |
| Reviewers are context-free and read-only | Each agent is a new session. Writes to the reviewed tree fail. |
| Findings need evidence | `submit_findings` refuses a finding whose quote is not at its file and line. |
| Every finding gets an answer | The patch log lists each finding as applied or skipped, with a reason. A skipped critical or high finding fails the run. |
| Questions only when they need you | A run asks only when a choice changes the scope of the ask, what agents can reach or do, spend or a public action, or a recorded decision (D11). It takes the recommendation for every other question, posts nothing, and lists it in the report. |
| Agents stay in their workspace | An in-process shell, with no network, a hidden `.git`, and no writes through a symlink. |
| Checks stay strong | Agents cannot write `.agent-factory.json`, protected paths or `.github/`. Check commands come from the config. |
| A PR cannot change its own rules | On Cloudflare, the config comes from the base branch. |
| Allowed models | Fable 5.2, Opus 5.5 and Sol, or the list in `ALLOWED_MODELS`. Step 2 must use the other family. |
| Keys stay in the host | A key goes only to its own provider. Check commands get an allowlisted environment. |

Checks run the repository's code, as CI does. For unattended local runs, use a machine that holds only what the run
needs. On Cloudflare, code under review never runs in the Worker.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...   # or pass --claude-plan to use your nc Claude login
```

A repository needs no config when a profile knows its stack:

| Profile | Applies when | Checks and tests |
| --- | --- | --- |
| `solidity` | `foundry.toml` | `forge build`, `forge fmt --check`, `forge test` |
| `typescript` | `package.json` and `tsconfig.json` | the `typecheck` script or `tsc`, `eslint`, `vitest` or `jest` |
| `python` | `pyproject.toml` or `requirements.txt` | `ruff` or a compile check, and `pytest`, in a `.venv` |

For another stack, or to change a default, add `.agent-factory.json` at the root. Each field replaces its default:

```json
{
  "stack": "TypeScript",
  "checks": { "typecheck": "npm run typecheck", "lint": { "command": "npx eslint {files}", "files": "\\.tsx?$" } },
  "tests": { "pattern": "\\.test\\.tsx?$", "command": "npx vitest run {tests}" },
  "setup": "npm ci",
  "protect": ["package.json", "tsconfig.json"]
}
```

- `{files}` is the changed files that match `files`. `{tests}` runs the targeted tests in one command, and `{test}`
  runs one command for each test file.
- `protect` lists paths that agents cannot write. A `*` matches inside one path segment.
- `env` lists extra environment variables for the checks. `guides` mounts reference material at `/guides/<name>`.
- `answerers` limits who can answer questions. `research` configures a research notebook
  ([spec, section 6.3](docs/specs/research-workflow.md)).
- Targeted tests are the changed test files, and the test files whose import lines name a changed file. A changed
  file that no test imports gets the test files that have its base name as a word. A builder's `run_checks` runs
  only the checks. The targeted tests run one time, when the builder submits its build log.
- `merge` (`"squash"`, `"merge"` or `"rebase"`) is the standing permission for the host to merge a ready development
  PR with that method. Without it, the host does not merge.

The STE dictionary is optional: see [agents/guides/ste/README.md](agents/guides/ste/README.md).

## Run locally

```bash
npm run review -- --repo ~/src/app --pr 123     # review a PR, add --ship to push the fixes and mark it ready on PASS
npm run review -- --repo ~/src/app --base main --ask-file ask.md
npm run develop -- --repo ~/src/app --ask "Add a fee switch, off by default"
npm run review -- --run <id>                     # resume a run, also with npm run develop
```

- **Questions** that need you (D11) go to the PR, the terminal, or `runs/<run>/questions-<batch>.md`. Answer with `/answer` and one
  line for each question (`Q1: b`, or your own words), or with `/answer recommended`.
- **Results** are in `runs/<run>/`: `report.md`, `gate-log.txt`, the ledger, and the journal of each agent. Review
  fixes are on the local branch `factory/<run>`.
- **Models:** `--models file.json` sets the model of each role.
- **Budget:** `--budget <usd>` caps the spend of a run. At the cap, the run asks you to raise it or stop. Prices come
  from `MODEL_PRICES`, JSON with the USD per million tokens of each model ID (`input`, `cached_input`, `cache_write`,
  `output`). Each report shows the usage of each step.
- **Issues:** `npm run develop -- --issue <n>` puts `Closes #<n>` in the PR body, so the merge closes the issue.

## Cloudflare

You need Workers Paid, Containers for development runs, and Docker on the machine that deploys. When you set
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, the Worker calls GitHub as that GitHub App. The key must be PKCS#8
(`openssl pkcs8 -topk8 -nocrypt`). Without them, the Worker uses `GITHUB_TOKEN`, a fine-grained token with read and
write access to Contents, Pull requests and Issues, and read access to Actions and Commit statuses. Each target
repository needs CI on pull requests and on pushes to `factory/**`. Fork PRs are refused, because that CI would run
fork code with the repository secrets.

```bash
npx wrangler deploy
for name in GITHUB_TOKEN GITHUB_WEBHOOK_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY ADMIN_TOKEN ALLOWED_USERS; do
  npx wrangler secret put $name
done
```

`ALLOWED_USERS` is the GitHub logins, comma-separated, that can start runs and answer questions. Set `MODEL_PRICES`
as a secret to use budgets.

`npm run remote` starts and follows runs. It reads `FACTORY_URL` and `ADMIN_TOKEN` from the environment or from
`.secrets/cloudflare.env`.

```bash
npm run remote -- start acme/app#123     # a review run on a PR (--ship, --full, --budget)
npm run remote -- develop acme/app#45    # a development run on an issue (--base, --hotfix, --full, --parallel, --budget)
npm run remote -- resume acme/app#45     # wake a paused run after you answer
npm run remote -- status acme/app#45     # or report
npm run metrics                          # CPU, memory and network of each build container
```

The webhook is optional. With it, a `/review` or `/develop` comment, or the `agent-review` or `agent-develop`
label, starts a run, and answers take effect at once. Without it, runs poll for answers and CI. One App webhook
replaces the webhook of each repository: point it at `https://<worker>/github/webhook` and set its secret as
`GITHUB_APP_WEBHOOK_SECRET`. Without that secret, the Worker checks the webhook of each repository with
`GITHUB_WEBHOOK_SECRET`. Use the events Issue comments, Issues, Pull requests, Workflow runs and Statuses. The Worker
ignores the comment, issue and PR events of its own bot.

A Durable Object holds the ledger, the repository tree and the agent sessions of each run. Alarms drive the run and
resume it after a crash. Development runs run their checks in a Cloudflare Container that has no secrets. Commits
and pushes go through the GitHub API.
The object keeps the sync state of each container directory in SQL, so after a restart the next sync sends only the
changed files and does not run the setup again.
A development PR says `Closes #<issue>`.

## Layout

```
agents/            the guidelines of each role, with profiles/ for each stack and research/ for the research roles
src/core/          the workflows, the rules and the agent host, with no platform code
src/node/          the local CLIs
src/cloudflare/    the Worker and the Durable Objects
containers/build/  the build image of development runs
docs/specs/        the designs and their decisions
```

## Development

```bash
npm run check   # types: Node, the core without Node types, and the Worker
npm test        # unit tests, both workflows against scripted models, and the Worker under wrangler dev
```

[AGENTS.md](AGENTS.md) has the rules for changes to this repository. MIT license: see [LICENSE](LICENSE).
