/**
 * Tests for the coordinator response and order payload guards (#733).
 *
 * The boundary under test is `coordinator/client.ts`'s
 * `return parsed as T`. Everything here is about what happens when the body
 * on the other side of that line is not what the type says:
 *
 *   • every field of every `CoordinatorOrder` mutated to a wrong primitive
 *     kind, and the guard's reported path asserted;
 *   • the cross-field invariants a per-field check cannot catch;
 *   • the *equivalence* claim — replacing `toOrder`'s two `as \`0x${string}\``
 *     casts with these guards does not change what a valid order produces.
 *
 * That last one matters most: a guard that rejects something the existing
 * pipeline accepts is not a safety improvement, it is an outage.
 */

import { describe, it, expect } from 'vitest';

import { GuardError } from '../src/guards/result.js';
import {
  KNOWN_ORDER_STATUSES,
  assertCoordinatorHealthResponse,
  assertCoordinatorHistoryResponse,
  assertCoordinatorOrder,
  assertCoordinatorReadinessResponse,
  assertCoordinatorSecretResponse,
  validateCoordinatorHealthResponse,
  validateCoordinatorHistoryResponse,
  validateCoordinatorOrder,
  validateCoordinatorReadinessResponse,
  validateCoordinatorSecretResponse,
} from '../src/guards/coordinator-response.js';
import { asStrictOrder, assertOrder, validateOrder } from '../src/guards/order-payload.js';
import { toOrder } from '../src/coordinator/transform.js';

import {
  ORDER_FLOW_1_ANNOUNCED,
  ORDER_FLOW_1_SRC_LOCKED,
  ORDER_FLOW_2_REFUNDED,
  SECRET_RESPONSE_FLOW_1,
} from '../src/fixtures/coordinator-flows.js';
import {
  COORDINATOR_ORDER_FIXTURES,
  ERROR_ENVELOPE_FIXTURES,
  HEALTH_FIXTURES,
  HISTORY_PAGE_FIXTURES,
  READINESS_FIXTURES,
} from '../src/fixtures/index.js';

/** A deep, mutable copy of a fixture, so each mutation is independent. */
function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function paths(result: { ok: boolean; issues?: readonly { field: string }[] }): string[] {
  return result.ok || !result.issues ? [] : result.issues.map(i => i.field);
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('validateCoordinatorOrder — accepted', () => {
  it('accepts every order fixture', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      expect(validateCoordinatorOrder(order).ok, order.id).toBe(true);
    }
  });

  it('accepts an order with a populated operator preimage', () => {
    const withPreimage = mutable(ORDER_FLOW_1_SRC_LOCKED);
    withPreimage.secret.preimage = '0x' + 'ab'.repeat(32);
    expect(validateCoordinatorOrder(withPreimage).ok).toBe(true);
  });

  it('accepts an order carrying an unknown extra field', () => {
    // The wire contract is additive by design; a new coordinator field must
    // not break an SDK that predates it.
    const withExtra = mutable(ORDER_FLOW_1_SRC_LOCKED) as unknown as Record<string, unknown>;
    withExtra['newCoordinatorField'] = { anything: true };
    expect(validateCoordinatorOrder(withExtra).ok).toBe(true);
  });

  it('accepts a null reconciliation block on health', () => {
    const health = mutable(HEALTH_FIXTURES[0]!);
    health.reconciliation = null;
    expect(validateCoordinatorHealthResponse(health).ok).toBe(true);
  });

  it('accepts a health payload with no reconciliation key at all', () => {
    const health = mutable(HEALTH_FIXTURES[0]!) as unknown as Record<string, unknown>;
    delete health['reconciliation'];
    expect(validateCoordinatorHealthResponse(health).ok).toBe(true);
  });
});

// ── Structural rejection, field by field ────────────────────────────────────

describe('validateCoordinatorOrder — structural rejection', () => {
  const cases: Array<[string, (order: Record<string, unknown>) => void, string]> = [
    [
      'id missing',
      o => {
        delete o['id'];
      },
      'order.id',
    ],
    [
      'id not a canonical public order id',
      o => {
        o['id'] = 'order-1';
      },
      'order.id',
    ],
    [
      'direction not live',
      o => {
        o['direction'] = 'xlm_to_sol';
      },
      'order.direction',
    ],
    [
      'direction missing',
      o => {
        delete o['direction'];
      },
      'order.direction',
    ],
    [
      'status unknown to the SDK',
      o => {
        o['status'] = 'arbitrating';
      },
      'order.status',
    ],
    [
      'hashlock truncated',
      o => {
        o['hashlock'] = '0xabcd';
      },
      'order.hashlock',
    ],
    [
      'hashlock uppercased',
      o => {
        o['hashlock'] = ('0x' + 'AB'.repeat(32)) as string;
      },
      'order.hashlock',
    ],
    [
      'src not an object',
      o => {
        o['src'] = 'ethereum';
      },
      'order.src',
    ],
    [
      'src chain unknown',
      o => {
        (o['src'] as Record<string, unknown>)['chain'] = 'bitcoin';
      },
      'order.src.chain',
    ],
    [
      'src amount is a number rather than a decimal string',
      o => {
        (o['src'] as Record<string, unknown>)['amount'] = 1;
      },
      'order.src.amount',
    ],
    [
      'src amount is a float',
      o => {
        (o['src'] as Record<string, unknown>)['amount'] = '1.5';
      },
      'order.src.amount',
    ],
    [
      'orderId is undefined rather than null',
      o => {
        delete (o['src'] as Record<string, unknown>)['orderId'];
      },
      'order.src.orderId',
    ],
    [
      'lockTx is a Stellar hash on an Ethereum leg',
      o => {
        (o['src'] as Record<string, unknown>)['lockTx'] = 'cd'.repeat(32);
      },
      'order.src.lockTx',
    ],
    [
      'lockBlock is a string',
      o => {
        (o['src'] as Record<string, unknown>)['lockBlock'] = '21000000';
      },
      'order.src.lockBlock',
    ],
    [
      'timelock missing rather than null',
      o => {
        delete (o['src'] as Record<string, unknown>)['timelock'];
      },
      'order.src.timelock',
    ],
    [
      'safetyDeposit is a float',
      o => {
        (o['src'] as Record<string, unknown>)['safetyDeposit'] = '0.1';
      },
      'order.src.safetyDeposit',
    ],
    [
      'secret block missing',
      o => {
        delete o['secret'];
      },
      'order.secret',
    ],
    [
      'secret.revealed is a string',
      o => {
        (o['secret'] as Record<string, unknown>)['revealed'] = 'false';
      },
      'order.secret.revealed',
    ],
    [
      'secret.preimage is not hex',
      o => {
        (o['secret'] as Record<string, unknown>)['preimage'] = 'not-hex';
      },
      'order.secret.preimage',
    ],
    [
      'createdAt missing',
      o => {
        delete o['createdAt'];
      },
      'order.createdAt',
    ],
    [
      'createdAt is a float',
      o => {
        o['createdAt'] = 1.5;
      },
      'order.createdAt',
    ],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    it(`rejects an order whose ${name}`, () => {
      const order = mutable(ORDER_FLOW_1_SRC_LOCKED) as unknown as Record<string, unknown>;
      mutate(order);
      const result = validateCoordinatorOrder(order);
      expect(result.ok, `accepted; issues: ${JSON.stringify(paths(result))}`).toBe(false);
      expect(paths(result), name).toContain(expectedPath);
    });
  }

  it('rejects a non-object outright', () => {
    for (const value of [null, undefined, 'order', 42, [], true]) {
      expect(validateCoordinatorOrder(value).ok, `accepted ${String(value)}`).toBe(false);
    }
  });

  it('reports every bad field at once, not just the first', () => {
    const order = mutable(ORDER_FLOW_1_SRC_LOCKED) as unknown as Record<string, unknown>;
    delete order['id'];
    order['status'] = 'nonsense';
    (order['src'] as Record<string, unknown>)['amount'] = '1.5';
    (order['dst'] as Record<string, unknown>)['chain'] = 'bitcoin';
    const result = validateCoordinatorOrder(order);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const reported = result.issues.map(i => i.field);
    expect(reported).toContain('order.id');
    expect(reported).toContain('order.status');
    expect(reported).toContain('order.src.amount');
    expect(reported).toContain('order.dst.chain');
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Cross-field invariants ─────────────────────────────────────────────────

describe('validateCoordinatorOrder — cross-field invariants', () => {
  it('rejects a direction that disagrees with the leg chains', () => {
    const order = mutable(ORDER_FLOW_1_SRC_LOCKED);
    (order.src as unknown as Record<string, unknown>)['chain'] = 'solana';
    const result = validateCoordinatorOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result).some(p => p.startsWith('order.src.chain'))).toBe(true);
  });

  it("rejects a timelock that precedes the order's creation", () => {
    // A relative duration sent where an absolute timestamp is promised. The
    // order is otherwise perfectly well-formed, which is what makes this
    // worth an explicit check: the resulting order is permanently claimable.
    const order = mutable(ORDER_FLOW_1_SRC_LOCKED);
    (order.src as unknown as Record<string, unknown>)['timelock'] = order.createdAt - 1;
    const result = validateCoordinatorOrder(order);
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.issues.some(i => i.message.includes('absolute unix timestamp'))
    ).toBe(true);
  });

  it('accepts a timelock exactly equal to createdAt', () => {
    const order = mutable(ORDER_FLOW_1_SRC_LOCKED);
    (order.src as unknown as Record<string, unknown>)['timelock'] = order.createdAt;
    expect(validateCoordinatorOrder(order).ok).toBe(true);
  });
});

// ── Other response shapes ───────────────────────────────────────────────────

describe('history page guard', () => {
  it('accepts every page fixture', () => {
    for (const page of HISTORY_PAGE_FIXTURES) {
      expect(validateCoordinatorHistoryResponse(page).ok).toBe(true);
    }
  });

  it('accepts both pagination variants', () => {
    expect(
      validateCoordinatorHistoryResponse({
        transactions: [],
        pagination: { limit: 50, offset: 0, count: 0 },
      }).ok
    ).toBe(true);
    expect(
      validateCoordinatorHistoryResponse({
        transactions: [],
        pagination: { limit: 50, count: 0, nextCursor: null },
      }).ok
    ).toBe(true);
  });

  it('rejects a pagination block that is neither variant', () => {
    const result = validateCoordinatorHistoryResponse({
      transactions: [],
      pagination: { limit: 50, count: 0 },
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('page.pagination');
  });

  it('re-root the path of a bad order inside the page', () => {
    const page = mutable(HISTORY_PAGE_FIXTURES[0]!);
    (page.transactions[1] as unknown as Record<string, unknown>)['status'] = 'nonsense';
    const result = validateCoordinatorHistoryResponse(page);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('page.transactions[1].order.status');
  });

  it('rejects a non-array transactions field', () => {
    const result = validateCoordinatorHistoryResponse({
      transactions: {},
      pagination: { limit: 1 },
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('page.transactions');
  });
});

describe('secret response guard', () => {
  it('accepts the fixture', () => {
    expect(validateCoordinatorSecretResponse(SECRET_RESPONSE_FLOW_1).ok).toBe(true);
  });

  it('rejects a non-hex preimage', () => {
    const result = validateCoordinatorSecretResponse({
      publicId: SECRET_RESPONSE_FLOW_1.publicId,
      preimage: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('secret.preimage');
  });

  it('rejects a preimage of the wrong length', () => {
    const result = validateCoordinatorSecretResponse({
      publicId: SECRET_RESPONSE_FLOW_1.publicId,
      preimage: '0xabcd',
    });
    expect(result.ok).toBe(false);
  });
});

describe('health and readiness guards', () => {
  it('accepts every health and readiness fixture', () => {
    for (const health of HEALTH_FIXTURES) {
      expect(validateCoordinatorHealthResponse(health).ok).toBe(true);
    }
    for (const readiness of READINESS_FIXTURES) {
      expect(validateCoordinatorReadinessResponse(readiness).ok).toBe(true);
    }
  });

  it('rejects an unknown health status', () => {
    const health = mutable(HEALTH_FIXTURES[0]!);
    (health as unknown as Record<string, unknown>)['status'] = 'on fire';
    const result = validateCoordinatorHealthResponse(health);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('health.status');
  });

  it('rejects a non-boolean check result', () => {
    const readiness = mutable(READINESS_FIXTURES[0]!);
    (readiness.checks[0] as Record<string, unknown>)['ok'] = 'yes';
    const result = validateCoordinatorReadinessResponse(readiness);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('readyz.checks[0].ok');
  });

  it('rejects a non-array checks field', () => {
    expect(
      validateCoordinatorReadinessResponse({
        status: 'ok',
        service: 'c',
        version: '1',
        uptimeSeconds: 1,
        timestamp: 'now',
        checks: 'all good',
      }).ok
    ).toBe(false);
  });
});

describe('error envelopes', () => {
  it('every error envelope fixture is a well-formed envelope', () => {
    for (const envelope of ERROR_ENVELOPE_FIXTURES) {
      expect(typeof envelope.error).toBe('string');
      expect(typeof envelope.message).toBe('string');
    }
  });
});

// ── Assertion forms ─────────────────────────────────────────────────────────

describe('assert* forms', () => {
  it('return the narrowed value on success', () => {
    expect(assertCoordinatorOrder(ORDER_FLOW_1_SRC_LOCKED).id).toBe(ORDER_FLOW_1_SRC_LOCKED.id);
    expect(assertCoordinatorHistoryResponse(HISTORY_PAGE_FIXTURES[0]!).transactions).toHaveLength(
      3
    );
    expect(assertCoordinatorSecretResponse(SECRET_RESPONSE_FLOW_1).preimage).toBe(
      SECRET_RESPONSE_FLOW_1.preimage
    );
    expect(assertCoordinatorHealthResponse(HEALTH_FIXTURES[0]!).status).toBe('ok');
    expect(assertCoordinatorReadinessResponse(READINESS_FIXTURES[0]!).checks).toHaveLength(3);
  });

  it('throw a GuardError naming the label and the first failing field', () => {
    expect(() => assertCoordinatorOrder({ id: 'nope' })).toThrow(GuardError);
    try {
      assertCoordinatorOrder({ id: 'nope' });
    } catch (err) {
      expect((err as GuardError).message).toContain('coordinator order');
      expect((err as GuardError).issues[0]!.field).toBe('order.id');
    }
  });
});

// ── The canonical order payload ─────────────────────────────────────────────

describe('validateOrder — the canonical Order', () => {
  it('accepts every fixture order after the real transform', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      const canonical = asStrictOrder(toOrder(order));
      expect(validateOrder(canonical).ok, canonical.publicId).toBe(true);
    }
  });

  it('rejects a public id that does not embed its own hashlock', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.publicId = 'wf_0x' + 'ff'.repeat(32);
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.publicId');
  });

  it('rejects a leg with a lockTx but no orderId', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.src.orderId = null;
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.orderId');
  });

  it('rejects a leg with an orderId but no timelock', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.src.timelock = null;
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.timelock');
  });

  it('rejects an announced order that already claims a lock', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_ANNOUNCED)));
    (order.src as unknown as Record<string, unknown>)['orderId'] = '1';
    (order.src as unknown as Record<string, unknown>)['lockTx'] = '0x' + 'ab'.repeat(32);
    (order.src as unknown as Record<string, unknown>)['timelock'] = 1_800_003_600;
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.orderId');
  });

  it('rejects a completed order whose destination leg was never locked', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.status = 'completed';
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.dst.orderId');
  });

  it('rejects a refunded order whose destination leg was funded', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_2_REFUNDED)));
    order.dst.orderId = '99';
    order.dst.lockTx = '0x' + 'cd'.repeat(32);
    order.dst.timelock = order.src.timelock;
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.dst.orderId');
  });

  it('rejects a refunded order that was never funded on the source leg', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_ANNOUNCED)));
    order.status = 'refunded';
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.status');
  });

  it('rejects a preimage on an order that has not revealed one yet', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.preimage = '0x' + 'ab'.repeat(32);
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.preimage');
  });

  it('rejects an amount with redundant leading zeros', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.src.amount = '000123';
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.amount');
  });

  it('rejects an uppercased hashlock', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.hashlock = ('0x' + 'AB'.repeat(32)) as `0x${string}`;
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.hashlock');
  });

  it('rejects a missing safetyDeposit — the field is required and nullable', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    delete (order.src as unknown as Record<string, unknown>)['safetyDeposit'];
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.safetyDeposit');
  });

  it('rejects an empty-string orderId, which is "not locked" written wrongly', () => {
    const order = mutable(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    order.src.orderId = '';
    const result = validateOrder(order);
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain('order.src.orderId');
  });

  it('rejects a non-object', () => {
    for (const value of [null, undefined, 'order', 42, []]) {
      expect(validateOrder(value).ok).toBe(false);
    }
  });

  it('assertOrder returns a StrictOrder and throws otherwise', () => {
    const strict = assertOrder(asStrictOrder(toOrder(ORDER_FLOW_1_SRC_LOCKED)));
    expect(strict.src.safetyDeposit).toBe('1000000000000000');
    expect(() => assertOrder({ publicId: 'x' })).toThrow(GuardError);
  });
});

// ── The equivalence claim ───────────────────────────────────────────────────

describe('equivalence with the existing pipeline', () => {
  it('guards then transform produces exactly what transform alone produces', () => {
    // The claim behind replacing `parsed as T` + two `as \`0x${string}\``
    // casts: the guard changes nothing for a well-formed order. If this
    // fails, the guard is rejecting something production accepts, which is
    // an outage rather than a safety improvement.
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      const direct = toOrder(order);
      const guarded = toOrder(assertCoordinatorOrder(order));
      expect(guarded).toEqual(direct);
    }
  });

  it('the guard rejects an order toOrder would have silently mis-narrowed', () => {
    const broken = mutable(ORDER_FLOW_1_SRC_LOCKED) as unknown as Record<string, unknown>;
    (broken['src'] as Record<string, unknown>)['lockTx'] = 'not-a-tx-hash-at-all';
    // `toOrder` has no opinion about this: it copies the string across, and
    // the `as \`0x${string}\`` cast on the hashlock launders the rest.
    expect(() => toOrder(broken as never)).not.toThrow();
    expect(validateCoordinatorOrder(broken).ok).toBe(false);
  });

  it('KNOWN_ORDER_STATUSES matches the SDK union exactly', () => {
    // The guard declares its own runtime list; this ties it to the type so a
    // new status is a test failure in exactly one place.
    const expected = [
      'announced',
      'src_locked',
      'dst_locked',
      'secret_revealed',
      'completed',
      'refunded',
      'failed',
      'expired',
      'cancelled',
      'abandoned',
    ] as const;
    expect([...KNOWN_ORDER_STATUSES].sort()).toEqual([...expected].sort());
  });
});
