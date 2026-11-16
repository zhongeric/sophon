# AGENTS.md

These are the rules for changes to agent-factory, for people and for coding agents. agent-factory also reviews its
own PRs, and its rules reviewer reads this file first.

## Commands

- `npm run check`: the types of the Node code, of the core without Node types, and of the Worker.
- `npm test`: the unit tests, both workflows against scripted models, and the Worker under wrangler dev.
- Run both before you push. CI runs both.

## Layout

- `src/core/` is platform-neutral. It must typecheck without Node types (`tsconfig.core.json`). Put Node code in
  `src/node/` and Worker code in `src/cloudflare/`.
- `agents/` holds the guidelines, one file for each role. When you add a guideline file, also add it to
  `src/cloudflare/guides.ts`. A test checks this.
- `docs/specs/development-workflow.md` is the design. Code comments refer to its decisions (D1, D7) and its gaps
  (G6). Do not change these IDs.
- `docs/specs/research-workflow.md` is the design of the research workflow, with its decisions (RD1) and gaps (RG1).
  The same rule applies to its IDs.

## Design rules

- The flow is code. The host decides what runs next, never an agent.
- When a program can check a rule, the host enforces it. Do not write it in a prompt. Guidelines carry only judgment.
- Each agent gets one role, a new session, its own workspace, and a submit tool whose input the host checks.
- Do not weaken a check, a test or a rail to make a change pass.

## Code style

- TypeScript as ES modules, run by Node with type stripping. Import with the `.ts` extension. Use only erasable
  syntax: no enums, no namespaces, no parameter properties.
- No semicolons, single quotes, and an indent of two spaces.
- Give an exported function or type a JSDoc comment when its name does not say enough. A comment tells why, not what.
- Match the code near your change: its names, its comment density and its idioms.

## Writing

- Say less. Each sentence gives the reader a fact that they need, one time. Prefer a list item, a table row or an
  example to a paragraph.
- Docs, comments and agent guidelines use Simplified Technical English for their words and grammar
  (`agents/shared/ste.md`, dictionary: `agents/guides/ste/README.md`). An STE fix never makes text longer.
- README.md tells a user how to install, configure and run agent-factory. `test/docs.test.ts` keeps it to 200 lines.
  Design, rationale and internals go to `docs/specs/` or to a code comment. Change the README only when a command, a
  setting or a behavior that users rely on changes, and replace text instead of appending it.
- Issues: the problem, the change and the done checks, in about 15 lines. Link the spec instead of copying it.
- PR descriptions: what changed, why, and how it was tested, in at most five bullets.
- Comments that the host posts: the result first, and the details in a collapsed block or in the run's report.
