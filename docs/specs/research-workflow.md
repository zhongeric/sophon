# Spec: the research workflow

Status: scoping. Nothing is built. Section 11 is the build plan.

This spec defines a third workflow of agent-factory: the **research workflow**. A swarm of agents reads large public
data, makes hypotheses, tests them, and reports a candidate or a calibrated null. The design is domain-neutral. A
domain, for example transit searches in public sky data, lives in the research repository as config and guides, never
in agent-factory.

Terms:

- **The notebook** is the research repository that a run reads and writes, as a target repository is for the other
  workflows. It holds the programs, preregistrations, analysis code and dossiers.
- **A program** is one research question: a GitHub issue in the notebook, as an issue is the ask of a development run.
- **The domain** is the notebook's research config (section 6.3): its data sources, guides, checklist and calibration
  commands.
- **An artifact** is a file that a run made or fetched, stored by the hash of its bytes, with its source.

## 1. Principles

The principles of the development workflow hold. These follow from them.

1. **The host fans out.** A swarm is many agents that the host schedules. No agent decides the next stage or starts
   another stage's agents.
2. **Code searches, agents judge.** A frozen pipeline sweeps the data. Agents write the pipeline, make the hypotheses,
   screen the top candidates and vet the top few. Agent turns scale with hypotheses and candidates, not with the size
   of the data.
3. **Research rules are rails.** Preregistration, blinding, known-object recovery, injection-recovery, a fresh-session
   challenge and reproduction are host checks, not prompts (section 4).
4. **A calibrated result passes.** A null with its coverage and completeness is a PASS. No agent can pass a run by
   finding something, so no agent has a reason to overclaim.
5. **Evidence is an artifact.** Each claim cites an artifact that a recorded command or fetch made, with a quote that
   the host finds in it.

## 2. A research run, next to a development run

| | Development run | Research run |
| --- | --- | --- |
| Ask | an issue in the target repository | a program: an issue in the notebook |
| Unit of work | a plan task | a hypothesis, then its candidates |
| Fan-out | at most 8 tasks, from the plan | hypotheses, candidate batches and data partitions |
| Agents read | the repository | the notebook, artifacts, and allowlisted origins through the host egress |
| Commands run on | the build box | the build box, with the notebook's setup |
| Check | CI, then the review loop | calibration, skeptic review, the holdout test, reproduction |
| Output | a ready PR | a dossier PR in the notebook: a candidate, or a calibrated null |
| Outward action | the user merges | the user merges. Submission to an outside body is a later workflow with a `/go` |

## 3. The lifecycle

```
0 Intake ─▶ 1 Survey ─▶ 2 Hypotheses (swarm) ─▶ 3 Pick (the user)
  ─▶ 4 Prereg (freeze) ─▶ 5 Build the search ─▶ 6 Calibrate
  ─▶ 7 Sweep (code, fan-out) ─▶ 8 Screen (swarm) ─▶ 9 Vet: skeptic loop, x2 with the family swap
  ─▶ 10 Holdout test ─▶ 11 Dossier PR ─▶ the user merges
```

| Stage | Like | Who | What the host enforces |
| --- | --- | --- | --- |
| 0 Intake | intake | intake agent, read-only, with the domain's egress | No spend before the user confirms the program. The same batch asks the budget cap. |
| 1 Survey | spec | surveyors at the same time, one for each lens of the domain (for example literature, known objects, data coverage) | Each claim cites an artifact with a quote. The host finds the quote in the artifact. |
| 2 Hypotheses | step 1 reviewers | generators on different model families and lenses | Schema: statement, why past work missed it, data, test, kill criterion, cost. The host merges duplicates by their data and test. |
| 3 Pick | gate, held findings | the user | No spend on a hypothesis that the user did not pick. |
| 4 Prereg | plan (one planner, D7) | one preregistrar | The core sections and the domain's sections. The host commits `prereg/<id>.md`, records its hash, and protects the path. A change is a new version with a reason. |
| 5 Build | build | builder, on a branch of the notebook | Writes only `analysis/<id>/`. Checkpoints and static rules as today. |
| 6 Calibrate | done-looks-like | host | Runs the domain's `known` and `inject` commands on the search partition. Recall under the prereg threshold goes back to the builder, in two rounds at most. |
| 7 Sweep | none | host, on the box | Runs the frozen commit in a bounded pool. Each partition is a ledger step. Results go to artifacts. |
| 8 Screen | light reviewer | screeners on a cheap model, in batches | Each label cites an artifact. A split vote goes to a second screener on the other family. |
| 9 Vet | full review loop | skeptic tracks; the analyst answers, as the patch agent does; then late skeptics on the other family | Context-free skeptics. The evidence check on artifacts. The analyst lists every objection as addressed or conceded. A conceded critical or high objection goes to the user. The domain's checks are host findings. |
| 10 Holdout | none | host | The holdout is locked until the prereg freeze. The host runs the frozen `evaluate` command of the prereg on it. Its output is the outcome: recovered, inconsistent, excluded or insufficient. |
| 11 Dossier | ready PR | writer, then the code review loop on the analysis code | Each number cites an artifact. Each item of the domain's checklist has a status: ruled out, open or not tested. Coverage and completeness. The host runs `reproduce` on a clean box and compares the hashes. |

### Scout

A second, smaller workflow watches for new developments. A cron reads the domain's feeds (for example new papers,
alerts and data releases). Screeners match each item against the open programs and the notebook's interests. The host
posts a weekly digest issue and opens proposal issues. A proposal becomes a program only when the user labels it.

## 4. Research rules as rails

| Rule | How the host enforces it |
| --- | --- |
| Recover known objects before you trust a search | The prereg names a known set and a recall threshold. Stage 6 runs it. The sweep does not start under the threshold. |
| Measure completeness and false positives with injections | The domain's `inject` command. The dossier requires the completeness and false-positive artifacts. |
| Write thresholds and predictions before the data | The prereg is frozen: a hash in the ledger and a protected path. The egress refuses the holdout until the freeze. |
| A fresh session challenges the analysis | Skeptics are new sessions that never see the analyst's conversation. Step 2 skeptics use the other model family. |
| Reproduce | Each fetch is an artifact with its URL, query, time and hash. The host runs `reproduce` before the dossier PR. |
| Publish nulls | A calibrated null is a PASS, with coverage, completeness and the count of trials in the program. |
| Say what is ruled out | The dossier gives each item of the domain's checklist a status and its evidence. |

## 5. The swarm

- **Breadth:** the host maps one role over many items (lenses, candidate batches, partitions) in a bounded pool. Each
  item is a ledger step, so a resumed run does not run it again.
- **Depth:** inside one turn, a surveyor or the analyst can start nanocode subagents, as builders can.
  `max_concurrent_subagents` and `subagent_budgets` bound them. Only the root agent submits.
- **Diversity:** generators and skeptics get different model families and different lenses, because agents of one
  family can share a mistake. The family-swap check applies to the skeptic passes.
- **Model tiers:** screeners and scout on a cheap tier. Judgment roles on the strong tier. A research run has its own
  allowed list.

## 6. Fit with the code

### 6.1 Reuse without change

| Part | Use |
| --- | --- |
| `agent.ts`: `openAgent`, `runTurn`, `submitOnce` | every role |
| `ledger.ts`: `step` | every stage, partition and batch |
| `questions.ts`: `Channel`, `asker`, `/answer` | intake, pick, prereg approval, held objections, budget raises |
| `workspace.ts`: `readOnly`, `guard`, `allowFiles` | read-only skeptics, the builder's scope, the protected `prereg/` |
| `box.ts` | the box of each run |
| `platform.ts`: `Branches`, `PullRequests` | the notebook is a git repository. The dossier is a PR |
| the code review loop | the analysis code of the dossier PR |
| `cloudflare/runs.ts` | a `ResearchRuns` object, one per program |

### 6.2 Core changes

Each is a separate PR. Each is also useful to the other workflows, or is off for them.

| Change | Where | Why |
| --- | --- | --- |
| Usage and a cost budget | `agent.ts` (`model.call.completed` events), the ledger, the reports | G6. The host stops the fan-out at the cap and asks the user. |
| Artifacts | `platform.ts` and both platforms | A content-addressed store. Local: a directory. Cloudflare: the run's object storage. The ledger holds IDs, never bulk data. |
| Egress with provenance | `agent.ts` (`web_search`, `fetch`), `workspace.ts` (shell `fetch`) | A role can reach allowlisted origins. Each response is an artifact. The other roles stay offline. |
| Evidence on artifacts | `findings.ts` | A location can be `artifact:<id>` with a line or no line. The fragment rules stay. |
| `python` profile | `profiles.ts`, the build image | Notebooks are Python. The repository's setup installs the domain's packages. |
| Roles by workflow | `roles.ts` | The research roles in a table of their own. |
| A bounded pool | `plan.ts` (`waves`) | Sweeps, screens and generators. |

### 6.3 The domain, in the notebook

The research config is a `research` field of `.agent-factory.json` in the notebook, with files beside it. The host
reads it from the base branch, so a run cannot change its own rails.

```json
{
  "research": {
    "egress": ["archive.example.org", "export.arxiv.org"],
    "lenses": { "survey": ["literature", "known objects", "data coverage"], "skeptic": ["systematics", "contamination", "known", "statistics"] },
    "guides": "research/guides",
    "checklist": "research/checklist.md",
    "prereg_sections": ["Known set", "Injection grid", "Holdout"],
    "commands": { "known": "python -m search.known {prereg}", "inject": "python -m search.inject {prereg}" },
    "feeds": ["https://export.arxiv.org/rss/astro-ph"]
  }
}
```

agent-factory holds the roles and their generic guides (`agents/research/*.md`). The domain's guides add to them,
as profile guides do today.

### 6.4 New code

- `src/core/workflows/research.ts` and `src/core/workflows/scout.ts`.
- `src/core/research-steps.ts`: surveyor, generator, preregistrar, screener, skeptic, analyst and writer. The builder
  step is reused.
- `src/core/prereg.ts`: `submit_prereg`, the freeze and the holdout lock.
- `src/core/claims.ts`: the submit tools of the survey, hypotheses, labels, objections and the dossier.
- `src/core/sweep.ts`: partitions and the candidate table.
- `src/cloudflare`: `ResearchRuns`, `/research` on a notebook issue, and the scout cron.

## 7. Platforms

- **Cloudflare first.** One `ResearchRuns` object per program holds the ledger, the sessions and the artifacts. The
  box is the run's container, as for development runs. Scout is a cron trigger.
- **Local** runs the same workflow, for tests and for development of the workflow.
- **Large sweeps** go to a larger container, or to a rented machine through `httpBox`.
- **No mirrors.** Runs fetch queries, cutouts and per-target data. A program never copies a whole archive.

## 8. Trust boundary

- **Agents reach the network** through the host egress only: the domain's origins, GET and query requests, each one
  logged as an artifact.
- **The box reaches the network directly** today (`enableInternet`), for setup. The holdout lock thus binds agents and
  not commands. Gap RG1 closes this.
- **Credentials for a registered archive** stay in the egress, as model keys stay in the dispatch.
- **Fetched text can carry prompt injection.** The agents that read it write only in their scope and have no outward
  channel. Only the host posts.

## 9. Decisions

| # | Conflict | Decision |
| --- | --- | --- |
| RD1 | A swarm that agents steer, or fan-out that the host schedules | The host schedules. Agents get bounded subagents in a turn. |
| RD2 | Agents that look at each target, or code that sweeps | Code sweeps. Agents write the search, screen and vet. |
| RD3 | Blinding by prompt, or by data access | By data access: the egress refuses the holdout until the freeze. |
| RD4 | What counts as evidence | An artifact that a recorded command or fetch made, with a quote. |
| RD5 | PASS means a discovery, or a calibrated result | A calibrated result. |
| RD6 | The domain in agent-factory, or in the notebook | In the notebook. agent-factory holds only the workflow, the roles and the rails. |
| RD7 | Local or Cloudflare first | Cloudflare. Local for tests and development. |
| RD8 | One model tier, or tiers | Two tiers. The family swap holds for skeptics. |

## 10. Gaps

| # | Gap | Default |
| --- | --- | --- |
| RG1 | The box's own network access | The box reaches the network through the host egress, after setup. Until then, the report says that the holdout lock binds agents only. |
| RG2 | Cost (G6) | A cap per program, set at intake. The host pauses at 80% and asks. |
| RG3 | Data volume | No mirrors. Artifacts over a size limit stay on the box and are named by hash. |
| RG4 | Archives change | Each fetch records its hash and time. `reproduce` reports a drift. |
| RG5 | Many trials in one program | The host counts each trial. The dossier reports the count. |
| RG6 | Submission to outside bodies | A later workflow with a `/go` for an exact scope. |

## 11. Build plan

| Phase | Scope | Exit |
| --- | --- | --- |
| R0 | The core changes of section 6.2. | Each rail has tests. A scripted run fetches through the egress and cites an artifact. |
| R1 | The research workflow on Cloudflare: stages 0 to 6, 9 and 11, per-target analysis, no sweep and no holdout. | A notebook run recovers a known set blind, with a completeness curve, in a dossier PR. |
| R2 | The sweep, the screeners, the holdout lock and the trial count. | A program over thousands of targets ends in a vetted top few or a calibrated null. |
| R3 | Scout. | Four weekly digests, and one proposal that the user takes. |
| R4 | Submission with a `/go`. | One submission that the user approved. |
