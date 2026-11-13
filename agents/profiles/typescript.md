# TypeScript

The change touches TypeScript or JavaScript.

Precedence: the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING, tsconfig, lint config) come first. This page comes next.

- Use the same patterns as the repository for modules, errors, logging and config.
- Validate external input at the boundary: requests, files, environment variables, and responses from other services. Inside the boundary, trust the types.
- Do not weaken types to make code compile: no new `any`, unchecked casts, or non-null assertions that hide a real null.
- Every behavior change has a test, next to the code or in the test directory of the repository. External interfaces get integration tests.
