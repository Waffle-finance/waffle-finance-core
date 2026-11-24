# Safe Recovery Guide

This guide explains how to verify order state and recover locked funds on
Ethereum, Stellar, and Solana when a WaffleFinance swap does not complete
normally. It is intended for end users, not operators.

**Key property:** WaffleFinance uses Hash Time-Lock Contracts (HTLCs). Once a
timelock expires, anyone — including you — can call `refundOrder` (Ethereum) or
`refund_order` (Stellar) directly from their own wallet, with no assistance
from the relayer, coordinator, or any other service. The contracts have no admin
escape hatch and no pause function. Only the two on-chain conditions (preimage
reveal before the timelock, or timelock expiry) can move your funds.

> **Never share your wallet seed phrase, private key, or HTLC preimage with
> anyone — not support staff, not a bot, not this documentation.** Recovery
> does not require any of those. If a website or person asks for them, it is a
> scam.

---

## Table of contents

- [Before you do anything](#before-you-do-anything)
- [Ethereum](#ethereum)
  - [Check order state on Ethereum](#check-order-state-on-ethereum)
  - [Claim (Ethereum)](#claim-ethereum)
  - [Refund (Ethereum)](#refund-ethereum)
  - [Deferred payout (pull-payment)](#deferred-payout-pull-payment)
  - [Ethereum troubleshooting](#ethereum-troubleshooting)
- [Stellar](#stellar)
  - [Check order state on Stellar](#check-order-state-on-stellar)
  - [Claim (Stellar)](#claim-stellar)
  - [Refund (Stellar)](#refund-stellar)
  - [Stellar troubleshooting](#stellar-troubleshooting)
- [Solana](#solana)
  - [Check order state on Solana](#check-order-state-on-solana)
  - [Solana troubleshooting](#solana-troubleshooting)
- [Cross-chain eligibility summary](#cross-chain-eligibility-summary)
- [Common error messages](#common-error-messages)
- [Related documents](#related-documents)

---

## Before you do anything

Collect the following before attempting any recovery step:

1. **Your order ID** — shown in the WaffleFinance UI after swap creation, also
   retrievable from the coordinator:
   ```
   GET https://<coordinator-url>/api/orders/<order-id>
   ```

2. **The chain your funds are locked on** — determined by swap direction:
   - ETH → XLM: funds locked on **Ethereum** first, then released on Stellar
   - XLM → ETH: funds locked on **Stellar** first, then released on Ethereum
   - Solana swaps: funds locked on **Solana**

3. **The on-chain order ID** — different from the coordinator's public order
   ID. It appears in the coordinator order record as `src.orderId` or
   `dst.orderId` depending on which chain you are recovering from.

4. **The timelock** — the Unix timestamp (seconds) after which a refund is
   eligible. Visible in the coordinator order record as `src.timelock` or
   `dst.timelock`.

**Check the coordinator first.** If the coordinator is reachable, fetch your
order and inspect its `status` and `isRefundable` fields:

```bash
curl https://<coordinator-url>/api/orders/<order-id>
```

| `status` | Meaning | Action |
|---|---|---|
| `announced` | Order registered; no funds locked yet | Nothing to recover |
| `src_locked` | Your funds are locked on the source chain | Wait for resolver, or refund after timelock |
| `dst_locked` | Both sides locked; resolver is filling the order | Wait for secret reveal |
| `completed` | Swap settled; funds delivered | Nothing to recover |
| `refunded` | On-chain refund confirmed | Nothing further needed |
| `expired` | Timelock passed, coordinator marked as expired | Trigger refund on-chain (see below) |
| `failed` | Swap failed; `isRefundable: true` means funds may still be locked | Trigger refund on-chain |

If the coordinator is unavailable, go directly to the on-chain steps below.

---

## Ethereum

### Check order state on Ethereum

The contract address for the HTLCEscrow is published in the WaffleFinance
deployment docs. Use Etherscan (mainnet) or the Sepolia Etherscan (testnet) to
inspect the contract.

**Via Etherscan read tab:**

1. Open the HTLCEscrow contract on Etherscan.
2. Under **Read Contract**, call `getOrder` with your on-chain order ID
   (the integer from `src.orderId` or `dst.orderId` in the coordinator
   record).
3. Check the returned `status` field:
   - `0` = `Funded` — funds are locked and eligible for claim or refund
   - `1` = `Claimed` — the preimage was revealed and funds were delivered
   - `2` = `Refunded` — a refund was already processed

4. Check the returned `timelock` field (Unix seconds). Compare it to the
   current time — `block.timestamp` on Etherscan's block explorer, or:
   ```bash
   date +%s   # current Unix time on your machine
   ```
   If `block.timestamp > timelock`, the order is eligible for refund.

**Via cast (Foundry):**

```bash
cast call <HTLC_CONTRACT_ADDRESS> \
  "getOrder(uint256)((address,address,address,address,uint256,uint256,bytes32,uint64,uint64,uint64,uint8,bytes32))" \
  <ORDER_ID> \
  --rpc-url <ETH_RPC_URL>
```

Replace `<HTLC_CONTRACT_ADDRESS>`, `<ORDER_ID>`, and `<ETH_RPC_URL>` with your
values.

### Claim (Ethereum)

> You need the **preimage** (the secret value whose hash equals the hashlock).
> The preimage is surfaced in the coordinator record under `secret.preimage`
> once the other side of the swap has been claimed. Never share it before
> your own claim is confirmed.

Call `claimOrder(uint256 orderId, bytes memory preimage)` before the timelock
expires:

**Via Etherscan write tab:**

1. Connect your wallet (must be any wallet — `claimOrder` is permissionless).
2. Call `claimOrder` with your on-chain `orderId` and the 32-byte `preimage`
   (hex, prefixed with `0x`).
3. Confirm the transaction and wait for it to be included in a block.

**Via cast:**

```bash
cast send <HTLC_CONTRACT_ADDRESS> \
  "claimOrder(uint256,bytes)" \
  <ORDER_ID> <PREIMAGE_HEX> \
  --rpc-url <ETH_RPC_URL> \
  --private-key <YOUR_WALLET_PRIVATE_KEY>
```

> Do not paste your private key into a shared terminal or chat. Use an
> environment variable: `--private-key $WALLET_KEY`.

### Refund (Ethereum)

> The timelock must have already passed (`block.timestamp > timelock`).
> There is no requirement to know the preimage for a refund.

Call `refundOrder(uint256 orderId)` — permissionless, any wallet can submit it:

**Via Etherscan write tab:**

1. Connect any wallet with enough ETH to pay gas.
2. Call `refundOrder` with your on-chain `orderId`.
3. Confirm the transaction. The locked amount returns to `refundAddress` (your
   original source wallet). The safety deposit goes to whoever submitted the
   transaction as a gas incentive.

**Via cast:**

```bash
cast send <HTLC_CONTRACT_ADDRESS> \
  "refundOrder(uint256)" \
  <ORDER_ID> \
  --rpc-url <ETH_RPC_URL> \
  --private-key <YOUR_WALLET_PRIVATE_KEY>
```

### Deferred payout (pull-payment)

If `claimOrder` or `refundOrder` succeeded but you have not yet received your
funds, the push transfer may have been deferred. Check your pending balance:

```bash
cast call <HTLC_CONTRACT_ADDRESS> \
  "pendingWithdrawals(address)(uint256)" \
  <YOUR_WALLET_ADDRESS> \
  --rpc-url <ETH_RPC_URL>
```

If the returned value is non-zero, call `withdraw()` to collect it:

**Via Etherscan write tab:**

1. Connect the wallet that is owed the funds.
2. Call `withdraw()` with no arguments.

**Via cast:**

```bash
cast send <HTLC_CONTRACT_ADDRESS> \
  "withdraw()" \
  --rpc-url <ETH_RPC_URL> \
  --private-key <YOUR_WALLET_PRIVATE_KEY>
```

### Ethereum troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `NotExpired` | Timelock has not passed yet | Wait until `block.timestamp > timelock` |
| `OrderNotRefundable` | Order is already Claimed or Refunded | Nothing to do — funds already moved |
| `OrderNotFound` | Wrong order ID | Check `src.orderId` vs `dst.orderId` in coordinator record |
| `InvalidPreimage` | Preimage does not match hashlock, or is not 32 bytes | Verify `secret.preimage` from coordinator; ensure it is hex-encoded with `0x` prefix |
| `Expired` | Timelock already passed when you tried to claim | Call `refundOrder` instead |
| `NoPendingWithdrawal` | Nothing pending for your address | Check you used the correct wallet address |
| Transaction reverts with no message | Wrong network | Confirm Metamask/wallet is on the correct network (mainnet vs Sepolia) |

---

## Stellar

### Check order state on Stellar

The WaffleFinance Stellar HTLC is a Soroban smart contract. Use Stellar Expert
(`stellar.expert`) or the Horizon API to inspect contract state.

**Via Stellar Expert:**

1. Navigate to `stellar.expert/explorer/public/contract/<CONTRACT_ID>`.
2. Under **Contract Storage**, look for the order entry with your on-chain
   order ID (from `src.orderId` or `dst.orderId`).
3. The `status` field maps as:
   - `Funded` — locked, eligible for claim or refund
   - `Claimed` — preimage revealed, funds delivered
   - `Refunded` — already refunded

**Via Horizon RPC (Soroban):**

```bash
curl "https://soroban-testnet.stellar.org" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getLedgerEntries",
    "params": {
      "keys": ["<BASE64_ENCODED_ORDER_KEY>"]
    }
  }'
```

The `timelock` field in the order is a Unix timestamp. If the current ledger
timestamp (available from `getLatestLedger`) exceeds it, a refund is eligible.

**Check the current ledger time:**

```bash
curl "https://soroban-testnet.stellar.org" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'
```

The `closeTime` field in the response is the current ledger Unix timestamp.

### Claim (Stellar)

> You need the **preimage** from the coordinator record (`secret.preimage`).
> The timelock must not have passed yet.

The contract function is `claim_order(order_id: u64, preimage: Bytes, caller: Address)`.
The `caller` must authorise the transaction (it is the wallet submitting the
claim).

**Via Stellar Laboratory or Freighter wallet:**

1. Open Stellar Laboratory (`laboratory.stellar.org`) and select
   **Invoke Contract**.
2. Set the contract ID to the WaffleFinance Soroban HTLC contract address.
3. Set the function name to `claim_order`.
4. Supply the arguments:
   - `order_id`: your on-chain order ID (u64)
   - `preimage`: the 32-byte secret as hex bytes
   - `caller`: your Stellar account address (G...)
5. Sign and submit with your Stellar wallet. Freighter or any Stellar-compatible
   wallet that supports Soroban contract invocations works.

**Via Stellar CLI:**

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <YOUR_STELLAR_SECRET_KEY_OR_ACCOUNT_ALIAS> \
  --network testnet \
  -- claim_order \
  --order_id <ORDER_ID> \
  --preimage <PREIMAGE_HEX> \
  --caller <YOUR_STELLAR_ADDRESS>
```

Replace `testnet` with `mainnet` for production. The `--source` argument takes
a secret key or a named account from your Stellar CLI config — it does not
appear in any log or on-chain state.

> Do not paste your Stellar secret key (`S...`) into a shared terminal, chat,
> or document. Use `stellar keys add` to store it locally under an alias.

### Refund (Stellar)

> The timelock (ledger timestamp) must have already passed. No preimage needed.

The contract function is `refund_order(order_id: u64, caller: Address)`.
Any account can submit it.

**Via Stellar Laboratory:**

1. Open Stellar Laboratory and select **Invoke Contract**.
2. Set the contract ID and function name `refund_order`.
3. Supply `order_id` and `caller` (your Stellar address).
4. Sign and submit.

**Via Stellar CLI:**

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <YOUR_STELLAR_SECRET_KEY_OR_ACCOUNT_ALIAS> \
  --network testnet \
  -- refund_order \
  --order_id <ORDER_ID> \
  --caller <YOUR_STELLAR_ADDRESS>
```

The locked amount returns to the `refund_address` recorded in the order
(your original source wallet). The safety deposit goes to `caller` as a
gas incentive.

**Archived contract entries:** Soroban uses a TTL-based archival model. If the
order entry has been archived (the swap has been inactive for a very long time),
you must restore it before calling `refund_order`. The entry can be restored
with a `RestoreFootprint` operation, which does not require any special
permissions and does not modify the order:

```bash
stellar contract restore \
  --id <CONTRACT_ID> \
  --source <ANY_STELLAR_ACCOUNT_ALIAS> \
  --network testnet \
  --key <ORDER_LEDGER_KEY>
```

After restoration, the timelock and hashlock conditions are unchanged — the
refund proceeds normally.

### Stellar troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Error::NotExpired` | Ledger timestamp has not passed `timelock` | Wait until the current ledger `closeTime` exceeds the order `timelock` |
| `Error::OrderNotRefundable` | Order is already Claimed or Refunded | Nothing to do |
| `Error::OrderNotFound` | Wrong order ID or entry has been archived | Check `src.orderId`; if archived, restore the entry first (see above) |
| `Error::InvalidPreimage` | sha256(preimage) does not match hashlock | Verify `secret.preimage` from coordinator record |
| `Error::Expired` | Timelock passed before your claim | Call `refund_order` instead |
| `Error::ContractMode` / paused | Contract in Paused or Maintenance mode | Existing orders can still be refunded via `refund_order` (Maintenance mode allows refunds); check operator announcements |
| Simulation fails with "entry not found" | Order entry archived | Run `stellar contract restore` to unarchive, then retry |

---

## Solana

Solana HTLC program support is under active development. The on-chain program
address is configured via `SOLANA_HTLC_PROGRAM` / `SOLANA_HTLC_PROGRAM_MAINNET`
in the relayer environment.

### Check order state on Solana

**Check whether Solana is configured:**

```bash
curl https://<relayer-url>/readyz | jq '.checks[] | select(.name == "solana_rpc")'
```

If `detail` is `"disabled_placeholder"`, Solana swaps are not yet live on this
deployment.

**Via Solana Explorer:**

1. Navigate to `explorer.solana.com`.
2. Look up the HTLC program account using the program ID from the deployment.
3. Find the order PDA (Program Derived Address) for your swap. The coordinator
   record's `src.orderId` contains the identifier needed to derive the PDA.

**Via Solana CLI (`solana` / `spl-token`):**

```bash
solana account <ORDER_PDA_ADDRESS> \
  --url <SOLANA_RPC_URL> \
  --output json
```

Inspect the `timelock` field in the decoded account data. If the current slot
time (`solana block-time <SLOT>`) exceeds it, a refund is eligible.

**Claim and refund on Solana** follow the same logical flow as Ethereum and
Stellar — call the program's claim or refund instruction with the order PDA.
Specific Solana wallet steps (Phantom, Backpack, `anchor` CLI) depend on the
deployed program interface and will be documented here once the program is in
production. If your Solana swap is stuck, contact support through the official
Discord channel.

### Solana troubleshooting

| Symptom | Check |
|---|---|
| Relayer reports `solana_rpc: disabled_placeholder` | Solana swaps not yet live; contact support |
| Order stuck in `src_locked` on Solana | Verify the timelock has passed; use Solana Explorer to inspect the order PDA |
| Claim reverts | Confirm you have the correct preimage and that the timelock has not expired |
| Refund reverts | Confirm the timelock has passed and the order is still in `Funded` state |

---

## Cross-chain eligibility summary

| Situation | Eligible action | Chain to act on |
|---|---|---|
| Timelock **not yet passed**, preimage **known** | Claim | The chain where your order is `src_locked` |
| Timelock **passed**, any state | Refund | The chain where your order is `src_locked` |
| Swap completed but funds not received | Check pull-payment balance | Ethereum: `pendingWithdrawals`; Stellar/Solana: delivery is push-only |
| Coordinator says `completed` but on-chain shows `Funded` | Refund (after timelock) or await relayer | On-chain state is authoritative; coordinator may lag briefly |
| Both `claimOrder` and `refundOrder` revert | Order is already finalised | Verify on-chain status — `Claimed` or `Refunded` means funds already moved |

---

## Common error messages

| Error | Plain meaning |
|---|---|
| `NotExpired` / `Error::NotExpired` | The timelock has not passed yet. Wait and retry. |
| `OrderNotRefundable` / `Error::OrderNotRefundable` | The order is already Claimed or Refunded. Nothing further to do. |
| `OrderNotFound` / `Error::OrderNotFound` | Wrong order ID, wrong network, or (Stellar) archived entry. |
| `InvalidPreimage` / `Error::InvalidPreimage` | The preimage you supplied does not match the hashlock. Double-check the value from the coordinator. |
| `Expired` / `Error::Expired` | The timelock passed before your claim arrived. Call refund instead. |
| `NoPendingWithdrawal` | No deferred Ethereum payout for your address. |

---

## Related documents

- [Bug Triage Guide](BUG_TRIAGE.md) — severity classification and escalation for suspected funds-at-risk issues
- [Incident Response Checklist](INCIDENT_RESPONSE_CHECKLIST.md) — operator steps for funds-at-risk incidents
- [Deployment Rollback Runbook](DEPLOYMENT_ROLLBACK_RUNBOOK.md) — service restart and rollback procedures
- [Operations Guide](OPERATIONS.md) — full operator reference including chain-specific runbooks
