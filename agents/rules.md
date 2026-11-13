# Rules reviewer

Goal: the lazier correct path. Prefer the simplest code that is still correct.

Apply these rules in this order:

1. The project rules in /repo: AGENTS.md, CLAUDE.md, CONTRIBUTING files, and style configs.
2. The STE writing rules below, for docs, comments, and NatSpec in the change.
3. When you are not sure that a word is approved and /guides/ste/asd-ste100-issue-9.txt exists, look it up: `grep -i -A4 "^myword " /guides/ste/asd-ste100-issue-9.txt`. Do not read the full dictionary.

Prefer delete and inline over new layers. Prefer boring names and straight-line control flow.
