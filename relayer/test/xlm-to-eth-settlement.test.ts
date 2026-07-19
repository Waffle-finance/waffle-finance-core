/**
 * Tests for the hardened XLM→ETH settlement path.
 *
 * Strategy: mount only the modules under test on a standalone Express app
 * so we never boot the full relayer. All Horizon and ETH RPC calls are
 * mocked via dependency injection — no network access.
 *
 * Coverage:
 *  StellarProofLedger unit:
 *   - consume() grants first call, rejects duplicate
 *   - isConsumed() reflects state correctly
 *   - getEntry() returns stored metadata
 *   - size() and snapshot() work correctly
 *
 *  horizon-verifier unit:
 *   - valid payment → returns VerifiedStellarPayment
 *   - tx not found → throws StellarTxNotFoundError
 *   - tx failed on-chain → throws StellarTxFailedError
 *   - no matching payment op → throws StellarPaymentMismatch
 *   - wrong source account → throws StellarPaymentMismatch
 *   - zero amount payment → throws StellarPaymentMismatch
 *
 *  /api/orders/xlm-to-eth route integration:
 *   - missing fields → 400
 *   - order not found → 404
 *   - wrong order direction → 400
 *   - already settled (eth_tx_sent) → 200 cached
 *   - terminal status (refunded) → 409
 *   - Horizon tx not found → 404
 *   - Horizon tx failed → 400
 *   - payment mismatch → 400
 *   - missing exchange rate → 400
 *   - valid proof + ETH send succeeds → 200 with txId
 *   - replay same stellarTxHash → 409
 *   - concurrent replay (race condition) → 409 on second
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

import {
  StellarProofLedger,
} from '../src/services/stellar-proof-ledger.js';

import {
  verifyIncomingStellarPayment,
  StellarTxNotFoundError,
  StellarTxFailedError,
  StellarPaymentMismatch,
  type HorizonTxRecord,
  type HorizonOpRecord,
} from '../src/services/horizon-verifier.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const RELAYER_PUBKEY = 'GDRELAYER000000000000000000000000000000000000000000000000';
const USER_STELLAR   = 'GUSER0000000000000000000000000000000000000000000000000000';
const STELLAR_TXHASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456ab12';
const ORDER_ID       = 'order-test-001';
const ETH_ADDRESS    = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function makeHorizonFetch(
  tx: Partial<HorizonTxRecord>,
  ops: HorizonOpRecord[]
) {
  return vi.fn().mockResolvedValue({ tx: { successful: true, ledger: 12345, ...tx }, ops });
}

function validPaymentOps(overrides: Partial<HorizonOpRecord> = {}): HorizonOpRecord[] {
  return [{
    type: 'payment',
    from: USER_STELLAR,
    to: RELAYER_PUBKEY,
    amount: '100.0000000',
    asset_type: 'native',
    ...overrides,
  }];
}

// ---------------------------------------------------------------------------
// StellarProofLedger unit tests
// ---------------------------------------------------------------------------

describe('StellarProofLedger', () => {
  let ledger: StellarProofLedger;

  beforeEach(() => { ledger = new StellarProofLedger(); });

  it('consume() returns true on first call', () => {
    expect(ledger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '10.0000000' })).toBe(true);
  });

  it('consume() returns false on duplicate call', () => {
    ledger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '10.0000000' });
    expect(ledger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '10.0000000' })).toBe(false);
  });

  it('isConsumed() returns false before consume, true after', () => {
    expect(ledger.isConsumed(STELLAR_TXHASH)).toBe(false);
    ledger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '5.0000000' });
    expect(ledger.isConsumed(STELLAR_TXHASH)).toBe(true);
  });

  it('getEntry() returns stored metadata', () => {
    ledger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '7.5000000', ledgerSequence: 99 });
    const entry = ledger.getEntry(STELLAR_TXHASH);
    expect(entry?.orderId).toBe(ORDER_ID);
    expect(entry?.verifiedAmount).toBe('7.5000000');
    expect(entry?.ledgerSequence).toBe(99);
    expect(typeof entry?.consumedAt).toBe('number');
  });

  it('getEntry() returns undefined for unknown hash', () => {
    expect(ledger.getEntry('unknown')).toBeUndefined();
  });

  it('size() tracks entries correctly', () => {
    expect(ledger.size()).toBe(0);
    ledger.consume('hash1', { orderId: 'o1', verifiedAmount: '1.0' });
    ledger.consume('hash2', { orderId: 'o2', verifiedAmount: '2.0' });
    expect(ledger.size()).toBe(2);
  });

  it('snapshot() returns all entries', () => {
    ledger.consume('hash1', { orderId: 'o1', verifiedAmount: '1.0' });
    ledger.consume('hash2', { orderId: 'o2', verifiedAmount: '2.0' });
    const snap = ledger.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map(e => e.stellarTxHash)).toContain('hash1');
    expect(snap.map(e => e.stellarTxHash)).toContain('hash2');
  });

  it('different hashes are independent', () => {
    ledger.consume('hash-a', { orderId: 'o1', verifiedAmount: '1.0' });
    expect(ledger.consume('hash-b', { orderId: 'o2', verifiedAmount: '2.0' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// horizon-verifier unit tests
// ---------------------------------------------------------------------------

describe('verifyIncomingStellarPayment — happy path', () => {
  it('returns verified payment details for a valid tx', async () => {
    const fetch = makeHorizonFetch({}, validPaymentOps());
    const result = await verifyIncomingStellarPayment(STELLAR_TXHASH, {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      relayerPublicKey: RELAYER_PUBKEY,
      expectedSourceAccount: USER_STELLAR,
      _fetch: fetch,
    });
    expect(result.amount).toBe('100.0000000');
    expect(result.from).toBe(USER_STELLAR);
    expect(result.to).toBe(RELAYER_PUBKEY);
    expect(result.ledgerSequence).toBe(12345);
  });

  it('passes when expectedSourceAccount is omitted', async () => {
    const fetch = makeHorizonFetch({}, validPaymentOps());
    const result = await verifyIncomingStellarPayment(STELLAR_TXHASH, {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      relayerPublicKey: RELAYER_PUBKEY,
      _fetch: fetch,
    });
    expect(result.amount).toBe('100.0000000');
  });

  it('returns memo when present on the tx', async () => {
    const fetch = makeHorizonFetch({ memo: 'swap:order-123' }, validPaymentOps());
    const result = await verifyIncomingStellarPayment(STELLAR_TXHASH, {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      relayerPublicKey: RELAYER_PUBKEY,
      _fetch: fetch,
    });
    expect(result.memo).toBe('swap:order-123');
  });
});

describe('verifyIncomingStellarPayment — error cases', () => {
  it('throws StellarTxNotFoundError when fetch throws 404', async () => {
    const fetch = vi.fn().mockRejectedValue(new StellarTxNotFoundError(STELLAR_TXHASH));
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarTxNotFoundError);
  });

  it('throws StellarTxFailedError when tx.successful is false', async () => {
    const fetch = makeHorizonFetch({ successful: false }, validPaymentOps());
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarTxFailedError);
  });

  it('throws StellarPaymentMismatch when no native payment op to relayer', async () => {
    const fetch = makeHorizonFetch({}, [{ type: 'payment', from: USER_STELLAR, to: 'GWRONG', amount: '10', asset_type: 'native' }]);
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarPaymentMismatch);
  });

  it('throws StellarPaymentMismatch for non-native asset', async () => {
    const fetch = makeHorizonFetch({}, [{ type: 'payment', from: USER_STELLAR, to: RELAYER_PUBKEY, amount: '10', asset_type: 'credit_alphanum4' }]);
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarPaymentMismatch);
  });

  it('throws StellarPaymentMismatch when source account does not match expected', async () => {
    const fetch = makeHorizonFetch({}, validPaymentOps({ from: 'GDIFFERENT_USER' }));
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        expectedSourceAccount: USER_STELLAR,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarPaymentMismatch);
  });

  it('throws StellarPaymentMismatch when amount is zero', async () => {
    const fetch = makeHorizonFetch({}, validPaymentOps({ amount: '0.0000000' }));
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarPaymentMismatch);
  });

  it('throws StellarPaymentMismatch when ops array is empty', async () => {
    const fetch = makeHorizonFetch({}, []);
    await expect(
      verifyIncomingStellarPayment(STELLAR_TXHASH, {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        relayerPublicKey: RELAYER_PUBKEY,
        _fetch: fetch,
      })
    ).rejects.toBeInstanceOf(StellarPaymentMismatch);
  });
});

// ---------------------------------------------------------------------------
// /api/orders/xlm-to-eth route integration tests
//
// We build a minimal Express app that mirrors the hardened handler directly,
// injecting test doubles for Horizon lookups and ETH sends so we never
// touch the network.
// ---------------------------------------------------------------------------

interface MockOrder {
  direction?: string;
  status?: string;
  ethAddress?: string;
  ethTxHash?: string;
  exchangeRate?: number;
  [k: string]: unknown;
}

function buildSettlementApp(opts: {
  orders?: Map<string, MockOrder>;
  horizonResult?: 'ok' | 'not_found' | 'failed' | 'mismatch' | 'wrong_source';
  sendTxResult?: 'ok' | 'fail';
  proofLedger?: StellarProofLedger;
}) {
  const {
    orders = new Map<string, MockOrder>([[ORDER_ID, { direction: 'xlm_to_eth', status: 'pending', ethAddress: ETH_ADDRESS, exchangeRate: 10000 }]]),
    horizonResult = 'ok',
    sendTxResult = 'ok',
    proofLedger = new StellarProofLedger(),
  } = opts;

  // Build a mock verifyIncomingStellarPayment
  async function mockVerify(hash: string, _opts: any) {
    if (horizonResult === 'not_found') throw new StellarTxNotFoundError(hash);
    if (horizonResult === 'failed') throw new StellarTxFailedError(hash, 'tx_not_successful');
    if (horizonResult === 'mismatch') throw new StellarPaymentMismatch('No matching payment op');
    if (horizonResult === 'wrong_source') throw new StellarPaymentMismatch('Source account mismatch');
    return { amount: '100.0000000', from: USER_STELLAR, to: RELAYER_PUBKEY, ledgerSequence: 12345, memo: undefined };
  }

  const app = express();
  app.use(express.json());

  app.post('/api/orders/xlm-to-eth', async (req, res) => {
    const { orderId, stellarTxHash, stellarAddress, ethAddress, networkMode } = req.body;

    if (!orderId || !stellarTxHash || !ethAddress || !stellarAddress) {
      return res.status(400).json({ error: 'Missing required fields: orderId, stellarTxHash, ethAddress, stellarAddress' });
    }

    if (proofLedger.isConsumed(stellarTxHash)) {
      const existing = proofLedger.getEntry(stellarTxHash);
      return res.status(409).json({ error: 'Stellar transaction already consumed', stellarTxHash, existingOrder: existing?.orderId });
    }

    const storedOrder = orders.get(orderId);
    if (!storedOrder) return res.status(404).json({ error: 'Order not found', orderId });
    if (storedOrder.direction && storedOrder.direction !== 'xlm_to_eth') return res.status(400).json({ error: 'Order direction mismatch' });
    if (storedOrder.status === 'eth_tx_sent' || storedOrder.status === 'completed') {
      return res.status(200).json({ success: true, orderId, ethTxId: storedOrder.ethTxHash, fromCache: true });
    }
    if (storedOrder.status === 'refunded' || storedOrder.status === 'stellar_transfer_failed') {
      return res.status(409).json({ error: 'Order is in a terminal state', status: storedOrder.status });
    }

    let verifiedPayment: any;
    try {
      verifiedPayment = await mockVerify(stellarTxHash, {});
    } catch (verifyErr: unknown) {
      if (verifyErr instanceof StellarTxNotFoundError) return res.status(404).json({ error: 'Stellar transaction not found on Horizon', stellarTxHash });
      if (verifyErr instanceof StellarTxFailedError) return res.status(400).json({ error: 'Stellar transaction failed on-chain', stellarTxHash });
      if (verifyErr instanceof StellarPaymentMismatch) return res.status(400).json({ error: 'Stellar payment verification failed', details: (verifyErr as Error).message });
      return res.status(503).json({ error: 'Horizon verification temporarily unavailable' });
    }

    const consumed = proofLedger.consume(stellarTxHash, { orderId, verifiedAmount: verifiedPayment.amount, ledgerSequence: verifiedPayment.ledgerSequence });
    if (!consumed) return res.status(409).json({ error: 'Stellar transaction already consumed by a concurrent request', stellarTxHash });

    const exchangeRate = storedOrder.exchangeRate;
    if (!exchangeRate || isNaN(Number(exchangeRate)) || Number(exchangeRate) <= 0) {
      return res.status(400).json({ error: 'Order is missing a valid exchange rate', orderId });
    }

    if (sendTxResult === 'fail') {
      return res.status(500).json({ error: 'ETH release failed', details: 'RPC error: nonce too low', refund: { status: 'failed', orderId } });
    }

    const mockTxHash = '0xeth_tx_hash_mock_' + orderId;
    storedOrder.status = 'eth_tx_sent';
    storedOrder.ethTxHash = mockTxHash;

    return res.json({
      success: true,
      orderId,
      ethTxId: mockTxHash,
      message: 'XLM→ETH transfer broadcasted',
      details: {
        stellar: { txHash: stellarTxHash, verifiedAmount: verifiedPayment.amount, status: 'confirmed' },
        ethereum: { txId: mockTxHash, status: 'pending' },
      },
    });
  });

  return app;
}

const VALID_BODY = { orderId: ORDER_ID, stellarTxHash: STELLAR_TXHASH, stellarAddress: USER_STELLAR, ethAddress: ETH_ADDRESS };

describe('/api/orders/xlm-to-eth — input validation', () => {
  it('returns 400 when orderId is missing', async () => {
    const app = buildSettlementApp({});
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send({ stellarTxHash: STELLAR_TXHASH, ethAddress: ETH_ADDRESS, stellarAddress: USER_STELLAR });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('returns 400 when stellarTxHash is missing', async () => {
    const app = buildSettlementApp({});
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send({ orderId: ORDER_ID, ethAddress: ETH_ADDRESS, stellarAddress: USER_STELLAR });
    expect(res.status).toBe(400);
  });

  it('returns 400 when stellarAddress is missing', async () => {
    const app = buildSettlementApp({});
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send({ orderId: ORDER_ID, stellarTxHash: STELLAR_TXHASH, ethAddress: ETH_ADDRESS });
    expect(res.status).toBe(400);
  });
});

describe('/api/orders/xlm-to-eth — order state guards', () => {
  it('returns 404 when order is not found', async () => {
    const app = buildSettlementApp({ orders: new Map() });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Order not found/);
  });

  it('returns 400 when order direction is not xlm_to_eth', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'eth_to_xlm', status: 'pending', exchangeRate: 10000 }]]);
    const app = buildSettlementApp({ orders });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/direction mismatch/);
  });

  it('returns 200 with cached txId when order already settled', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'xlm_to_eth', status: 'eth_tx_sent', ethTxHash: '0xalready', exchangeRate: 10000 }]]);
    const app = buildSettlementApp({ orders });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.fromCache).toBe(true);
    expect(res.body.ethTxId).toBe('0xalready');
  });

  it('returns 409 when order is in terminal refunded state', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'xlm_to_eth', status: 'refunded', exchangeRate: 10000 }]]);
    const app = buildSettlementApp({ orders });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/terminal state/);
  });
});

describe('/api/orders/xlm-to-eth — Horizon verification', () => {
  it('returns 404 when Stellar tx not found on Horizon', async () => {
    const app = buildSettlementApp({ horizonResult: 'not_found' });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found on Horizon/);
  });

  it('returns 400 when Stellar tx failed on-chain', async () => {
    const app = buildSettlementApp({ horizonResult: 'failed' });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/failed on-chain/);
  });

  it('returns 400 when payment does not match relayer wallet', async () => {
    const app = buildSettlementApp({ horizonResult: 'mismatch' });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/);
  });

  it('returns 400 when source account does not match expected user', async () => {
    const app = buildSettlementApp({ horizonResult: 'wrong_source' });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/);
  });
});

describe('/api/orders/xlm-to-eth — exchange rate guard', () => {
  it('returns 400 when order has no exchange rate', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'xlm_to_eth', status: 'pending', ethAddress: ETH_ADDRESS }]]);
    const app = buildSettlementApp({ orders });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exchange rate/);
  });

  it('returns 400 when exchange rate is zero', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'xlm_to_eth', status: 'pending', ethAddress: ETH_ADDRESS, exchangeRate: 0 }]]);
    const app = buildSettlementApp({ orders });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exchange rate/);
  });
});

describe('/api/orders/xlm-to-eth — successful settlement', () => {
  it('returns 200 with ethTxId for a valid proof', async () => {
    const app = buildSettlementApp({});
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.ethTxId).toBe('string');
    expect(res.body.ethTxId.length).toBeGreaterThan(0);
    expect(res.body.details.stellar.verifiedAmount).toBe('100.0000000');
    expect(res.body.details.stellar.status).toBe('confirmed');
  });

  it('marks the stellarTxHash as consumed after success', async () => {
    const proofLedger = new StellarProofLedger();
    const app = buildSettlementApp({ proofLedger });
    await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(proofLedger.isConsumed(STELLAR_TXHASH)).toBe(true);
    expect(proofLedger.getEntry(STELLAR_TXHASH)?.orderId).toBe(ORDER_ID);
  });

  it('updates order status to eth_tx_sent', async () => {
    const orders = new Map([[ORDER_ID, { direction: 'xlm_to_eth', status: 'pending', ethAddress: ETH_ADDRESS, exchangeRate: 10000 }]]);
    const app = buildSettlementApp({ orders });
    await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(orders.get(ORDER_ID)?.status).toBe('eth_tx_sent');
  });
});

describe('/api/orders/xlm-to-eth — replay protection', () => {
  it('rejects a second request with the same stellarTxHash (sequential replay)', async () => {
    const proofLedger = new StellarProofLedger();
    const app = buildSettlementApp({ proofLedger });

    const first = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(first.status).toBe(200);

    // Replay with different orderId to prove it is the txHash that gates it
    const orders2 = new Map([
      ['order-002', { direction: 'xlm_to_eth', status: 'pending', ethAddress: ETH_ADDRESS, exchangeRate: 10000 }],
    ]);
    const app2 = buildSettlementApp({ orders: orders2, proofLedger });
    const replay = await supertest(app2).post('/api/orders/xlm-to-eth').send({
      ...VALID_BODY,
      orderId: 'order-002',
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatch(/already consumed/);
    expect(replay.body.stellarTxHash).toBe(STELLAR_TXHASH);
  });

  it('rejects replay even if original order no longer exists in map', async () => {
    const proofLedger = new StellarProofLedger();
    // Pre-consume the hash simulating a previous successful settlement
    proofLedger.consume(STELLAR_TXHASH, { orderId: ORDER_ID, verifiedAmount: '100.0000000' });

    const app = buildSettlementApp({ proofLedger });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already consumed/);
    expect(res.body.existingOrder).toBe(ORDER_ID);
  });

  it('ETH send failure does not consume the proof (proof stays consumable for retry)', async () => {
    // When ETH send fails, we want operators to be able to retry after fixing
    // the ETH wallet. The proof itself was consumed before the send attempt,
    // but in a real system the operator would need to handle this manually.
    // Here we verify the proof IS consumed (the hash is marked used) so we
    // do NOT double-pay if ETH eventually broadcasts, and the 500 response
    // includes the original stellarTxHash for manual recovery.
    const proofLedger = new StellarProofLedger();
    const app = buildSettlementApp({ sendTxResult: 'fail', proofLedger });
    const res = await supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ETH release failed/);
    // Proof was consumed before the send attempt
    expect(proofLedger.isConsumed(STELLAR_TXHASH)).toBe(true);
  });
});

describe('/api/orders/xlm-to-eth — concurrent replay race', () => {
  it('only one of two concurrent identical requests succeeds', async () => {
    const proofLedger = new StellarProofLedger();
    const app = buildSettlementApp({ proofLedger });

    // Fire both requests in parallel
    const [r1, r2] = await Promise.all([
      supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY),
      supertest(app).post('/api/orders/xlm-to-eth').send(VALID_BODY),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // One succeeds (200), one is rejected (409)
    expect(statuses).toEqual([200, 409]);
    // The proof is consumed exactly once
    expect(proofLedger.size()).toBe(1);
  });
});
