# Mainnet-Fork Test Setup and Troubleshooting

The mainnet-fork suite in `contracts/test/mainnet-fork/` runs Hardhat against an
in-process fork of Ethereum mainnet. It verifies the 1inch `EscrowFactory`
interface and WaffleFinance `HTLCEscrow` settlement against real mainnet
bytecode. The fork is local: **no transaction is ever broadcast to mainnet**.

This note explains how to run the focused suite, which environment variables it
reads, and how to tell an environment problem from a contract regression.

## What the suite does

- `contracts/test/mainnet-fork/setup.ts` activates the fork with
  `hardhat_reset` and a `forking` entry, then resets it in `after` hooks.
- Test accounts come from Hardhat's built-in signers; mainnet whales are
  accessed with `hardhat_impersonateAccount` and funded with
  `hardhat_setBalance`.
- New contracts (`HTLCEscrow`) and orders are created on the ephemeral fork
  chain only. The HTTP RPC endpoint is used read-only, to fetch mainnet state.
- The suite does **not** read `PRIVATE_KEY` / `RELAYER_PRIVATE_KEY`, and it
  never deploys to the `mainnet` network.

## Prerequisites

- Node.js >= 22 and pnpm 8.15.x (see the repository `engines` field).
- Dependencies installed from the repository root: `pnpm install`.
- Contracts compiled: `pnpm --filter @wafflefinance/contracts compile`.
- An Ethereum mainnet JSON-RPC endpoint. Archive access is only needed when a
  test pins a historical `blockNumber`; the current suite forks the latest block.

## Environment variables

The same precedence is used by `resolveMainnetRpc()` in
`contracts/test/mainnet-fork/setup.ts` and `resolveHardhatRpc("mainnet")` in
`contracts/hardhat.config.ts`:

| Priority | Variable | Resolves to |
|---|---|---|
| 1 | `MAINNET_RPC_URL` | The value as-is — preferred for fork tests |
| 2 | `ETHEREUM_RPC_URL` | Shared fallback endpoint |
| 3 | `INFURA_API_KEY` | `https://mainnet.infura.io/v3/<key>` |
| 4 | — | `https://ethereum-rpc.publicnode.com` (fork activation only) |

The public fallback in priority 4 is used only after a fork is activated.
`hasMainnetRpc()` decides whether the fork suites run, and it returns `true`
only when `MAINNET_RPC_URL`, `ETHEREUM_RPC_URL`, or `INFURA_API_KEY` is set.
Without one of those three variables the fork suites **skip** — they do not
silently fall back to the public node.

Contract addresses (priority 1, `MAINNET_RPC_URL`) are not secrets. Never
commit an Infura key or a private key.

## Focused command

From the repository root:

```bash
pnpm --filter @wafflefinance/contracts exec hardhat test test/mainnet-fork/escrow-factory.test.ts
```

Or from `contracts/`, running only the fork directory:

```bash
npx hardhat test test/mainnet-fork/ --network hardhat
```

With an explicit endpoint:

```bash
MAINNET_RPC_URL=https://<your-mainnet-endpoint> \
  pnpm --filter @wafflefinance/contracts exec hardhat test test/mainnet-fork/escrow-factory.test.ts
```

Run the suite on the in-process `hardhat` network (the default). Do **not** pass
`--network mainnet`: that selects the live-RPC network in
`contracts/hardhat.config.ts`, where `hardhat_reset` forking is not available.

## Recognising skipped tests

When none of the three RPC variables is set, the four fork suites are
registered with `describe.skip`. Mocha reports them as pending, for example:

```text
0 passing
42 pending
```

The two non-fork suites — `ABI branching — mainnet vs testnet selection` and
`Configuration validation — mainnet deployment checklist` — still execute.
Pending fork tests with no failures mean the environment is not configured;
they are not a contract regression.

To check whether the fork suites will run before invoking Hardhat:

```bash
node -e 'console.log(Boolean(process.env.MAINNET_RPC_URL || process.env.ETHEREUM_RPC_URL || process.env.INFURA_API_KEY))'
```

`true` means the fork suites run; `false` means they will be skipped.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Fork suites report as pending (`N pending`) | None of `MAINNET_RPC_URL`, `ETHEREUM_RPC_URL`, `INFURA_API_KEY` is set | Set `MAINNET_RPC_URL` (or one of the other two) |
| Tests error in a `before` hook instead of skipping | An RPC variable is set but the endpoint is unreachable or rate-limited | Verify the URL is a reachable Ethereum mainnet endpoint |
| `missing trie node`, `header not found`, or state-not-available errors | The fork targets a block older than the endpoint's prune window | Use an archive endpoint, or fork the latest block (omit `blockNumber`) |
| `mainnet chain ID is 1` fails | The endpoint points at Sepolia or another network | Use an Ethereum mainnet endpoint |
| `has contract code on mainnet` fails | The endpoint returned empty state (wrong network or a proxy error) | Confirm chain ID `1` and that the factory address resolves on mainnet |
| `401` / `403` / timeout from Infura | Missing or referrer-restricted `INFURA_API_KEY` | Set `MAINNET_RPC_URL` to a working endpoint instead |
| Suite passes but no fork tests appear in the output | Only the non-fork suites ran; fork suites were skipped | Set an RPC variable as described above |

A missing endpoint never produces a fork-test failure — it produces pending
tests. If the suite fails, the endpoint was reachable but the request itself
was rejected (for example, no archive access for the requested block).

## Related documents

- [Mainnet deployment checklist](./mainnet-deployment-checklist.md) — the
  post-deployment item that runs this suite.
- [Documentation map](../../docs/DOC_MAP.md) — index of all repository docs.
