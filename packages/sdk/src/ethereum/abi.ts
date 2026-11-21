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
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: []
  },
  {
    type: "function",
    name: "pendingWithdrawals",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
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
  {
    type: "event",
    name: "PayoutDeferred",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false }
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
