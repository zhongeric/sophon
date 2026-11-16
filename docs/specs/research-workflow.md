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
- **The domain** is the notebook's research config (section 6.3): its data origins, holdout, guides, checklist and
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
| 4 Prereg | plan (one planner, D7) | one preregistrar | The core sections and the domain's sections. The host commits `prereg/<hypothesis>-v<n>.md`, records its hash, and protects the path. A change is a new version with a reason. |
| 5 Build | build | builder, on a branch of the notebook | Writes only `analysis/<id>/`. Checkpoints and static rules as today. |
| 6 Calibrate | done-looks-like | host | Runs the domain's `known` and `inject` commands on the search partition. Recall under the prereg threshold goes back to the builder, in two rounds at most. After the second round, the host stops with a blocker and asks the user. |
| 7 Sweep | none | host, on the box | Runs the domain's `sweep` command at the frozen commit in a bounded pool. Each partition is a ledger step. Results go to artifacts. |
| 8 Screen | light reviewer | screeners on a cheap model, in batches | Each label cites an artifact. One screener labels each batch. A `not sure` label goes to a second screener on the other family. |
| 9 Vet | full review loop | skeptic tracks. Then the analyst answers, as the patch agent does. Then late skeptics on the other family | Context-free skeptics. The evidence check on artifacts. The analyst lists every objection as addressed or conceded. A conceded critical or high objection goes to the user. The domain's checks are host findings. |
| 10 Holdout | none | host | The egress refuses the holdout to agents from the start of the run. It refuses the holdout to box commands only after RG1. The host permits only `evaluate` in stage 10 and `reproduce` in stage 11 to read the holdout. In this stage, the host runs the domain's `evaluate` command on the holdout, with the frozen prereg. Its output is the outcome: recovered, inconsistent, excluded or insufficient. |
| 11 Dossier | ready PR | writer, then the code review loop on the analysis code | Each number cites an artifact. Each item of the domain's checklist has a status: ruled out, open or not tested. Coverage and completeness. The host runs the domain's `reproduce` command on a clean box and compares the hashes. |

## 4. Research rules as rails

| Rule | How the host enforces it |
| --- | --- |
| Recover known objects before you trust a search | The prereg names a known set and a recall threshold. Stage 6 runs it. The sweep does not start under the threshold. |
| Measure completeness and false positives with injections | The domain's `inject` command. The dossier requires the completeness and false-positive artifacts. |
| Write thresholds and predictions before the data | The prereg is frozen: a hash in the ledger and a protected path. The domain config defines the holdout on the base branch. The egress refuses the holdout to agents from the start of the run. It refuses the holdout to box commands only after RG1. Only the host uses it, in stages 10 and 11. |
| A fresh session challenges the analysis | Skeptics are new sessions that never see the analyst's conversation. Late skeptics use the other model family. |
| Reproduce | Each fetch is an artifact with its URL, query, time and hash. The host runs the domain's `reproduce` command before the dossier PR. |
| Publish nulls | A calibrated null is a PASS, with coverage, completeness and the count of trials in the program. |
| Say what is ruled out | The dossier gives each item of the domain's checklist a status and its evidence. |

## 5. The swarm

- **Breadth:** the host maps one role over many items (lenses, candidate batches, partitions) in a bounded pool. Each
  item is a ledger step, so a resumed run does not run it again.
- **Depth:** inside one turn, a surveyor or the analyst can start nanocode subagents, as builders can.
  Only the root agent submits. Today the host sets no limit on the count or the budget of subagents. Section 6.2 adds
  these limits for each role.
- **Diversity:** generators and skeptics get different model families and different lenses, because agents of one
  family can share a mistake. The family-swap check applies to the skeptic passes.
- **Model tiers:** screeners on a cheap tier. Judgment roles on the strong tier. A research run has its own
  allowed list.

## 6. Fit with the code

### 6.1 Reuse without change

| Part | Use |
| --- | --- |
| `agent.ts`: `runTurn`, `submitOnce` | every role |
| `ledger.ts`: `step` | every stage, partition and batch |
| `questions.ts`: `Channel`, `asker`, `/answer` | intake, pick, prereg approval, held objections, budget raises |
| `workspace.ts`: `readOnly`, `guard`, `allowFiles` | read-only skeptics, the builder's scope, the protected `prereg/` |
| `cloudflare/box.ts`: `Box`. Locally, `Machine` (`checks.ts`, `node/machine.ts`) | the box of each run on Cloudflare, and the machine of a local run |
| `platform.ts`: `Branches`, `PullRequests` | the notebook is a git repository. The dossier is a PR |
| the code review loop | the analysis code of the dossier PR |
| `cloudflare/runs.ts` | a `ResearchRuns` object, one per program |

### 6.2 Core changes

Each is a separate PR. Each is also useful to the other workflows, or is off for them.

| Change | Where | Why |
| --- | --- | --- |
| Usage and a cost budget | `agent.ts` (`model.call.completed` events), the ledger, the reports | G6, RG2. |
| Artifacts | `platform.ts` and both platforms | A content-addressed store. Local: a directory. Cloudflare: the run's object storage. The ledger holds IDs, never bulk data. |
| Egress with provenance | `agent.ts` (`web_search`, `fetch`), `workspace.ts` (shell `fetch`) | A role can reach allowlisted origins. The design requires the egress to refuse the holdout to agents from intake and set a maximum size for each request. Each response body is an artifact. The other roles stay offline. `egress.ts` has the egress and the run lock. The egress does not yet set a maximum size for a request. It sets one for each response. Each response also has a JSON provenance record as a second artifact, with its ID in the `x-provenance-id` header. `openAgent` uses the egress. The shell uses it only when the host gives `hostFetch` to the workspace layout. |
| Evidence on artifacts | `findings.ts` | A location can be `artifact:<id>` with a line or no line. The fragment rules stay. |
| `python` profile | `profiles.ts`, the build image | Notebooks are Python. The repository's setup installs the domain's packages. |
| Roles by workflow | `roles.ts` | The research roles in a table of their own. |
| A bounded pool | `plan.ts` (`waves`) | Sweeps, screens and generators. |
| Subagent limits | `agent.ts` (`openAgent`) | RD1. The host sets the count and the budget of subagents for each role. |

### 6.3 The domain, in the notebook

The research config is a `research` field of `.agent-factory.json` in the notebook, with files beside it. The host
reads it from the base branch, so a run cannot change its own rails.

```json
{
  "research": {
    "egress": ["archive.example.org", "export.arxiv.org"],
    "holdout": "research/holdout.json",
    "lenses": { "survey": ["literature", "known objects", "data coverage"], "skeptic": ["systematics", "contamination", "known", "statistics"] },
    "guides": "research/guides",
    "checklist": "research/checklist.md",
    "prereg_sections": ["Known set", "Injection grid", "Holdout"],
    "commands": {
      "known": "python -m search.known {prereg}",
      "inject": "python -m search.inject {prereg}",
      "sweep": "python -m search.sweep {prereg} {partition}",
      "evaluate": "python -m search.evaluate {prereg}",
      "reproduce": "python -m search.reproduce {prereg}"
    }
  }
}
```

The `holdout` file names the targets and the query ranges that the egress refuses. The host reads it at intake.
The egress refuses the holdout to agents from the start of the run, before a prereg exists.
The prereg section "Holdout" refers to this file and does not define the holdout.

The host takes the command strings from the base branch. `{prereg}` is the path of the frozen prereg, and
`{partition}` identifies the current data partition.

agent-factory holds the roles and their generic guides (`agents/research/*.md`). The domain's guides add to them,
as profile guides do today.

### 6.4 New code

- `src/core/workflows/research.ts`.
- `src/core/research-steps.ts`: surveyor, generator, preregistrar, screener, skeptic, analyst and writer. The builder
  step is reused.
- `src/core/prereg.ts`: `submit_prereg` and the freeze.
- `src/core/claims.ts`: the submit tools of the survey, hypotheses, labels, objections and the dossier.
- `src/core/sweep.ts`: partitions and the candidate table.
- `src/cloudflare`: `ResearchRuns` and `/research` on a notebook issue.

## 7. Platforms

- **Cloudflare first.** One `ResearchRuns` object per program holds the ledger, the sessions and the artifacts. The
  box is the run's container, as for development runs.
- **Local** runs the same workflow, for tests and for development of the workflow.
- **Large sweeps** go to a larger container.
- **No mirrors.** Runs fetch queries, cutouts and per-target data. A program never copies a whole archive.

## 8. Trust boundary

- **Agents reach the network** through the host egress only: the domain's origins, GET and query requests, each one
  logged as an artifact. The egress sets a maximum size for each request.
- **The box reaches the network directly** today (`enableInternet`), for setup. The holdout lock thus binds agents and
  not commands. Also, a box command can send notebook data or holdout data out of the run.
  Gap RG1 closes these two problems.
- **Credentials for a registered archive** stay in the egress, as model keys stay in the dispatch.
- **Fetched text can carry prompt injection.** The agents that read it write only in their scope. Only the host posts.
  Two outward channels stay: the egress requests of agents, and the box network for the code that a builder writes.
  The egress permits only allowlisted origins and small requests. It logs each request as an artifact.
  RG1 closes the box channel.

## 9. Decisions

| # | Conflict | Decision |
| --- | --- | --- |
| RD1 | A swarm that agents steer, or fan-out that the host schedules | The host schedules. Agents get bounded subagents in a turn. |
| RD2 | Agents that look at each target, or code that sweeps | Code sweeps. Agents write the search, screen and vet. |
| RD3 | Blinding by prompt, or by data access | By data access: the domain config defines the holdout. The egress refuses the holdout to agents from the start of the run. It refuses the holdout to box commands only after RG1. Only the host evaluates it, in stage 10. |
| RD4 | What counts as evidence | An artifact that a recorded command or fetch made, with a quote. |
| RD5 | PASS means a discovery, or a calibrated result | A calibrated result. |
| RD6 | The domain in agent-factory, or in the notebook | In the notebook. agent-factory holds only the workflow, the roles and the rails. |
| RD7 | Local or Cloudflare first | Cloudflare. Local for tests and development. |
| RD8 | One model tier, or tiers | Two tiers. The family swap holds for skeptics. |

## 10. Gaps

| # | Gap | Default |
| --- | --- | --- |
| RG1 | The box's own network access | The box reaches the network through the host egress, after setup. Until then, the report says that the holdout lock binds agents only, and that box commands can send data out of the run. |
| RG2 | Cost (G6) | A cap per program, set at intake. The host pauses and asks at 80% of the cap. At the cap, the host stops the fan-out. |
| RG3 | Data volume | No mirrors. Artifacts over a size limit stay on the box and are named by hash. |
| RG4 | Archives change | Each fetch records its hash and time. `reproduce` reports a drift. |
| RG5 | Many trials in one program | The host counts each trial. The dossier reports the count. |
| RG6 | Submission to outside bodies | A later workflow with a `/go` for an exact scope. |
| RG7 | New developments: papers, alerts and data releases | Not in this spec. A later, separate workflow can read the domain's feeds and open proposal issues. A proposal becomes a program only when the user labels it. |
| RG8 | Large sweeps on a rented machine | Not in R0. Large sweeps use a larger container. A remote box for a rented machine is a later change. |
| RG9 | Programs in one notebook share the holdout | After the first outcome, the holdout is not blind to later programs. The dossier reports the count of holdout tests across the notebook. |

## 11. Build plan

| Phase | Scope | Exit |
| --- | --- | --- |
| R0 | The core changes of section 6.2, with the holdout lock for agents. | Each rail has tests. A scripted run fetches through the egress and cites an artifact. |
| R1 | The research workflow on Cloudflare: stages 0 to 6, 9 and 11, per-target analysis, no sweep and no holdout test. | A notebook run recovers a known set blind, with a completeness curve, in a dossier PR. |
| R2 | The sweep, the screeners, the holdout test (stage 10) and the trial count. | A program over thousands of targets ends in a vetted top few or a calibrated null. |
| R3 | Submission with a `/go`. | One submission that the user approved. |
