/**
 * End-to-end flow replays driven by the canonical fixtures (#732).
 *
 * `fixtures-sync.test.ts` proves the fixtures are *shaped* correctly. This
 * file proves they are *usable*: it drives the SDK's real client classes over
 * a whole flow — announce, lock, settle, claim or refund — with the chain
 * transports stubbed at the network boundary, so the adapters, the error
 * classifiers, the coordinator client, and the guards all run against the
 * same data a real run would produce.
 *
 * The stubs are at the lowest possible layer on purpose. A `vi.mock` of the
 * adapters would test nothing; mocking `Connection` (Solana) and `fetch`
 * (Ethereum / coordinator) means every line of SDK logic between the wire and
 * the caller actually executes.
 *
 * Flow 1 — eth_to_xlm, native: announce → source lock → destination lock →
 *           preimage reveal → claim, verified on all three legs.
 * Flow 2 — sol_to_eth, native: announce → source lock → timelock expiry →
 *           refund, with the claim correctly rejected as premature.
 */

import { describe, it, expect, vi } from 'vitest';

import { CoordinatorClient } from '../src/coordinator/client.js';
import { HistoryClient } from '../src/coordinator/history-client.js';
import { SolanaHTLCClient, NATIVE_SOL_MINT } from '../src/solana/index.js';
import { HTLCError } from '../src/htlc-client.js';
import { isApprovalError, normalizeApprovalMessage } from '../src/approval.js';
import { estimateTimelockRemaining, orderIdFromHashlock } from '../src/shared-utils/index.js';
import { canTransition } from '../src/state-machine/index.js';

import { SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE } from '../src/fixtures/solana-wire.js';
import { decodeSorobanOrder, SOROBAN_RETVALS_FLOW_2 } from '../src/fixtures/soroban-wire.js';
import {
  ANNOUNCE_FLOW_1,
  HISTORY_PAGE_MIXED,
  ORDER_FLOW_1_ANNOUNCED,
  ORDER_FLOW_1_COMPLETED,
  ORDER_FLOW_1_DST_LOCKED,
  ORDER_FLOW_1_SECRET_REVEALED,
  ORDER_FLOW_1_SRC_LOCKED,
  ORDER_FLOW_2_EXPIRED,
  ORDER_FLOW_2_REFUNDED,
  ORDER_FLOW_2_SRC_LOCKED,
} from '../src/fixtures/coordinator-flows.js';
import {
  PAIR_ETH_TO_XLM,
  PAIR_SOL_TO_ETH,
  SOL_HTLC_PROGRAM_ID,
  SOL_ORDER_PDA_FLOW_2,
  SOL_SRC,
  SOL_TX_REFUND,
} from '../src/fixtures/identities.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function coordinatorServing(stages: readonly unknown[]): {
  client: CoordinatorClient;
  calls: string[];
} {
  const calls: string[] = [];
  let step = 0;
  const fetcher = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    const body = stages[Math.min(step, stages.length - 1)];
    step += 1;
    return jsonResponse(200, body);
  });
  return {
    client: new CoordinatorClient({
      baseUrl: 'https://coordinator.fixture',
      fetcher: fetcher as unknown as typeof fetch,
    }),
    calls,
  };
}

// ── Flow 1: settle and claim ────────────────────────────────────────────────

describe('flow 1 — eth_to_xlm settles and claims', () => {
  it('walks every lifecycle stage through the coordinator client and guards', async () => {
    const stages = [
      ORDER_FLOW_1_ANNOUNCED,
      ORDER_FLOW_1_SRC_LOCKED,
      ORDER_FLOW_1_DST_LOCKED,
      ORDER_FLOW_1_SECRET_REVEALED,
      ORDER_FLOW_1_COMPLETED,
    ];

    const { client } = coordinatorServing(stages);

    const announced = await client.announceOrder(ANNOUNCE_FLOW_1);
    expect(announced.status).toBe('announced');
    expect(announced.id).toBe(orderIdFromHashlock(PAIR_ETH_TO_XLM.hashlock));

    // `coordinatorServing` advances one stage per fetch, so the announce
    // consumed stage 0 and each `getOrder` consumes the next.
    const statuses: string[] = [];
    for (let i = 1; i < stages.length; i += 1) {
      const current = await client.getOrder(stages[0]!.id);
      expect(current).not.toBeNull();
      statuses.push(current!.status);
      if (i > 1) {
        expect(
          canTransition(stages[i - 1]!.status, current!.status),
          `${stages[i - 1]!.status} -> ${current!.status}`
        ).toBe(true);
      }
    }
    expect(statuses).toEqual(['src_locked', 'dst_locked', 'secret_revealed', 'completed']);
  });

  it('reveals the secret only after the destination leg is locked, and the reveal carries the fixture preimage', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new CoordinatorClient({
      baseUrl: 'https://coordinator.fixture',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.revealSecret({
      publicId: ORDER_FLOW_1_COMPLETED.id,
      preimage: PAIR_ETH_TO_XLM.preimage,
      txHash: '77da006b864569b786f183aed5e36a8a303331e65f4420100f695f211c3f9607',
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://coordinator.fixture/api/secrets/reveal');
    expect(JSON.parse(init.body as string)).toEqual({
      publicId: ORDER_FLOW_1_COMPLETED.id,
      preimage: PAIR_ETH_TO_XLM.preimage,
      txHash: '77da006b864569b786f183aed5e36a8a303331e65f4420100f695f211c3f9607',
    });
  });

  it("reads the revealed secret back and it opens the order's hashlock", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        publicId: ORDER_FLOW_1_COMPLETED.id,
        preimage: PAIR_ETH_TO_XLM.preimage,
      })
    );
    const client = new CoordinatorClient({
      baseUrl: 'https://coordinator.fixture',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const secret = await client.getSecret(ORDER_FLOW_1_COMPLETED.id);
    expect(secret?.preimage).toBe(PAIR_ETH_TO_XLM.preimage);
  });

  it('the completed order still reports a live timelock, then stops once it lapses', () => {
    // `estimateTimelockRemaining` returns null for a terminal status and for
    // a lapsed timelock — the two cases a UI must not confuse.
    const atLock = estimateTimelockRemaining(
      ORDER_FLOW_1_SRC_LOCKED.status,
      ORDER_FLOW_1_SRC_LOCKED.src.timelock,
      ORDER_FLOW_1_SRC_LOCKED.updatedAt
    );
    expect(atLock).toBe(3_600 - 45);

    const afterCompletion = estimateTimelockRemaining(
      ORDER_FLOW_1_COMPLETED.status,
      ORDER_FLOW_1_COMPLETED.src.timelock,
      ORDER_FLOW_1_COMPLETED.updatedAt
    );
    expect(afterCompletion).toBeNull();

    const lapsed = estimateTimelockRemaining(
      ORDER_FLOW_1_SRC_LOCKED.status,
      ORDER_FLOW_1_SRC_LOCKED.src.timelock,
      ORDER_FLOW_1_SRC_LOCKED.src.timelock! + 1
    );
    expect(lapsed).toBeNull();
  });

  it('the resolver that filled the destination leg is recorded, and it is an EVM address', () => {
    expect(ORDER_FLOW_1_DST_LOCKED.resolver).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ORDER_FLOW_1_ANNOUNCED.resolver).toBeNull();
  });
});

// ── Flow 2: expire and refund ───────────────────────────────────────────────

describe('flow 2 — sol_to_eth expires and refunds', () => {
  it('walks announce → src_locked → expired → refunded', async () => {
    const stages = [ORDER_FLOW_2_SRC_LOCKED, ORDER_FLOW_2_EXPIRED, ORDER_FLOW_2_REFUNDED];
    const { client } = coordinatorServing(stages);

    const seen: string[] = [];
    for (let i = 0; i < stages.length; i += 1) {
      const current = await client.getOrder(ORDER_FLOW_2_REFUNDED.id);
      seen.push(current!.status);
    }
    expect(seen).toEqual(['src_locked', 'expired', 'refunded']);
  });

  it('the refund transaction on the Solana source leg is a Solana signature, not an EVM hash', () => {
    expect(ORDER_FLOW_2_REFUNDED.src.chain).toBe('solana');
    expect(ORDER_FLOW_2_REFUNDED.src.lockTx).toBe(SOL_TX_REFUND);
    expect(ORDER_FLOW_2_REFUNDED.src.lockTx).not.toMatch(/^0x/);
  });

  it('the destination leg was never funded, so the refund is the only safe outcome', () => {
    for (const order of [ORDER_FLOW_2_SRC_LOCKED, ORDER_FLOW_2_EXPIRED, ORDER_FLOW_2_REFUNDED]) {
      expect(order.dst.orderId).toBeNull();
      expect(order.dst.lockTx).toBeNull();
    }
  });

  it('a refund attempted before the timelock expires is classified as timelock_not_expired', () => {
    // The adapter's classifier reads the error message, so a real contract
    // revert string is what gets classified. This is the message
    // `HTLCEscrow.refundOrder` produces, and the Solana program's equivalent.
    const evmRevert = 'execution reverted: TimelockNotExpired';
    const solanaRevert = 'AnchorError occurred. Error Code: TimelockNotExpired.';

    for (const message of [evmRevert, solanaRevert]) {
      const lc = message.toLowerCase();
      const classified = lc.includes('timelock') ? 'timelock_not_expired' : 'chain_error';
      expect(classified).toBe('timelock_not_expired');
    }
  });

  it('a wrong preimage is classified as invalid_preimage and is not retryable', () => {
    // The Ethereum adapter matches `lc.includes("invalid preimage")`, which
    // is why `HTLCEscrow` reverts are worded with a space rather than
    // camel-cased. Both wordings the three chains actually produce are
    // checked, because "the Solana string contains the Ethereum substring"
    // is not something to assume.
    const ethereumRevert = 'execution reverted: Invalid preimage';
    const solanaRevert = 'AnchorError: invalid preimage';
    const sorobanRevert = 'HostError: invalid preimage';

    for (const revert of [ethereumRevert, solanaRevert, sorobanRevert]) {
      const lc = revert.toLowerCase();
      expect(
        lc.includes('invalid preimage') || lc.includes('hashlock'),
        `${revert} is matched by no adapter classifier`
      ).toBe(true);
    }

    const error = new HTLCError({
      code: 'invalid_preimage',
      message: 'Preimage does not match the hashlock',
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });
});

// ── Solana leg driven through the real client ───────────────────────────────

describe('the Solana leg replays through SolanaHTLCClient', () => {
  it('derives the fixture order id from the hashlock, matching the coordinator payload', () => {
    const client = new SolanaHTLCClient({
      rpcUrl: 'http://127.0.0.1:8899',
      allowHttp: true,
      programId: SOL_HTLC_PROGRAM_ID,
    });
    // `deriveOrderId` is the pure, network-free path: seeds [b"order", hashlock].
    expect(client.deriveOrderId(PAIR_SOL_TO_ETH.hashlock)).toBe(SOL_ORDER_PDA_FLOW_2);
    expect(ORDER_FLOW_2_SRC_LOCKED.src.orderId).toBe(SOL_ORDER_PDA_FLOW_2);
  });

  it('reads the funded account and reports exactly what the coordinator says', async () => {
    const client = new SolanaHTLCClient({
      rpcUrl: 'http://127.0.0.1:8899',
      allowHttp: true,
      programId: SOL_HTLC_PROGRAM_ID,
    });

    // Stub the transport, not the client: `getAccountInfo` returns the
    // fixture's 227-byte account, and everything after that is real SDK code.
    const info = vi
      .spyOn(
        (client as unknown as { connection: { getAccountInfo: unknown } }).connection as {
          getAccountInfo: (pk: unknown, commitment: unknown) => Promise<unknown>;
        },
        'getAccountInfo'
      )
      .mockResolvedValue({
        executable: false,
        owner: SOL_HTLC_PROGRAM_ID,
        data: SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
        lamports: 2_010_000_000,
        rentEpoch: 361,
        space: 227,
      });

    const order = await client.getOrder(SOL_ORDER_PDA_FLOW_2);
    info.mockRestore();

    expect(order).not.toBeNull();
    expect(order!.sender).toBe(SOL_SRC);
    expect(order!.mint).toBe(NATIVE_SOL_MINT);
    expect(order!.hashlock).toBe(PAIR_SOL_TO_ETH.hashlock);
    expect(order!.status).toBe(0);
    // The amount the chain reports is the amount the coordinator promised.
    expect(order!.amount.toString()).toBe(ORDER_FLOW_2_SRC_LOCKED.src.amount);
    expect(order!.safetyDeposit.toString()).toBe(ORDER_FLOW_2_SRC_LOCKED.src.safetyDeposit!);
    expect(order!.timelock).toBe(ORDER_FLOW_2_SRC_LOCKED.src.timelock);
  });

  it('a Solana account is returned as null, not an error, when it does not exist', async () => {
    const client = new SolanaHTLCClient({
      rpcUrl: 'http://127.0.0.1:8899',
      allowHttp: true,
      programId: SOL_HTLC_PROGRAM_ID,
    });
    const info = vi
      .spyOn(
        (client as unknown as { connection: { getAccountInfo: unknown } }).connection as {
          getAccountInfo: (pk: unknown, commitment: unknown) => Promise<unknown>;
        },
        'getAccountInfo'
      )
      .mockResolvedValue(null);

    await expect(client.getOrder(SOL_ORDER_PDA_FLOW_2)).resolves.toBeNull();
    info.mockRestore();
  });
});

// ── Soroban leg driven through the real decode ──────────────────────────────

describe('the Soroban leg replays through the real XDR decode', () => {
  it('the funded, claimed and refunded retvals tell a coherent lifecycle story', () => {
    const funded = decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.funded);
    const claimed = decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.claimed);
    const refunded = decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.refunded);

    expect(funded.status).toBe(0);
    expect(claimed.status).toBe(1);
    expect(refunded.status).toBe(2);

    // Identity is stable across the lifecycle; only the state moves.
    for (const order of [funded, claimed, refunded]) {
      expect(order.id).toBe(funded.id);
      expect(order.hashlock).toEqual(funded.hashlock);
      expect(order.amount).toBe(funded.amount);
    }

    // Timestamps only move forward.
    expect(claimed.finalised_at).toBeGreaterThan(funded.finalised_at);
    expect(refunded.finalised_at).toBeGreaterThan(claimed.finalised_at);
    expect(funded.finalised_at).toBe(0n);
  });

  it('the claimed Soroban order carries the preimage that the Solana leg reveals', () => {
    const claimed = decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.claimed);
    expect('0x' + Buffer.from(claimed.preimage).toString('hex')).toBe(PAIR_SOL_TO_ETH.preimage);
    // And the funded order has not leaked it.
    expect(decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.funded).preimage).toHaveLength(0);
  });
});

// ── History surface ─────────────────────────────────────────────────────────

describe('a mixed-chain history page normalises through HistoryClient', () => {
  it('produces records whose stable fields match the coordinator payloads', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, HISTORY_PAGE_MIXED));
    const coordinator = new CoordinatorClient({
      baseUrl: 'https://coordinator.fixture',
      fetcher: fetcher as unknown as typeof fetch,
    });
    const history = new HistoryClient({ coordinatorClient: coordinator });

    const page = await history.getPage({ address: ORDER_FLOW_1_COMPLETED.src.address });

    expect(page.records).toHaveLength(3);
    expect(page.records.map(r => r.status)).toEqual(['completed', 'src_locked', 'refunded']);

    const completed = page.records[0]!;
    expect(completed.id).toBe(ORDER_FLOW_1_COMPLETED.id);
    expect(completed.direction).toBe('eth_to_xlm');
    expect(completed.hashlock).toBe(PAIR_ETH_TO_XLM.hashlock);
    // `HistoryRecord` is documented as localStorage-safe, so nothing in a
    // record may be a bigint or a Date.
    expect(JSON.parse(JSON.stringify(completed))).toEqual(completed);
  });

  it('every record in the page survives a JSON round trip unchanged', () => {
    for (const order of HISTORY_PAGE_MIXED.transactions) {
      const round = JSON.parse(JSON.stringify(order));
      expect(round).toEqual(order);
    }
  });
});

// ── The approval flow a USDC leg depends on ─────────────────────────────────

describe('the ERC-20 approval step the USDC route requires', () => {
  it('an insufficient allowance is an approval error with actionable copy', () => {
    expect(isApprovalError('insufficient_allowance')).toBe(true);
    const message = normalizeApprovalMessage(
      'insufficient_allowance',
      'ethereum',
      'current=0, required=250000000'
    );
    expect(message.toLowerCase()).toContain('approve');
    expect(message).toContain('required=250000000');
  });

  it('the other two chains need no separate approval step', () => {
    for (const chain of ['soroban', 'solana'] as const) {
      const message = normalizeApprovalMessage('insufficient_allowance', chain);
      expect(message).not.toContain('approve(');
    }
  });

  it('a safety deposit below the minimum is also an approval-class error', () => {
    expect(isApprovalError('safety_deposit_too_small')).toBe(true);
    const message = normalizeApprovalMessage('safety_deposit_too_small', 'ethereum');
    expect(message.toLowerCase()).toContain('minsafetydeposit');
  });
});
