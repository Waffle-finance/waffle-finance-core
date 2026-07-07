## Description

<!-- Briefly describe the change and why it's needed. Link the issue if applicable. -->

## Checklist

### Tests
- [ ] TypeScript tests pass (`pnpm test`)
- [ ] Solidity Hardhat tests pass or updated
- [ ] Foundry fuzz/invariant tests pass or updated (`forge test`)
- [ ] Soroban Rust tests pass or updated (`cargo test`)

### Documentation
- [ ] Inline docs added for public APIs and complex logic
- [ ] README or `docs/` updated if user-facing behaviour changed
- [ ] Migration guide noted if breaking change

### Migrations & Configuration
- [ ] New SQL migration added (if schema changed)
- [ ] Contract deployment artifact or config updated
- [ ] `env.example` updated if new env vars introduced

### Performance & Security
- [ ] Gas impact considered (run `forge snapshot` if contracts changed)
- [ ] No new Slither warnings introduced
- [ ] Access controls and input validation reviewed for unsafe edges
- [ ] Secret/private key material never logged or committed
