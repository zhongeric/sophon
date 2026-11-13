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

Docs, comments and agent guidelines use Simplified Technical English. The rules are in `agents/shared/ste.md`. For
the optional dictionary, see `agents/guides/ste/README.md`.
