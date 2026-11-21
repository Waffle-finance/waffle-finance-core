export const HTLC_ESCROW_ABI = [
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [
      { name: "beneficiary", type: "address" },
      { name: "refundAddress", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "safetyDeposit", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelockSeconds", type: "uint64" }
    ],
    outputs: [{ name: "orderId", type: "uint256" }]
  },
  {
    type: "function",
    name: "claimOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "preimage", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "refundOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "refundAddress", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "safetyDeposit", type: "uint256" },
          { name: "hashlock", type: "bytes32" },
          { name: "timelock", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "finalisedAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "preimageKeccak", type: "bytes32" }
        ]
      }
    ]
  },
  {
    type: "event",
    name: "OrderCreated",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "safetyDeposit", type: "uint256", indexed: false },
      { name: "hashlock", type: "bytes32", indexed: false },
      { name: "timelock", type: "uint64", indexed: false }
    ]
  },
  {
    type: "event",
    name: "OrderClaimed",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "claimer", type: "address", indexed: true },
      { name: "preimage", type: "bytes32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "safetyDeposit", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "OrderRefunded",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "safetyDeposit", type: "uint256", indexed: false }
    ]
  },
  // Custom errors — included so viem can decode targeted createOrder revert
  // reasons (e.g. surface an "approve the escrow first" hint to the user).
  { type: "error", name: "InvalidValue", inputs: [] },
  { type: "error", name: "InvalidToken", inputs: [] },
  {
    type: "error",
    name: "InsufficientAllowance",
    inputs: [
      { name: "allowance", type: "uint256" },
      { name: "required", type: "uint256" }
    ]
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      { name: "balance", type: "uint256" },
      { name: "required", type: "uint256" }
    ]
  }
] as const;

/**
 * Canonical event topics for the deployed HTLCEscrow contract.
 *
 * These are the keccak256 hashes of the canonical event signatures
 * (`Name(type1,type2,...)` with indexed markers omitted). They are checked in
 * so that any change to an event name, parameter type, or ordering in
 * `HTLC_ESCROW_ABI` fails the focused compatibility test in
 * `abi.compatibility.test.ts` rather than silently breaking event ingestion in
 * the coordinator and relayer listeners.
 *
 * Compatibility update procedure:
 *   1. Change the event in `HTLCEscrow.sol` and its interface.
 *   2. Deploy to a local node and capture the emitted log topics.
 *   3. Update the entries below (and the encoded-log fixtures) in the same PR.
 *   4. Bump the SDK minor version and note the breaking event change.
 */
export const HTLC_ESCROW_EVENT_TOPICS = {
  OrderCreated:
    "0x" as `0x${string}`,
  OrderClaimed:
    "0x" as `0x${string}`,
  OrderRefunded:
    "0x" as `0x${string}`
} as const;

/**
 * Canonical indexed-field layout for each escrow event. The tuple lists the
 * indexed parameter names in declaration order; consumers rely on this layout
 * when filtering logs and decoding topics.
 */
export const HTLC_ESCROW_EVENT_INDEXED_FIELDS = {
  OrderCreated: ["orderId", "sender", "beneficiary"],
  OrderClaimed: ["orderId", "claimer"],
  OrderRefunded: ["orderId", "caller"]
} as const;
