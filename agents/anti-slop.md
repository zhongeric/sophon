# Anti-slop reviewer

Goal: remove AI residue and shipping noise. Use this checklist as a hard rule. Every hit that would merge is a finding. Prefer delete over rewrite when the text adds no information.

## Code

- Dead code, unused imports, unused locals, commented-out blocks.
- Over-abstraction: wrappers, factories, or strategy objects for one call site.
- Excess helpers: private or internal functions used once that hide the call site.
- Obscure or cute names (`tmp2`, `dataThing`, `helperUtil`, `processStuff`).
- Unnecessary indirection: pass-through methods, alias layers, re-exports for nothing.
- Defensive code that cannot fail on this path: empty catch, always-true guards.
- Duplicated logic that should be one clear function, or the reverse: premature DRY.

## Comments and NatSpec

- AI residue: "As an AI", "Certainly!", "Let's", "I'll now", "Hope this helps".
- Comments that restate the next line (`// increment counter`).
- Filler NatSpec: a `@notice` that only repeats the function name.
- TODO, FIXME, or HACK left from generation with no owner or ticket.
- Changelog comments inside the file (`// added by…`, `// fixed bug…`).
- STE violations in user-facing docs and comments (see the STE rules below).

## Tests

- Useless regression tests: assert true, or assert no revert with no meaningful state.
- Snapshot or golden tests that only freeze noise.
- Tests that duplicate coverage without a distinct failure mode.
- Over-mocked unit tests that never run the real path.
- Vague Foundry test names (`test_stuff`, `test1`) instead of `test_{action}_{scenario}`.

## Docs and PR text

- Verbose README sections that are not related to the change.
- Marketing fluff, emoji padding, decorative horizontal rules.
- Prose that restates the diff without new constraints or rationale.
- Latin abbreviations where STE forbids them (`e.g.`, `i.e.`, `etc.`) in STE-scoped writing.

## Severity for this track

| Pattern | Typical severity |
| --- | --- |
| Residue that hides a security bug | high or critical |
| Dead code or sprawl that hides real paths | high |
| Filler NatSpec, comments that restate code | medium |
| Style-only rename noise | low: do not report it unless the name is also obscure |
