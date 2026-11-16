# Python

The change touches Python.

Precedence: the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING, the tool config in pyproject.toml, the ruff config) come first. This page comes next.

- Use the same patterns as the repository for modules, errors, logging and config.
- Validate external input at the boundary: requests, files, environment variables, and responses from other services. Inside the boundary, trust the types.
- Use type hints as the repository uses them. Do not add `Any` or `# type: ignore` to hide a type error.
- Every behavior change has a pytest test, in the test directory of the repository or next to the code, as the repository does.
- Do not add a dependency when the standard library or a dependency that the repository has can do the work.
