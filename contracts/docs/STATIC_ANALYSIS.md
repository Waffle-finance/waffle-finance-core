# Solidity Static Analysis

## Tool

[Slither](https://github.com/crytic/slither) v0.10.4 is the pinned static
analyser for the WaffleFinance EVM contracts. It is selected because:

- It supports `solc 0.8.24` (the pinned compiler) and `via_ir` pipelines.
- It surfaces classes of issues (reentrancy paths, shadowed state variables,
  missing access controls, integer overflow in unchecked blocks) that fuzz
  and unit tests do not cover.
- Its JSON output is machine-readable and can be diffed across releases to
  identify net-new findings without reviewing previously accepted results.

## Running Locally

```bash
# Install (once)
pip install slither-analyzer==0.10.4
pip install solc-select && solc-select install 0.8.24 && solc-select use 0.8.24

# From the contracts/ directory
pnpm run analyze         # human-readable output to stdout
pnpm run analyze:json    # writes slither-report.json
pnpm run analyze:ci      # exits non-zero if any HIGH-confidence finding is new
```

## Scope

The analysis covers `contracts/contracts/` (first-party source files only).
Vendored libraries and `lib/forge-std` are excluded via the
`filter_paths` key in `.slither.config.json`.

## Baseline Handling

`contracts/.slither-baseline.json` holds the inventory of findings that have
been reviewed and accepted. The file starts empty; a finding is only added
after a reviewer has:

1. Confirmed it is a true-positive or false-positive.
2. Documented **owner**, **rationale**, and **expiration date** (or "permanent"
   for structural false-positives).
3. Opened a PR that modifies **only** `.slither-baseline.json` for that entry.

Format for each entry:

```json
{
  "id": "<slither-finding-id>",
  "detector": "reentrancy-eth",
  "contract": "HTLCEscrow",
  "function": "_payoutNative",
  "owner": "@handle",
  "rationale": "nonReentrant guard on all entry points; _payoutNative is private and only called after state finalisation.",
  "expiration": "permanent"
}
```

## CI Gate

The `slither` job in `.github/workflows/foundry-contracts.yml` runs on every
PR that touches `contracts/**`. It:

1. Runs `pnpm run analyze:ci` with `--fail-high`.
2. Uploads `slither-report.json` as a build artifact regardless of outcome.
3. Fails the job if any HIGH-confidence finding is not in the baseline.

A PR that introduces a new high-confidence finding **must** either fix the
finding or add a reviewed baseline entry before it can be merged.

## Reviewing New Findings

When CI reports a new finding:

1. Download `slither-report.json` from the Actions artifact panel.
2. Run `slither contracts/ --config-file .slither.config.json` locally to
   reproduce the finding interactively.
3. Determine whether it is a true-positive (fix the contract) or a
   false-positive / accepted risk (add a baseline entry).
4. For accepted-risk entries, follow the baseline format above and obtain
   sign-off from at least one additional reviewer familiar with the finding
   category.

## Known False-Positive Classes

| Detector | Why it fires | Verdict |
|---|---|---|
| `assembly` | `_bytesToBytes32` uses inline assembly for a bytes→bytes32 cast | False-positive — no memory safety risk; function is private and input is validated (preimage length checked before call). |
