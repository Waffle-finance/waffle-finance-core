# Relayer network and escrow-factory ABI reference

The runtime ABI definitions and selector live in
[`src/config/networks.ts`](src/config/networks.ts). These are hand-maintained
interface fragments, not proof that a deployed contract implements every method.

| Mode / networks | Selected adapter and interface source | Creation call | Events in the selected ABI | Coverage and limitations |
| --- | --- | --- | --- | --- |
| `testnet`: Ethereum Sepolia (11155111), Stellar testnet | `createNetworkAdapter('testnet')`; `getEscrowFactoryABI(false)` returns `TESTNET_ESCROW_FACTORY_ABI`, the custom deployed EscrowFactory interface recorded in `networks.ts`. The custom factory Solidity source is not vendored in this checkout. | `createEscrow(config)`; token and beneficiary are addresses, with a single timelock and an escrow ID return value. | `EscrowCreated`, `EscrowFunded`, `EscrowClaimed`, `EscrowRefunded` | Offline ABI-selection assertions exist in `contracts/test/mainnet-fork/escrow-factory.test.ts`. They do not execute the deployed Sepolia factory. Deployed factory compatibility is **unverified here**; record separate integration evidence for a release. |
| `mainnet`: Ethereum (1), Stellar public network | `createNetworkAdapter('mainnet')`; `getEscrowFactoryABI(true)` returns `MAINNET_ESCROW_FACTORY_ABI`, the 1inch EscrowFactory interface fragments recorded in `networks.ts`. No upstream factory Solidity implementation is vendored here. | `createDstEscrow(dstImmutables, srcCancellationTimestamp)`; numeric maker/taker/token fields, packed timelocks, and no escrow ID return value. | `DstEscrowCreated`, `SrcEscrowCreated` | Offline selection and encoding assertions exist. Optional mainnet-fork tests cover factory reads, deterministic address resolution, and the creation selector. Fork blocks skip without configured RPC access. The settlement block tests WaffleFinance `HTLCEscrow`, **not end-to-end 1inch factory settlement**. Full relayer mainnet creation/event/settlement compatibility remains **untested by that suite**. |

## How selection reaches runtime

- `createNetworkAdapter(mode)` defaults to `testnet` and selects by
  `mode === 'mainnet'`. The low-level `getEscrowFactoryABI` takes a boolean.
- `getNetworkConfig(networkMode, defaultMode)` uses the default only when the
  requested mode is omitted; an unknown explicit mode throws.
- [`src/routes/orders.ts`](src/routes/orders.ts) encodes `createDstEscrow`
  with the mainnet ABI in its mainnet ETH→XLM branch and `createEscrow` with
  the testnet ABI in its testnet branch.
- [`src/core/event-orchestrator.ts`](src/core/event-orchestrator.ts) selects
  the monitored factory ABI using the configured default mode. Its mainnet
  listeners handle `SrcEscrowCreated` and `DstEscrowCreated`; testnet listeners
  handle `EscrowCreated` and `EscrowFunded`. Request mode and the monitor's
  configured mode must be checked together when validating an integration.
- [`src/routes/admin.ts`](src/routes/admin.ts) also selects by configured default
  mode. It calls resolver-authorization methods which are present only in the
  testnet factory ABI; mainnet admin authorization is **not verified** by the
  mainnet interface fragments.
- `HTLC_BRIDGE_ABI` is a separate legacy `createOrder` interface.
  `shouldUseHTLCContract` returns `false`; it does not select a third
  escrow-factory ABI for ETH→XLM orders.

## Release evidence

A testnet success cannot establish mainnet compatibility: method selectors,
tuple layouts, return values, and event signatures differ. Mock responses and
offline encoding tests establish local behavior only. The optional fork suite
requires `MAINNET_RPC_URL`, `ETHEREUM_RPC_URL`, or `INFURA_API_KEY` to enable its
fork blocks; a green run with skipped blocks is not mainnet execution evidence.

For a factory-related release, record which mode and interface were exercised,
which tests actually ran versus skipped, and whether deployment, event decoding,
and settlement were checked against that mode's deployed factory. No test was
executed as part of this documentation change. Keep addresses in network config
and RPC credentials in their existing configuration channels.
