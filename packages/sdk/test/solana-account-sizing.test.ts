/**
 * Solana account sizing, rent, and initialisation robustness tests.
 *
 * This is the drift gate `account-sizing.ts` and `idl/registry.ts` both cite.
 * It covers the full set of pre-/post-initialisation invariants:
 *
 *  1. Size derivation — the drift gate. Each account's size is recomputed
 *     *independently* from the byte-offset table the deserialiser actually
 *     reads, and compared to the exported constant. Adding, removing, or
 *     reordering a field breaks this test instead of silently producing a
 *     constant that is wrong everywhere at once.
 *  2. Rent — computed from the cluster, never hardcoded, with the reference
 *     mainnet formula pinned so the documented figures cannot rot.
 *  3. Payer solvency — required vs. available, with the shortfall in the
 *     message.
 *  4. Account state before init — absent / pre-funded / initialised / foreign
 *     owner, each with a dedicated error.
 *  5. Verification after init — existence, owner, exact length, rent exemption.
 *  6. Simulation — logs surfaced, never swallowed.
 *  7. Error taxonomy — every code has its own class, so a caller can branch on
 *     which invariant failed instead of matching a message string.
 *
 * No live validator is required: every RPC interaction goes through an
 * in-memory fake chain. What these tests *cannot* prove is that the derived
 * sizes match a deployed program — the Anchor program is not in this
 * repository (see docs/SOLANA_ACCOUNT_INIT_RENT_AUDIT.md §0). When it lands,
 * `assertAccountSize` is the hook that closes that gap.
 */

import { describe, it, expect, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

import {
  ANCHOR_ACCOUNT_NAMES,
  ANCHOR_DISCRIMINATOR_SIZE,
  ANCHOR_LAYOUT_TABLE_SOURCE,
  MAINNET_RENT,
  SOLANA_ANCHOR_ACCOUNT_LAYOUTS,
  SOLANA_TYPE_SIZES,
  SYSTEM_ACCOUNT_OVERHEAD_BYTES,
  AccountAlreadyInitializedError,
  AccountInitVerificationError,
  AccountNotRentExemptError,
  InsufficientRentError,
  InvalidAccountSizeError,
  SimulationFailedError,
  SolanaAccountInitError,
  UnexpectedAccountBalanceError,
  UnexpectedAccountOwnerError,
  accountSizeFor,
  assertAccountSize,
  assertAccountIsUninitialised,
  assertPayerCanFund,
  classifyUninitialisedAccount,
  fieldsSizeFor,
  getRentExemptMinimum,
  optionSize,
  rentExemptMinimumFor,
  referenceRentExemptMinimum,
  simulateTransactionOrThrow,
  transactionFee,
  validateAccountLayouts,
  verifyInitialisedAccount,
} from "../src/solana/account-sizing.js";

import {
  FIELD_OFFSET,
  HTLC_ORDER_ACCOUNT_SIZE,
  HTLC_ORDER_DISCRIMINATOR,
  IDL_VERSION,
} from "../src/solana/idl/htlc.js";

import {
  ORDER_REGISTRY_ACCOUNT_SIZE,
  ORDER_REGISTRY_DISCRIMINATOR,
  ORDER_REGISTRY_SEED,
  REGISTRY_FIELD_OFFSET,
  readOrderCount,
} from "../src/solana/idl/registry.js";

// ── Constants ────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const OTHER_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const ORDER_PDA = new PublicKey("ComputeBudget111111111111111111111111111111");
const PAYER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf8Ny8suSzwAh");

/**
 * The byte map of `HtlcOrder` after the 8-byte discriminator, declared here
 * independently of `SOLANA_ANCHOR_ACCOUNT_LAYOUTS`.
 *
 * This is the whole point of the drift gate: it is a *second, independent*
 * statement of the layout, keyed by the same names as `FIELD_OFFSET` — the
 * table the deserialiser actually reads from. If the production layout table
 * and the byte map disagree, exactly one of these two assertions fires.
 *
 * `preimage` is `Option<[u8; 32]>`: 1 discriminant byte + 32 payload. borsh
 * reserves the widest variant in `space`, so `None` still occupies 33 bytes.
 */
const HTLC_ORDER_FIELD_BYTES: Record<string, number> = {
  version: SOLANA_TYPE_SIZES.u8,
  sender: SOLANA_TYPE_SIZES.pubkey,
  beneficiary: SOLANA_TYPE_SIZES.pubkey,
  refundAddress: SOLANA_TYPE_SIZES.pubkey,
  mint: SOLANA_TYPE_SIZES.pubkey,
  amount: SOLANA_TYPE_SIZES.u64,
  safetyDeposit: SOLANA_TYPE_SIZES.u64,
  hashlock: SOLANA_TYPE_SIZES.bytes32,
  timelock: SOLANA_TYPE_SIZES.u64,
  status: SOLANA_TYPE_SIZES.u8,
  preimage: optionSize(SOLANA_TYPE_SIZES.bytes32),
};

const HTLC_ORDER_FIELD_ORDER = [
  "version",
  "sender",
  "beneficiary",
  "refundAddress",
  "mint",
  "amount",
  "safetyDeposit",
  "hashlock",
  "timelock",
  "status",
  "preimage",
];

// ── Fake chain ───────────────────────────────────────────────────────────────

/** An account as `getAccountInfo` would return it. */
interface FakeAccount {
  data: Buffer;
  /** Note: the RPC returns lamports as a `number`; the SDK converts to bigint. */
  lamports: number;
  owner: PublicKey;
}

/**
 * Minimal in-memory cluster: accounts, balances, and a rent table.
 *
 * `rentTable` defaults to the real mainnet-beta formula so a mocked rent is a
 * *plausible* rent rather than an arbitrary number. Pass a different table to
 * prove the code reads rent from the cluster rather than assuming a figure.
 */
function fakeChain(options: {
  accounts?: Record<string, FakeAccount>;
  balances?: Record<string, bigint>;
  rentTable?: (size: number) => number;
} = {}) {
  const accounts = new Map(Object.entries(options.accounts ?? {}));
  const balances = new Map(Object.entries(options.balances ?? {}));
  const rentTable = options.rentTable ?? ((size: number) => Number(referenceRentExemptMinimum(size)));

  const connection = {
    getMinimumBalanceForRentExemption: vi.fn(async (size: number) => rentTable(size)),
    getBalance: vi.fn(async (pk: PublicKey) => balances.get(pk.toBase58()) ?? 0n),
    getAccountInfo: vi.fn(async (pk: PublicKey) => {
      const found = accounts.get(pk.toBase58());
      if (!found) return null;
      return {
        data: found.data,
        lamports: found.lamports,
        owner: found.owner,
        executable: false,
        rentEpoch: 361,
      };
    }),
  };

  return { connection: connection as unknown as Connection, accounts, balances, rentTable };
}

/** A correctly-sized, program-owned, rent-exempt `HtlcOrder` account. */
function initialisedHtlcAccount(extraLamports = 0n): FakeAccount {
  return {
    data: Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE, 0),
    lamports: Number(referenceRentExemptMinimum(HTLC_ORDER_ACCOUNT_SIZE) + extraLamports),
    owner: PROGRAM_ID,
  };
}

/** A correctly-sized `OrderRegistry` account with a counter value. */
function initialisedRegistryAccount(orderCount: bigint): FakeAccount {
  const data = Buffer.alloc(ORDER_REGISTRY_ACCOUNT_SIZE, 0);
  ORDER_REGISTRY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(orderCount, ANCHOR_DISCRIMINATOR_SIZE + REGISTRY_FIELD_OFFSET.orderCount);
  return {
    data,
    lamports: Number(referenceRentExemptMinimum(ORDER_REGISTRY_ACCOUNT_SIZE)),
    owner: PROGRAM_ID,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Size drift gate
// ═══════════════════════════════════════════════════════════════════════════

describe("size derivation — drift gate", () => {
  it("HtlcOrder size recomputed from FIELD_OFFSET equals the exported constant", () => {
    // Walk the byte map the deserialiser reads. FIELD_OFFSET is relative to the
    // start of the field data (i.e. after the discriminator), so the cursor
    // starts at 0 and the discriminator is added back at the end.
    let cursor = 0;
    for (const name of HTLC_ORDER_FIELD_ORDER) {
      const declaredOffset = FIELD_OFFSET[name as keyof typeof FIELD_OFFSET];
      expect(
        declaredOffset,
        `FIELD_OFFSET.${name} does not match where the byte map reaches`
      ).toBe(cursor);
      cursor += HTLC_ORDER_FIELD_BYTES[name];
    }

    expect(cursor).toBe(fieldsSizeFor(SOLANA_ANCHOR_ACCOUNT_LAYOUTS.htlcOrder));
    expect(ANCHOR_DISCRIMINATOR_SIZE + cursor).toBe(HTLC_ORDER_ACCOUNT_SIZE);
    expect(HTLC_ORDER_ACCOUNT_SIZE).toBe(227); // 8 discriminator + 219 fields
  });

  it("the production layout table declares the same fields, in the same order", () => {
    const layout = SOLANA_ANCHOR_ACCOUNT_LAYOUTS.htlcOrder;
    expect(layout.fields.map((f) => f.name)).toEqual(HTLC_ORDER_FIELD_ORDER);
    // ...and the same widths, so the two cannot disagree on a size either.
    for (const field of layout.fields) {
      expect(
        field.size,
        `${field.name}: layout table and byte map disagree on width`
      ).toBe(HTLC_ORDER_FIELD_BYTES[field.name]);
    }
  });

  it("OrderRegistry size is the discriminator plus one u64", () => {
    expect(ORDER_REGISTRY_ACCOUNT_SIZE).toBe(16);
    expect(ANCHOR_DISCRIMINATOR_SIZE + SOLANA_TYPE_SIZES.u64).toBe(ORDER_REGISTRY_ACCOUNT_SIZE);
    expect(REGISTRY_FIELD_OFFSET.orderCount).toBe(0);
  });

  it("every exported size equals 8 + the sum of its declared fields", () => {
    for (const [name, layout] of Object.entries(SOLANA_ANCHOR_ACCOUNT_LAYOUTS)) {
      expect(
        accountSizeFor(name as "htlcOrder"),
        `${name}: accountSizeFor must be the discriminator plus the field sum`
      ).toBe(ANCHOR_DISCRIMINATOR_SIZE + fieldsSizeFor(layout));
    }
  });

  it("the layout table is self-consistent at import time", () => {
    // The module throws on import if this is non-empty, so reaching this line
    // already proves it. Asserted explicitly so the intent is legible.
    expect(validateAccountLayouts()).toEqual([]);
  });

  it("names the file to edit when a layout is broken", () => {
    expect(ANCHOR_LAYOUT_TABLE_SOURCE).toContain("account-sizing.ts");
  });

  it("rejects an unknown layout name rather than returning NaN", () => {
    expect(() => accountSizeFor("nope" as never)).toThrow(/unknown account layout/i);
  });

  it("Option<T> reserves the widest variant, so None still occupies space", () => {
    // 1 discriminant + 32 payload. If this ever became 1, the account would be
    // undersized the moment a preimage is revealed.
    expect(optionSize(SOLANA_TYPE_SIZES.bytes32)).toBe(33);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Successful initialisation
// ═══════════════════════════════════════════════════════════════════════════

describe("successful initialisation", () => {
  it("verifies a correctly-created HtlcOrder: size, owner, and rent exemption", async () => {
    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: initialisedHtlcAccount() },
    });

    const verified = await verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
      expectedOwner: PROGRAM_ID,
    });

    expect(verified.address).toBe(ORDER_PDA.toBase58());
    expect(verified.owner).toBe(PROGRAM_ID.toBase58());
    expect(verified.dataLength).toBe(HTLC_ORDER_ACCOUNT_SIZE);
    expect(verified.lamports).toBe(referenceRentExemptMinimum(HTLC_ORDER_ACCOUNT_SIZE));
    // Rent came from the cluster, and the query used the real account size.
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(227);
  });

  it("verifies a correctly-created OrderRegistry: size, owner, and rent exemption", async () => {
    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: initialisedRegistryAccount(7n) },
    });

    const verified = await verifyInitialisedAccount(connection, ORDER_PDA, "orderRegistry", {
      expectedOwner: PROGRAM_ID,
    });

    expect(verified.dataLength).toBe(ORDER_REGISTRY_ACCOUNT_SIZE);
    expect(verified.owner).toBe(PROGRAM_ID.toBase58());
    expect(verified.lamports).toBeGreaterThanOrEqual(verified.rentExemptMinimum);
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(16);
  });

  it("reads the registry counter from a valid account", () => {
    expect(readOrderCount(initialisedRegistryAccount(42n).data)).toBe(42n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Misconfigured / undersized account
// ═══════════════════════════════════════════════════════════════════════════

describe("misconfigured account size", () => {
  it("rejects an undersized account with InvalidAccountSize and states both sizes", () => {
    // The on-chain `space = ...` was 200 instead of 227.
    expect(() =>
      assertAccountSize("htlcOrder", 200, { account: "order ABC" })
    ).toThrow(InvalidAccountSizeError);

    try {
      assertAccountSize("htlcOrder", 200, { account: "order ABC" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as InvalidAccountSizeError;
      expect(err.code).toBe("InvalidAccountSize");
      expect(err.message).toContain("expected exactly 227 bytes");
      expect(err.message).toContain("found 200 bytes");
      expect(err.message).toContain("27 bytes short");
      expect(err.message).toContain("smaller space");
      // The diagnostic must name the account so an operator knows which one.
      expect(err.message).toContain("order ABC");
      expect(err.context).toMatchObject({ expected: 227, actual: 200, mode: "exact" });
    }
  });

  it("rejects an oversized account and blames the SDK for being behind", () => {
    try {
      assertAccountSize("htlcOrder", 300, { account: "order XYZ" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as InvalidAccountSizeError;
      expect(err.message).toContain("73 bytes over");
      expect(err.message).toContain("upgrade @wafflefinance/sdk");
    }
  });

  it("fails post-init verification on an undersized account, naming the on-chain bug", async () => {
    const truncated = initialisedHtlcAccount();
    truncated.data = truncated.data.subarray(0, 200);

    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: truncated },
    });

    await expect(
      verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
      })
    ).rejects.toThrow(InvalidAccountSizeError);
  });

  it("'at-least' mode tolerates a grown account but not a short one", () => {
    // Reads must tolerate a future program version that adds fields…
    expect(assertAccountSize("htlcOrder", 300, { mode: "at-least" })).toBe(227);
    // …but must never accept an account too short to hold the fields.
    expect(() => assertAccountSize("htlcOrder", 200, { mode: "at-least" })).toThrow(
      InvalidAccountSizeError
    );
  });

  it("returns the expected size when the account is correct", () => {
    expect(assertAccountSize("htlcOrder", HTLC_ORDER_ACCOUNT_SIZE)).toBe(227);
    expect(assertAccountSize("orderRegistry", ORDER_REGISTRY_ACCOUNT_SIZE)).toBe(16);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Underfunding
// ═══════════════════════════════════════════════════════════════════════════

describe("underfunded payer or account", () => {
  const funding = {
    payer: PAYER,
    account: "order ABC",
    rentLamports: referenceRentExemptMinimum(HTLC_ORDER_ACCOUNT_SIZE),
    amountLamports: 1_000_000n,
    safetyDepositLamports: 100_000n,
    signatureCount: 1,
  };

  it("reports the required amount, the available amount, and the shortfall", () => {
    const required =
      funding.rentLamports + funding.amountLamports + funding.safetyDepositLamports +
      transactionFee(1);
    const available = required - 1n;

    expect(() => assertPayerCanFund({ ...funding, balanceLamports: available })).toThrow(
      InsufficientRentError
    );

    try {
      assertPayerCanFund({ ...funding, balanceLamports: available });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as InsufficientRentError;
      expect(err.code).toBe("InsufficientRent");
      expect(err.message).toContain(`needs ${required} lamports`);
      expect(err.message).toContain(`but holds ${available}`);
      expect(err.message).toContain("Short by 1 lamports");
      expect(err.message).toContain("order ABC");
      expect(err.message).toContain(PAYER.toBase58());
      expect(err.context).toMatchObject({
        required: required.toString(),
        available: available.toString(),
        shortfall: "1",
      });
    }
  });

  it("passes when the balance exactly covers the requirement", () => {
    const required =
      funding.rentLamports + funding.amountLamports + funding.safetyDepositLamports +
      transactionFee(1);
    const result = assertPayerCanFund({ ...funding, balanceLamports: required });
    expect(result).toEqual({ required, available: required, shortfall: 0n });
  });

  it("charges the fee for every signature, not just one", () => {
    expect(transactionFee(1)).toBe(10_000n);
    expect(transactionFee(3)).toBe(20_000n);
  });

  it("reads rent from the cluster, so a rent-table change is handled", async () => {
    // A cluster that charges 10x mainnet rent must be believed, not overridden.
    const { connection } = fakeChain({
      rentTable: (size) => Number(referenceRentExemptMinimum(size)) * 10,
    });

    const rent = await getRentExemptMinimum(connection, HTLC_ORDER_ACCOUNT_SIZE);
    expect(rent).toBe(referenceRentExemptMinimum(HTLC_ORDER_ACCOUNT_SIZE) * 10n);
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(227);
  });

  it("rejects a nonsensical size rather than querying rent for it", async () => {
    const { connection } = fakeChain();
    await expect(getRentExemptMinimum(connection, -1)).rejects.toThrow(RangeError);
    await expect(getRentExemptMinimum(connection, 1.5)).rejects.toThrow(RangeError);
    expect(connection.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
  });

  it("rejects an account that is not rent-exempt after creation", async () => {
    // Confirmed, but one lamport under the minimum: the runtime will purge it.
    const short = initialisedHtlcAccount();
    short.lamports -= 1;

    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: short },
    });

    try {
      await verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as AccountNotRentExemptError;
      expect(err.code).toBe("AccountNotRentExempt");
      expect(err.message).toContain("will be purged by the runtime");
      expect(err.context).toMatchObject({ expectedSize: 227 });
    }
  });

  it("counts escrow funds on top of rent when checking the account balance", async () => {
    const funded = initialisedHtlcAccount(1_000_000n);
    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: funded },
    });

    // Exactly rent + escrow passes…
    await expect(
      verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
        expectedExtraLamports: 1_000_000n,
      })
    ).resolves.toMatchObject({ dataLength: 227 });

    // …one lamport more than escrow is held fails.
    await expect(
      verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
        expectedExtraLamports: 1_000_001n,
      })
    ).rejects.toThrow(AccountNotRentExemptError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Unexpected balance states, including re-initialisation
// ═══════════════════════════════════════════════════════════════════════════

describe("unexpected account state before initialisation", () => {
  const opts = { account: "order ABC", programId: PROGRAM_ID.toBase58() };

  it("classifies an absent account and lets it through", () => {
    const state = classifyUninitialisedAccount(null, PROGRAM_ID);
    expect(state).toEqual({ kind: "absent" });
    expect(() => assertAccountIsUninitialised(state, opts)).not.toThrow();
  });

  it("detects a pre-funded PDA and refuses it with a drain-and-retry message", () => {
    // The subtle case: a PDA holding lamports but no data. `getAccountInfo`
    // returns non-null here, but `create_account` would still revert with
    // "already in use".
    const prefunded = {
      data: Buffer.alloc(0),
      lamports: 5_000_000,
      owner: new PublicKey("11111111111111111111111111111111"),
      executable: false,
      rentEpoch: 361,
    };
    const state = classifyUninitialisedAccount(prefunded, PROGRAM_ID);
    expect(state.kind).toBe("prefunded");

    try {
      assertAccountIsUninitialised(state, opts);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as UnexpectedAccountBalanceError;
      expect(err.code).toBe("UnexpectedAccountBalance");
      expect(err.message).toContain("already holds 5000000 lamports");
      expect(err.message).toContain("already in use");
      expect(err.message).toContain("Reclaim the lamports");
      expect(err.context).toMatchObject({ lamports: "5000000" });
    }
  });

  it("rejects a re-initialisation attempt outright (test #5)", () => {
    const state = classifyUninitialisedAccount(
      {
        data: Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE),
        lamports: 2_470_800,
        owner: PROGRAM_ID,
        executable: false,
        rentEpoch: 361,
      },
      PROGRAM_ID
    );
    expect(state.kind).toBe("initialised");

    try {
      assertAccountIsUninitialised(state, opts);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as AccountAlreadyInitializedError;
      expect(err.code).toBe("AccountAlreadyInitialized");
      expect(err.message).toContain("already exists and is initialised");
      expect(err.message).toContain("Refusing to re-initialise");
      expect(err.context).toMatchObject({ dataLength: 227, lamports: "2470800" });
    }
  });

  it("rejects an account owned by a different program", () => {
    const state = classifyUninitialisedAccount(
      {
        data: Buffer.alloc(HTLC_ORDER_ACCOUNT_SIZE),
        lamports: 2_470_800,
        owner: OTHER_PROGRAM_ID,
        executable: false,
        rentEpoch: 361,
      },
      PROGRAM_ID
    );
    expect(state.kind).toBe("foreign");

    try {
      assertAccountIsUninitialised(state, opts);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as UnexpectedAccountOwnerError;
      expect(err.code).toBe("UnexpectedAccountOwner");
      expect(err.message).toContain(OTHER_PROGRAM_ID.toBase58());
      expect(err.message).toContain("not the expected program");
      expect(err.message).toContain("Check the program id and the PDA seeds");
    }
  });

  it("fails post-init verification when the account was never created", async () => {
    const { connection } = fakeChain(); // nothing on chain
    await expect(
      verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
      })
    ).rejects.toThrow(AccountInitVerificationError);
  });

  it("fails post-init verification on a wrong owner", async () => {
    const foreign = initialisedHtlcAccount();
    foreign.owner = OTHER_PROGRAM_ID;

    const { connection } = fakeChain({
      accounts: { [ORDER_PDA.toBase58()]: foreign },
    });

    try {
      await verifyInitialisedAccount(connection, ORDER_PDA, "htlcOrder", {
        expectedOwner: PROGRAM_ID,
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as UnexpectedAccountOwnerError;
      expect(err.code).toBe("UnexpectedAccountOwner");
      expect(err.message).toContain("SOLANA_HTLC_PROGRAM");
    }
  });

  it("rejects a truncated registry buffer instead of reading past the end", () => {
    // The old code did `readBigUInt64LE(8)` unconditionally, yielding 0n for a
    // short buffer — which would re-use order PDA #0 forever.
    expect(() => readOrderCount(Buffer.alloc(8))).toThrow(RangeError);
    expect(() => readOrderCount(Buffer.alloc(ORDER_REGISTRY_ACCOUNT_SIZE - 1))).toThrow(
      /too small/
    );
  });

  it("rejects a registry buffer with the wrong discriminator", () => {
    const wrong = initialisedRegistryAccount(1n).data;
    wrong[0] ^= 0xff;
    expect(() => readOrderCount(wrong)).toThrow(/Invalid OrderRegistry discriminator/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Simulation
// ═══════════════════════════════════════════════════════════════════════════

describe("simulation", () => {
  it("surfaces program logs when the program rejects the transaction", async () => {
    const connection = {
      simulateTransaction: vi.fn(async () => ({
        err: { InstructionError: [0, { Custom: 6000 }] },
        logs: [
          "Program 9WzD invoke [1]",
          "Program log: Instruction: CreateOrder",
          "Program 9WzD failed: custom program error: 0x1770",
        ],
      })),
    };

    try {
      await simulateTransactionOrThrow(connection, {} as never, { account: "order ABC" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as SimulationFailedError;
      // The documented code is actually thrown, rather than being a dead variant.
      expect(err.code).toBe("SimulationFailed");
      expect(err).toBeInstanceOf(SimulationFailedError);
      expect(err.message).toContain('{"Custom":6000}');
      expect(err.simulationLogs).toHaveLength(3);
      expect(err.message).toContain("custom program error: 0x1770");
      // 6000 == 0x1770
      expect(6000).toBe(0x1770);
    }
  });

  it("unwraps the versioned { context, value } response shape", async () => {
    const connection = {
      simulateTransaction: vi.fn(async () => ({
        context: { slot: 1 },
        value: { err: null, logs: ["Program log: ok"] },
      })),
    };
    await expect(
      simulateTransactionOrThrow(connection, {} as never, { account: "order ABC" })
    ).resolves.toEqual(["Program log: ok"]);
  });

  it("reports a simulation RPC failure instead of assuming success", async () => {
    const connection = {
      simulateTransaction: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    };
    await expect(
      simulateTransactionOrThrow(connection, {} as never, { account: "order ABC" })
    ).rejects.toThrow(/socket hang up/);
  });

  it("says so when the program returned no logs", async () => {
    const connection = {
      simulateTransaction: vi.fn(async () => ({ err: "BlockhashNotFound", logs: null })),
    };
    await expect(
      simulateTransactionOrThrow(connection, {} as never, { account: "order ABC" })
    ).rejects.toThrow(/Program logs: \(none returned\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Error taxonomy and the rent oracle
// ═══════════════════════════════════════════════════════════════════════════

describe("error taxonomy", () => {
  it("every error class extends the catch-all base and carries its own code", () => {
    const cases: Array<[SolanaAccountInitError, string]> = [
      [new InvalidAccountSizeError("x"), "InvalidAccountSize"],
      [new InsufficientRentError("x"), "InsufficientRent"],
      [new AccountAlreadyInitializedError("x"), "AccountAlreadyInitialized"],
      [new UnexpectedAccountBalanceError("x"), "UnexpectedAccountBalance"],
      [new UnexpectedAccountOwnerError("x"), "UnexpectedAccountOwner"],
      [new AccountNotRentExemptError("x"), "AccountNotRentExempt"],
      [new AccountInitVerificationError("x"), "AccountInitVerificationFailed"],
      [new SimulationFailedError("x"), "SimulationFailed"],
    ];

    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(SolanaAccountInitError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
    }
  });

  it("the codes are distinct — no variant shadows another", () => {
    const codes = new Set(
      [
        new InvalidAccountSizeError("x"),
        new InsufficientRentError("x"),
        new AccountAlreadyInitializedError("x"),
        new UnexpectedAccountBalanceError("x"),
        new UnexpectedAccountOwnerError("x"),
        new AccountNotRentExemptError("x"),
        new AccountInitVerificationError("x"),
        new SimulationFailedError("x"),
      ].map((e) => e.code)
    );
    expect(codes.size).toBe(8);
  });
});

describe("reference rent oracle", () => {
  it("matches the runtime's own formula: (size + 128) * 3480 * 2", () => {
    const runtimeFormula = (size: number) =>
      BigInt(size + SYSTEM_ACCOUNT_OVERHEAD_BYTES) *
      MAINNET_RENT.lamportsPerByteYear *
      BigInt(MAINNET_RENT.exemptionThresholdYears);

    for (const size of [0, 1, 16, 165, 200, 227, 1000]) {
      expect(referenceRentExemptMinimum(size)).toBe(runtimeFormula(size));
    }
  });

  it("pins the documented figures so the doc comment cannot rot", () => {
    expect(referenceRentExemptMinimum(0)).toBe(890_880n);
    expect(referenceRentExemptMinimum(ORDER_REGISTRY_ACCOUNT_SIZE)).toBe(1_002_240n);
    expect(referenceRentExemptMinimum(HTLC_ORDER_ACCOUNT_SIZE)).toBe(2_470_800n);
  });

  it("rejects a nonsensical size", () => {
    expect(() => referenceRentExemptMinimum(-1)).toThrow(RangeError);
  });

  it("derives registry rent from the layout, not from a literal", async () => {
    const { connection } = fakeChain();
    const rent = await rentExemptMinimumFor(connection, "orderRegistry");
    expect(rent).toBe(referenceRentExemptMinimum(ORDER_REGISTRY_ACCOUNT_SIZE));
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(16);
  });
});

describe("IDL constants used by the layout", () => {
  it("the registry seed is the documented [b\"state\"]", () => {
    expect(ORDER_REGISTRY_SEED.toString("ascii")).toBe("state");
    expect(SOLANA_ANCHOR_ACCOUNT_LAYOUTS.orderRegistry.seedLabel).toBe("state");
    expect(ANCHOR_ACCOUNT_NAMES.orderRegistry).toBe("State");
  });

  it("the order seed is the documented [b\"order\"]", () => {
    expect(SOLANA_ANCHOR_ACCOUNT_LAYOUTS.htlcOrder.seedLabel).toBe("order");
    expect(ANCHOR_ACCOUNT_NAMES.htlcOrder).toBe("HtlcOrder");
    // The version byte is the first field, at offset 0 after the discriminator.
    expect(FIELD_OFFSET.version).toBe(0);
    expect(HTLC_ORDER_DISCRIMINATOR).toHaveLength(ANCHOR_DISCRIMINATOR_SIZE);
    expect(IDL_VERSION).toBe(0);
  });
});
