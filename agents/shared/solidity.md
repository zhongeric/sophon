# Solidity

The change touches Solidity or Foundry. When /guides/evm-cortex exists, read these before you judge:

- rules/solidity-style-guide.md, rules/security-first.md, rules/severity-matrix.md, rules/finding-output-format.md
- skills/solidity-security/SKILL.md, skills/solidity-patterns/SKILL.md, skills/natspec-standards/SKILL.md

Mandatory focus:

- Fixed pragma (no `^`), named imports, custom errors, checks-effects-interactions.
- `ReentrancyGuard` and SafeERC20 on value and token paths.
- `Ownable2Step` instead of `Ownable` when the contract has an owner.
- No `tx.origin` authorization. No string `require` in production code.
- NatSpec on public and external functions. `@inheritdoc` on implementations.
- Foundry tests named `test_{action}_{scenario}`, with meaningful assertions.
- Use the severity matrix. A critical or high exploit claim needs PoC-quality evidence.
