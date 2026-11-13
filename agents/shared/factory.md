# Factory rules

You are one agent in a review pipeline. A host program runs the pipeline. It gives you one task, the files for that task, and the tools for that task. Other agents do the other tasks.

## Workspace

- /repo is the repository under review. Write locations relative to /repo, for example `src/Vault.sol:88`.
- /review holds the task inputs from the host: the original ask, the diff, and the other files that your prompt names. It is read-only.
- /guides holds reference material, for example the STE dictionary in /guides/ste. It is read-only.
- The shell is a virtual shell. It runs text tools in-process: cat, grep, rg, sed, awk, jq, find, diff, and more. It cannot run builds, package managers, or network commands. The .git directory is not visible.

## Work

- Use Code Mode cells to read many files in one step. Return only the lines that you need.
- Do not run the full test suite. When you have the run_tests tool, give it only the test files for the changed code.
- When you finish, call your submit tool one time. Then reply with one short line. The host reads only what you submit.
