/**
 * SYNTHETIC identities for the cross-chain fixtures (#732).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE — READ THIS BEFORE TRUSTING A VALUE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **None of the values in this file were captured from mainnet or testnet.**
 * No transaction was recorded, no RPC response was recorded, no account was
 * read. Every one of them is *synthesised deterministically* from a fixed
 * seed string, so the fixtures are byte-for-byte reproducible and reviewable
 * in a diff.
 *
 * What that means in practice, per kind of value:
 *
 * • **Addresses are structurally valid but belong to nobody.** Each is
 *   `keccak256(label)[-20:]` (Ethereum, then EIP-55 checksummed),
 *   `sha256(label)` StrKey-encoded (Stellar, so the CRC-16 and version byte
 *   are real), or `sha256(label)` base-58 (Solana). Each library's own
 *   validator accepts them — which is the property the fixtures need — but
 *   there is no private key behind any of them, so no fixture funds can be
 *   moved and no fixture address should ever be treated as a counterparty.
 *
 * • **Hashlocks and preimages satisfy a real cryptographic relation.**
 *   `hashlock === sha256(preimage)` for every pair, and that is checked in
 *   `test/fixtures-sync.test.ts`. A fixture whose hashlock did not match its
 *   preimage would be decoration; this one is a usable test vector for
 *   anything that verifies a preimage against a hashlock.
 *
 * • **The Solana program id is not a deployed program.** There is no Solana
 *   deployment recorded anywhere in this repository (contrast
 *   `deployments.testnet.json`, which records real Ethereum and Stellar
 *   deployments), so the program id is synthetic and the PDAs below are the
 *   PDAs *that program id would produce*. The PDA derivation itself — seeds
 *   `[b"order", hashlock]`, `findProgramAddressSync` — is the real one from
 *   `src/solana/index.ts`, so a consumer that hard-codes one of these order
 *   ids is exercising the actual derivation.
 *
 * • **Transaction hashes are structurally valid, semantically empty.** An
 *   EVM `0x`+64-hex hash, a Stellar 64-hex hash, a base-58 64-byte Solana
 *   signature — each in the exact shape `guards/rpc-payload.ts` and
 *   `guards/branded.ts` require. None of them identifies a real transaction.
 *
 * The seed strings are all prefixed `wf-synth-` so a grep for `synth` finds
 * every value in the fixture suite, and a reviewer can confirm at a glance
 * that no real principal leaked in.
 */

/**
 * Seed prefix for every synthetic identity in this file.
 *
 * Kept as a named constant so the sync test can assert that no fixture
 * identity *lacks* it, and so a future contributor adding a fixture has an
 * obvious convention to follow.
 */
export const SYNTHETIC_SEED_PREFIX = 'wf-synth-';

// ── Ethereum (EIP-55 checksummed) ───────────────────────────────────────────

/** Source-side wallet on the Ethereum legs. */
export const ETH_SRC = '0x59fA36345b1009b632b8EdEe82f239c5E7b57F24';
/** Destination-side wallet on the Ethereum legs. */
export const ETH_DST = '0xf1A3A968E398D533df722aEcFF13dAf7cE18eE94';
/** The resolver that fills the destination leg on Ethereum. */
export const ETH_RESOLVER = '0xD7d263aEDF6eD3D15a0A75538D14696da0c5008c';
/**
 * The HTLCEscrow deployment the Ethereum fixtures are written against.
 *
 * SYNTHETIC. Note that `deployments.testnet.json` *does* record a real
 * Sepolia escrow at `0xb352339BEb146f2699d28D736700B953988bB178`. A fixture
 * pinned to a real deployment would be more realistic, but it would also be
 * a fixture that claims to describe observed behaviour of a live contract
 * while containing invented amounts, timelocks and events — which is the
 * misrepresentation this issue asked us to avoid. Substituting the real
 * address is a one-line change if the maintainer prefers it.
 */
export const ETH_ESCROW = '0x4eb39E8Eb7d13CD904Dc1D5e8eA536b44C1B6298';
/** USDC on Sepolia — a real, publicly-known address, used as the ERC-20 leg. */
export const ETH_USDC = '0x4C5051f375eE88D5b7681a18CF0F0E793c4B9479';

/** The zero address, which `HTLCEscrow` treats as "native ETH". */
export const NATIVE_ETH_TOKEN = '0x0000000000000000000000000000000000000000';

// ── Stellar (real StrKey encoding, real CRC-16) ─────────────────────────────

/** Source-side account on the Stellar legs. */
export const XLM_SRC = 'GAXGQHLSME262OPIC3PJBEKALWARZTD6W5B5TYMJFIK6E42WCS75PSOF';
/** Destination-side account on the Stellar legs. */
export const XLM_DST = 'GDW3KLPPHKYNZRE2BCSHBG7HNUVD4MPND63I6GQTOWRJZJWVQPZRQS6D';
/** A Stellar contract id (`C…`), used as the asset address for a token leg. */
export const XLM_SAC = 'GCKHU5DUJMI3IOVV2N3SQJ2OPBS7VIKFN5IPRI3XGKPMLEWJO2HOMG5M';
/** A Stellar resolver account. */
export const XLM_RESOLVER = 'GA22XYJD4RUHDHLFNCIIBFNU7TD5IEVFGMVANC376625V6MJMOESBX4E';

// ── Solana (base-58) ────────────────────────────────────────────────────────

/** Source-side wallet on the Solana legs. */
export const SOL_SRC = '5z6jNfCSiruthzMbtzhjuXJ2BAYdY6ayUMpzywcoow7S';
/** Destination-side wallet on the Solana legs. */
export const SOL_DST = '4vNbbQT7CRBrzKuaZfTsoJ5LUYQRegKVWv4YS83SgHgw';
/** Refund address on the Solana legs. */
export const SOL_REFUND = 'DZJfXJBVo4ntxMGj1yTKZ2m3zf1tji5q9HVF5Bur18Ke';
/** An SPL mint used for the USDC Solana leg. */
export const SOL_USDC = '7RTK3CFdGJvBSsf9PDi3xg83PpeY1upsRymHZeTWsiPp';
/** The native-SOL pseudo-mint. This one is a real, well-known constant. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * SYNTHETIC Anchor program id for the HTLC program.
 *
 * See the provenance note at the top of this file: no Solana deployment is
 * recorded in this repository, so this id is invented. The PDAs derived
 * from it below are *real* derivations from *this* id.
 */
export const SOL_HTLC_PROGRAM_ID = 'BMAXuAmNZBkCPfzgUw2XYB1vDbnAXx1sr7ewnyfCMtan';

// ── Preimage / hashlock pairs ───────────────────────────────────────────────

/**
 * A preimage and the hashlock derived from it.
 *
 * `hashlock` is the real `sha256(preimage)` — verifiable with any SHA-256
 * implementation, and checked by the test suite. The pair is what makes a
 * claim fixture meaningful: a preimage that does not open its hashlock
 * would not test anything.
 */
export interface PreimagePair {
  readonly label: string;
  /** 32 bytes, `0x` + 64 hex chars. */
  readonly preimage: `0x${string}`;
  /** `sha256(preimage)`, `0x` + 64 hex chars. */
  readonly hashlock: `0x${string}`;
}

/** Flow 1 — eth_to_xlm native, settles and claims. */
export const PAIR_ETH_TO_XLM: PreimagePair = {
  label: SYNTHETIC_SEED_PREFIX + 'preimage-eth-to-xlm',
  preimage: '0x5fd9d42a3002b009aac79184ba18d75c17bfc64e05f6b2a77bbf597b5d421926',
  hashlock: '0x9f6fa484bee128ba802a8c1a41f3139aec6b77275faf8739bfb2d4fd69c08dba',
};

/** Flow 2 — sol_to_eth native, times out and refunds. */
export const PAIR_SOL_TO_ETH: PreimagePair = {
  label: SYNTHETIC_SEED_PREFIX + 'preimage-sol-to-eth',
  preimage: '0x47f53a4125a33437d38d81fb78eaac599925cfd80618d06e7b8af285026df590',
  hashlock: '0xe45922fdddce17e2cdcbf0215aa18d486ddf6c5855d20aa45a2109057fd52759',
};

/** Flow 3 — eth_to_sol USDC, settles and claims. */
export const PAIR_ETH_TO_SOL_USDC: PreimagePair = {
  label: SYNTHETIC_SEED_PREFIX + 'preimage-eth-to-sol-usdc',
  preimage: '0x5ad7e885f7143f0675db41c093f47b5a1a28596092d5db507ad234b767eb59f3',
  hashlock: '0x0ee47657766afb734ee8f946ace2aa0e7c7359b85c82d5f78506d25c3dab3f0f',
};

/** Flow 4 — xlm_to_eth native, creation only (stays `announced`). */
export const PAIR_XLM_TO_ETH: PreimagePair = {
  label: SYNTHETIC_SEED_PREFIX + 'preimage-xlm-to-eth',
  preimage: '0xc9e7f9e9c5223ca287772c47fdc004b976444b9f9cd5f3920c88e9f4568a1049',
  hashlock: '0x8d5a2b083d1bb660ed1c84db81f8d54745d1459e45aae380069ce5dabcfdbf4a',
};

/** Every preimage pair, in flow order. */
export const ALL_PREIMAGE_PAIRS: readonly PreimagePair[] = [
  PAIR_ETH_TO_XLM,
  PAIR_SOL_TO_ETH,
  PAIR_ETH_TO_SOL_USDC,
  PAIR_XLM_TO_ETH,
];

// ── Transaction identifiers ─────────────────────────────────────────────────

/** EVM tx hash, `0x` + 64 hex chars. */
export const ETH_TX_CREATE = '0x6bc602b31b403285eaafd18a723935b110ed1acc806483dae2f506841c6b02c9';
/** EVM tx hash for the claim leg. */
export const ETH_TX_CLAIM = '0x8f63f72fe9d64c9459e0471c2fde885d3e9cebc9577ed80042603993172c8862';
/** EVM tx hash for the refund leg. */
export const ETH_TX_REFUND = '0x1edf707b9426f0755343b1a6e553cbe5ba4762f22c59f3e9bdf9d631dcc169f8';
/** Stellar tx hash: 64 lowercase hex chars, no `0x`. */
export const XLM_TX_CREATE = 'f7583c2cca3ca542a4754677e98f1ce9c4e1fa93ebe534ed094110b0e58201d7';
/** Stellar tx hash for the claim leg. */
export const XLM_TX_CLAIM = '77da006b864569b786f183aed5e36a8a303331e65f4420100f695f211c3f9607';
/** Solana signature: base-58 encoding of a real 64-byte value. */
export const SOL_TX_CREATE =
  '4fQhP4LQDY7iXAETTZ9LghgnBGA1vbv9koBPV1PjLJ7NWrSBFFXmgtAfNp54UBY9fjSzuaqj9EZZUPaTXy5BfHaq';
/** Solana signature for the claim leg. */
export const SOL_TX_CLAIM =
  '4UX738781quhHf5po8Ka5uBCgfZoVhXNnGaSvniLo8v3jTDUdDaAhqJsmGTqRESwv6JwQV1YcYdL7bPi19n7MZqM';
/** Solana signature for the refund leg. */
export const SOL_TX_REFUND =
  '5v6zBRs19rRTmKPyBucKGHVbjcF1c3m4nMAe5LUiAxHamSSUvghHUjHUHYS8h81fxXTDXHpjAV3AgM97pGirQsCF';

// ── Solana order PDAs ───────────────────────────────────────────────────────

/**
 * Order PDA for flow 2, derived from `PAIR_SOL_TO_ETH.hashlock` under
 * `SOL_HTLC_PROGRAM_ID` with seeds `[b"order", hashlock]`.
 *
 * SYNTHETIC program id, real derivation. The sync test recomputes it with
 * `PublicKey.findProgramAddressSync` so a change to the seed constant in
 * `src/solana/idl/htlc.ts` breaks the fixture rather than quietly making it
 * wrong.
 */
export const SOL_ORDER_PDA_FLOW_2 = '85aHC8Z8GseBcReT4tvVrKJzJyfQXwRAsKS1QQh8NsZG';

/**
 * Order PDA for flow 3, derived from `PAIR_ETH_TO_SOL_USDC.hashlock`.
 */
export const SOL_ORDER_PDA_FLOW_3 = '7ik4FTzDbvPS5YnyCmnmjDvuN2BShjKGDto8KG8k32Uu';

/** Sentinel for a Soroban contract-id-shaped order id in the coordinator wire. */
export const SOROBAN_CONTRACT_ORDER_ID = 'CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK';
