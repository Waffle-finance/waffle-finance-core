/**
 * Contract tests for the order-event schema.
 *
 * These lock down the guarantees the rest of the frontend is allowed to rely
 * on: a closed status union, no `undefined` in optional fields, and the
 * invariant that a failure status always carries an error while a non-failure
 * status never does.
 */

import { describe, expect, test } from 'vitest';
import {
  createOrderEventPayload,
  isFailureStatus,
  isKnownOrderStatusInput,
  isOrderEventStatus,
  isTerminalOrderStatus,
  normalizeOrderStatus,
  orderEventFromCoordinatorRecord,
  orderEventFromHistoryRow,
  toOrderEventError,
  type OrderEventStatus,
} from './orderEvents';

describe('normalizeOrderStatus', () => {
  test('passes canonical statuses through unchanged', () => {
    const canonical: OrderEventStatus[] = [
      'pending',
      'confirmed',
      'completed',
      'cancelled',
      'failed',
      'refunded',
      'expired',
      'timed_out',
    ];

    for (const status of canonical) {
      expect(normalizeOrderStatus(status)).toBe(status);
    }
  });

  test('maps the coordinator status union onto the canonical union', () => {
    // The whole point of the contract: an SDK-vocabulary status and a
    // frontend-vocabulary status describing the same thing land on one value.
    expect(normalizeOrderStatus('announced')).toBe('pending');
    expect(normalizeOrderStatus('src_locked')).toBe('pending');
    expect(normalizeOrderStatus('dst_locked')).toBe('confirmed');
    expect(normalizeOrderStatus('secret_revealed')).toBe('confirmed');
    expect(normalizeOrderStatus('completed')).toBe('completed');
    expect(normalizeOrderStatus('refunded')).toBe('refunded');
    expect(normalizeOrderStatus('failed')).toBe('failed');
    expect(normalizeOrderStatus('expired')).toBe('expired');
    expect(normalizeOrderStatus('cancelled')).toBe('cancelled');
    expect(normalizeOrderStatus('abandoned')).toBe('cancelled');
  });

  test('falls back to pending for unrecognised input rather than inventing a failure', () => {
    for (const raw of ['some_future_status', '', null, undefined, 42, {}]) {
      expect(normalizeOrderStatus(raw)).toBe('pending');
    }
  });

  test('isKnownOrderStatusInput distinguishes a real pending from a fallback', () => {
    expect(isKnownOrderStatusInput('pending')).toBe(true);
    expect(isKnownOrderStatusInput('announced')).toBe(true);
    expect(isKnownOrderStatusInput('some_future_status')).toBe(false);
    expect(isKnownOrderStatusInput(undefined)).toBe(false);
  });

  test('isOrderEventStatus rejects coordinator-vocabulary values', () => {
    expect(isOrderEventStatus('pending')).toBe(true);
    expect(isOrderEventStatus('src_locked')).toBe(false);
  });
});

describe('status predicates', () => {
  test('terminal statuses are exactly the ones that cannot progress', () => {
    expect(isTerminalOrderStatus('pending')).toBe(false);
    expect(isTerminalOrderStatus('confirmed')).toBe(false);

    for (const status of ['completed', 'cancelled', 'failed', 'refunded', 'expired', 'timed_out'] as const) {
      expect(isTerminalOrderStatus(status)).toBe(true);
    }
  });

  test('failure statuses are the terminal statuses that did not deliver', () => {
    expect(isFailureStatus('failed')).toBe(true);
    expect(isFailureStatus('expired')).toBe(true);
    expect(isFailureStatus('timed_out')).toBe(true);

    // A refund or a cancellation is terminal but not a failure: the user got
    // their funds back, so the UI should not show it as an error.
    expect(isFailureStatus('refunded')).toBe(false);
    expect(isFailureStatus('cancelled')).toBe(false);
    expect(isFailureStatus('completed')).toBe(false);
  });
});

describe('toOrderEventError', () => {
  test('extracts the message from an Error and classifies retryability', () => {
    expect(toOrderEventError(new Error('boom'), 'network')).toEqual({
      code: 'network',
      message: 'boom',
      retryable: true,
    });
  });

  test('marks parse and order_failed as non-retryable', () => {
    expect(toOrderEventError(new Error('bad json'), 'parse').retryable).toBe(false);
    expect(toOrderEventError(new Error('settled'), 'order_failed').retryable).toBe(false);
  });

  test('survives non-Error throws', () => {
    expect(toOrderEventError('string failure').message).toBe('string failure');
    expect(toOrderEventError(undefined).message).toBe('Unknown subscription error');
    expect(toOrderEventError({ weird: true }).message).toBe('Unknown subscription error');
  });
});

describe('createOrderEventPayload', () => {
  test('fills every optional field with null rather than undefined', () => {
    const payload = createOrderEventPayload({
      orderId: 'wf_1',
      status: 'pending',
      source: 'poll',
    });

    // Consumers are promised they never have to guard against undefined.
    expect(payload.previousStatus).toBeNull();
    expect(payload.srcTxHash).toBeNull();
    expect(payload.dstTxHash).toBeNull();
    expect(payload.error).toBeNull();
    expect(payload.details).toEqual({});

    for (const value of Object.values(payload)) {
      expect(value).not.toBeUndefined();
    }
  });

  test('synthesises an error when a failure status arrives without one', () => {
    const payload = createOrderEventPayload({
      orderId: 'wf_2',
      status: 'failed',
      source: 'local',
    });

    expect(payload.error).toEqual({
      code: 'order_failed',
      message: 'Order wf_2 ended in state "failed".',
      retryable: false,
    });
  });

  test('keeps a supplied error on a failure status', () => {
    const payload = createOrderEventPayload({
      orderId: 'wf_3',
      status: 'timed_out',
      source: 'local',
      error: { code: 'network', message: 'receipt polling exhausted', retryable: true },
    });

    expect(payload.error?.message).toBe('receipt polling exhausted');
  });

  test('drops an error attached to a non-failure status', () => {
    // Keeps `isFailureStatus(status) === (error !== null)` true in both
    // directions, so `payload.error && ...` is a safe test for consumers.
    const payload = createOrderEventPayload({
      orderId: 'wf_4',
      status: 'completed',
      source: 'poll',
      error: { code: 'network', message: 'stale error', retryable: true },
    });

    expect(payload.error).toBeNull();
  });

  test('normalises coordinator statuses on the way in', () => {
    expect(createOrderEventPayload({ orderId: 'wf_5', status: 'dst_locked', source: 'live' }).status)
      .toBe('confirmed');
  });

  test('freezes details so a consumer cannot mutate a shared payload', () => {
    const payload = createOrderEventPayload({
      orderId: 'wf_6',
      status: 'pending',
      source: 'poll',
      details: { amount: '1.5' },
    });

    expect(Object.isFrozen(payload.details)).toBe(true);
    expect(payload.details.amount).toBe('1.5');
  });

  test('is JSON round-trippable without loss', () => {
    const payload = createOrderEventPayload({
      orderId: 'wf_7',
      status: 'failed',
      source: 'local',
      at: 1_700_000_000_000,
      srcTxHash: '0xabc',
      details: { amount: '2' },
    });

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe('orderEventFromHistoryRow', () => {
  test('assigns tx hashes to legs by swap direction', () => {
    const ethToXlm = orderEventFromHistoryRow({
      id: 'wf_8',
      status: 'pending',
      direction: 'eth-to-xlm',
      ethTxHash: '0xeth',
      stellarTxHash: 'stellarhash',
    });

    expect(ethToXlm.srcTxHash).toBe('0xeth');
    expect(ethToXlm.dstTxHash).toBe('stellarhash');

    const xlmToEth = orderEventFromHistoryRow({
      id: 'wf_9',
      status: 'pending',
      direction: 'xlm-to-eth',
      ethTxHash: '0xeth',
      stellarTxHash: 'stellarhash',
    });

    // Same two hashes, mirrored — this is the mapping the bridge form used to
    // get wrong when it built payloads by hand.
    expect(xlmToEth.srcTxHash).toBe('stellarhash');
    expect(xlmToEth.dstTxHash).toBe('0xeth');
  });

  test('falls back to the generic txHash for single-leg rows', () => {
    const payload = orderEventFromHistoryRow({
      id: 'wf_10',
      status: 'pending',
      direction: 'eth-to-xlm',
      txHash: '0xonly',
    });

    expect(payload.srcTxHash).toBe('0xonly');
    expect(payload.dstTxHash).toBeNull();
  });

  test('routes everything not promoted into the schema through details', () => {
    const payload = orderEventFromHistoryRow({
      id: 'wf_11',
      status: 'completed',
      direction: 'eth-to-xlm',
      txHash: '0x1',
      ethTxHash: '0x1',
      amount: '0.5',
      estimatedAmount: '5000',
      networkMode: 'testnet',
    });

    expect(payload.details).toEqual({
      direction: 'eth-to-xlm',
      amount: '0.5',
      estimatedAmount: '5000',
      networkMode: 'testnet',
    });
    // Promoted fields must not be duplicated into the passthrough bag.
    expect(payload.details).not.toHaveProperty('id');
    expect(payload.details).not.toHaveProperty('status');
    expect(payload.details).not.toHaveProperty('txHash');
  });

  test('defaults to the poll source', () => {
    expect(orderEventFromHistoryRow({ id: 'wf_12', status: 'pending' }).source).toBe('poll');
    expect(orderEventFromHistoryRow({ id: 'wf_12', status: 'pending' }, 'local').source).toBe('local');
  });
});

describe('orderEventFromCoordinatorRecord', () => {
  test('normalises an SDK HistoryRecord into the same shape as a history row', () => {
    const payload = orderEventFromCoordinatorRecord({
      id: 'wf_0xabc',
      status: 'secret_revealed',
      direction: 'eth_to_xlm',
      src: { lockTx: '0xlock', amount: '1000', address: '0xfrom' },
      dst: { lockTx: 'stellarlock', amount: '2000', address: 'GTO' },
      updatedAt: 1_700_000_000,
    });

    expect(payload.status).toBe('confirmed');
    expect(payload.srcTxHash).toBe('0xlock');
    expect(payload.dstTxHash).toBe('stellarlock');
    expect(payload.source).toBe('live');
    // Coordinator speaks unix seconds; the contract speaks unix ms.
    expect(payload.at).toBe(1_700_000_000_000);
  });

  test('tolerates a partially indexed record', () => {
    const payload = orderEventFromCoordinatorRecord({ id: 'wf_partial', status: 'announced' });

    expect(payload.status).toBe('pending');
    expect(payload.srcTxHash).toBeNull();
    expect(payload.dstTxHash).toBeNull();
  });
});
