# Solidity

The change touches Solidity or Foundry. When /guides/evm-cortex exists, read these before you judge:

- rules/solidity-style-guide.md, rules/security-first.md, rules/severity-matrix.md, rules/finding-output-format.md
- skills/solidity-security/SKILL.md, skills/solidity-patterns/SKILL.md, skills/natspec-standards/SKILL.md

Precedence: the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING, foundry.toml) come first. This page comes next. The files under /guides come last: where they disagree with this page, this page is correct.

## Style

- Pragma: fixed, never `^` or `>=`, in src/, tests, scripts and PoCs. Use the version that foundry.toml pins.
- Imports: named only, also in tests and PoCs: `import {Test} from "forge-std/Test.sol";`.
- Errors: custom errors with descriptive PascalCase names and no module prefix (`ManagerLocked`, `CurrencyNotSettled`). Declare them in the interface. No string `require`.
- Events: past tense for actions (`Deposited`, `Withdrawn`), and `<Thing>Updated` for configuration changes. A repository that already uses another style keeps it.
- Immutables: camelCase (`poolManager`). UPPER_SNAKE_CASE is for constants only.
- NatSpec: full NatSpec (`@notice`, `@param`, `@return`) on the interface, for functions, errors and events. Implementations use `@inheritdoc`. Internal and private functions get only `@dev`, and only when the code needs more context.
- Contract layout: using, structs and enums, constants, immutables, state (mappings, then scalars), events, errors, modifiers, constructor, then external, public, internal and private functions. Inside each visibility group, view and pure functions come last.

## Tests

- Plain tests: `test_{action}_{scenario}` in lower camel case, for example `test_swap_revertsWhenAmountIsZero`.
- Branching tree (BTT) tests, one test for each branch of a condition tree: `test_{Function}_{WhenCondition}[_{WhenCondition}...]_{outcome}`. Put an underscore between the branches. The outcome is `succeeds` or `revertsWith{Error}`. For example: `test_Swap_WhenLocked_revertsWithManagerLocked`, `test_Swap_WhenUnlocked_WhenAmountIsZero_revertsWithZeroAmount`, `test_Swap_WhenUnlocked_succeeds`.
- Fuzz, fork and invariant tests: `testFuzz_`, `testFork_` and `invariant_`, with the same shapes.
- Coverage gate in CI: 90% of lines, 80% of branches, 95% of functions. A repository can set higher numbers.

## Security

- Checks-effects-interactions everywhere. When the code follows it, it does not need `ReentrancyGuard`. Use a guard sparingly, and only where checks-effects-interactions cannot hold, for example a required external call in the middle of a state change. Do not report a missing guard on code that follows checks-effects-interactions.
- SafeERC20 for token transfers. `Ownable2Step` instead of `Ownable` when the contract has an owner. No `tx.origin` authorization.
- Use the severity matrix. A critical or high exploit claim needs PoC-quality evidence.

## Gas

- Do not review gas, and do not report gas findings, unless the ask is about gas.
