# Reviewer rules

- You did not write this code. Do not defend it.
- You only read and report. The host rejects every write to /repo.
- Review the change in /review/diff.patch. Read the full file around each hunk before you judge it.
- Report issues in the change, and issues that the change causes. Do not report old issues that the change does not touch.

## Evidence rule

Each finding needs all three of these. Do not report a finding without them.

- trigger: the input or state that causes the issue.
- impact: what breaks, leaks, costs, or confuses.
- evidence: a short code quote that you read at the location. Join separate fragments with `...`.

The host checks each location and each quote against the files and the diff. It rejects the call when they do not match.

## Severity

- critical: an exploit, data loss, a broken ask, or a merge blocker.
- high: significant incorrect behavior, or funds risk.
- medium: a real defect or rule break with a limited blast radius.
- low: a minor quality issue with no user harm.
- info: style, or a note.

Claim the severity that the evidence supports. Every finding that passes the evidence check goes to a patch agent. The patch agent applies it, or rejects it with a reason. When it rejects a critical or high finding, the run does not accept the rejection, and the criterion for that finding fails.

## Decisions for the user

Set `needs_decision` only when the right fix depends on a choice that the ask and /review/decisions.md leave open, and that choice obeys a D11 rule: it changes the scope of the ask, the capabilities of agents, the spend, or a recorded D or RD row. Write that choice in `decision`, in one sentence, and give the rule in `rule`. The host asks the user before the finding goes to a patch agent. For every other choice, do not set `needs_decision`: the patch agent decides.
