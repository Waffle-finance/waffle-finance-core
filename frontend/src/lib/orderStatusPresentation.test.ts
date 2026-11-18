import { describe, it, expect } from 'vitest';
import {
  presentOrderStatus,
  presentCoordinatorPhase,
  translateCoordinatorState,
  type OrderStatus,
  type UxPhase,
} from './orderStatusPresentation';

// ── presentOrderStatus — coverage of all defined statuses ────────────────────

const ALL_STATUSES: OrderStatus[] = [
  'pending', 'completed', 'confirmed', 'cancelled', 'failed', 'refunded', 'expired', 'timed_out',
];

describe('presentOrderStatus — completeness', () => {
  it('returns a presentation for every defined OrderStatus', () => {
    for (const status of ALL_STATUSES) {
      const p = presentOrderStatus(status);
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.colorClass).toBeTruthy();
      expect(p.iconName).toBeTruthy();
    }
  });
});

// ── Terminal / non-terminal flags ─────────────────────────────────────────────

describe('presentOrderStatus — terminal states', () => {
  const terminal: OrderStatus[] = ['completed', 'confirmed', 'cancelled', 'failed', 'refunded', 'expired', 'timed_out'];
  const nonTerminal: OrderStatus[] = ['pending'];

  it.each(terminal)('"%s" is terminal', (status) => {
    expect(presentOrderStatus(status).isTerminal).toBe(true);
  });

  it.each(nonTerminal)('"%s" is not terminal', (status) => {
    expect(presentOrderStatus(status).isTerminal).toBe(false);
  });
});

// ── UX phase mapping ──────────────────────────────────────────────────────────

describe('presentOrderStatus — UX phase mapping', () => {
  const cases: Array<[OrderStatus, UxPhase]> = [
    ['pending',    'initiated'],
    ['completed',  'completed'],
    ['confirmed',  'completed'],
    ['cancelled',  'failed'],
    ['failed',     'failed'],
    ['refunded',   'refunded'],
    ['expired',    'expired'],
    ['timed_out',  'expired'],
  ];

  it.each(cases)('"%s" maps to phase "%s"', (status, expectedPhase) => {
    expect(presentOrderStatus(status).phase).toBe(expectedPhase);
  });
});

// ── Recovery messages ─────────────────────────────────────────────────────────

describe('presentOrderStatus — recovery messages', () => {
  it('provides a recovery message for "failed" status', () => {
    const p = presentOrderStatus('failed');
    expect(p.recoveryMessage).toMatch(/refund/i);
  });

  it('provides a recovery message for "expired" status', () => {
    const p = presentOrderStatus('expired');
    expect(p.recoveryMessage).toMatch(/refund/i);
  });

  it('provides a recovery message for "timed_out" status', () => {
    const p = presentOrderStatus('timed_out');
    expect(p.recoveryMessage).toMatch(/refund/i);
  });

  it('does not provide a recovery message for terminal success states', () => {
    expect(presentOrderStatus('completed').recoveryMessage).toBeUndefined();
    expect(presentOrderStatus('confirmed').recoveryMessage).toBeUndefined();
    expect(presentOrderStatus('refunded').recoveryMessage).toBeUndefined();
  });

  it('does not provide a recovery message for "cancelled" (user-initiated)', () => {
    expect(presentOrderStatus('cancelled').recoveryMessage).toBeUndefined();
  });

  it('does not provide a recovery message for "pending" (no action needed yet)', () => {
    expect(presentOrderStatus('pending').recoveryMessage).toBeUndefined();
  });
});

// ── Colour classes ────────────────────────────────────────────────────────────

describe('presentOrderStatus — colour classes', () => {
  it('success statuses use green colour class', () => {
    expect(presentOrderStatus('completed').colorClass).toContain('green');
    expect(presentOrderStatus('confirmed').colorClass).toContain('green');
  });

  it('pending status uses yellow colour class', () => {
    expect(presentOrderStatus('pending').colorClass).toContain('yellow');
  });

  it('failure statuses use red colour class', () => {
    expect(presentOrderStatus('failed').colorClass).toContain('red');
  });

  it('cancelled status uses grey colour class', () => {
    expect(presentOrderStatus('cancelled').colorClass).toContain('gray');
  });

  it('refunded status uses emerald colour class', () => {
    expect(presentOrderStatus('refunded').colorClass).toContain('emerald');
  });

  it('expired/timed_out use orange colour class', () => {
    expect(presentOrderStatus('expired').colorClass).toContain('orange');
    expect(presentOrderStatus('timed_out').colorClass).toContain('orange');
  });
});

// ── Labels ────────────────────────────────────────────────────────────────────

describe('presentOrderStatus — label text', () => {
  it('"timed_out" label is human-readable "Timed out"', () => {
    expect(presentOrderStatus('timed_out').label).toBe('Timed out');
  });

  it('"confirmed" label is "Confirmed" not "Completed"', () => {
    expect(presentOrderStatus('confirmed').label).toBe('Confirmed');
  });

  it('"completed" label is "Completed"', () => {
    expect(presentOrderStatus('completed').label).toBe('Completed');
  });
});

// ── Descriptions contain meaningful content ───────────────────────────────────

describe('presentOrderStatus — description quality', () => {
  it('pending description mentions on-chain confirmation', () => {
    expect(presentOrderStatus('pending').description).toMatch(/on-chain|confirmation/i);
  });

  it('expired description mentions timelock', () => {
    expect(presentOrderStatus('expired').description).toMatch(/timelock/i);
  });

  it('timed_out description mentions coordinator and refund', () => {
    const p = presentOrderStatus('timed_out');
    expect(p.description).toMatch(/coordinator|timelock/i);
  });

  it('failed description mentions locked funds or refund', () => {
    const p = presentOrderStatus('failed');
    expect(p.description).toMatch(/locked|refund/i);
  });

  it('completed description mentions destination funds or wallet', () => {
    const p = presentOrderStatus('completed');
    expect(p.description).toMatch(/wallet|settled|destination/i);
  });

  it('cancelled description mentions no funds locked', () => {
    const p = presentOrderStatus('cancelled');
    expect(p.description).toMatch(/cancel|locked/i);
  });
});

// ── translateCoordinatorState ─────────────────────────────────────────────────

describe('translateCoordinatorState', () => {
  const coordinatorMapping: Array<[string, OrderStatus]> = [
    ['announced',       'pending'],
    ['src_locked',      'pending'],
    ['dst_locked',      'confirmed'],
    ['secret_revealed', 'confirmed'],
    ['claim_pending',   'pending'],
    ['processing',      'pending'],
    ['completed',       'completed'],
    ['confirmed',       'confirmed'],
    ['cancelled',       'cancelled'],
    ['failed',          'failed'],
    ['expired',         'expired'],
    ['timed_out',       'timed_out'],
    ['refunded',        'refunded'],
    ['pending',         'pending'],
    ['abandoned',       'cancelled'],
  ];

  it.each(coordinatorMapping)(
    'maps coordinator state "%s" to OrderStatus "%s"',
    (raw, expected) => {
      expect(translateCoordinatorState(raw)).toBe(expected);
    },
  );

  it('defaults to "pending" for unknown coordinator states', () => {
    expect(translateCoordinatorState('totally_unknown_state')).toBe('pending');
    expect(translateCoordinatorState('dst_settled')).toBe('pending');
  });

  it('handles empty string safely', () => {
    expect(translateCoordinatorState('')).toBe('pending');
  });

  it('is case-insensitive', () => {
    expect(translateCoordinatorState('COMPLETED')).toBe('completed');
    expect(translateCoordinatorState('Src_Locked')).toBe('pending');
  });
});

// ── presentCoordinatorPhase — granular per-state messaging ────────────────────

describe('presentCoordinatorPhase — stepLabel completeness', () => {
  const states = [
    'announced',
    'src_locked',
    'dst_locked',
    'secret_revealed',
    'claim_pending',
    'processing',
    'completed',
    'confirmed',
    'cancelled',
    'abandoned',
    'failed',
    'expired',
    'timed_out',
    'refunded',
  ];

  it.each(states)('returns a non-empty stepLabel for "%s"', (state) => {
    const p = presentCoordinatorPhase(state);
    expect(p.stepLabel).toBeTruthy();
    expect(p.stepDescription).toBeTruthy();
  });
});

describe('presentCoordinatorPhase — stepDescription content', () => {
  it('"announced" tells user to lock source funds', () => {
    const p = presentCoordinatorPhase('announced');
    expect(p.stepDescription).toMatch(/lock|funds|source/i);
    expect(p.userAction).toMatch(/lock/i);
  });

  it('"src_locked" says source funds are locked', () => {
    const p = presentCoordinatorPhase('src_locked');
    expect(p.stepDescription).toMatch(/locked|source/i);
    expect(p.userAction).toBe('');
  });

  it('"dst_locked" mentions destination funds locked', () => {
    const p = presentCoordinatorPhase('dst_locked');
    expect(p.stepDescription).toMatch(/destination|locked/i);
    expect(p.userAction).toBe('');
  });

  it('"secret_revealed" mentions preimage', () => {
    const p = presentCoordinatorPhase('secret_revealed');
    expect(p.stepDescription).toMatch(/preimage/i);
    expect(p.userAction).toBe('');
  });

  it('"claim_pending" mentions claim transaction', () => {
    const p = presentCoordinatorPhase('claim_pending');
    expect(p.stepDescription).toMatch(/claim/i);
    expect(p.userAction).toBe('');
  });

  it('"failed" provides a userAction pointing to refund', () => {
    const p = presentCoordinatorPhase('failed');
    expect(p.userAction).toMatch(/refund/i);
  });

  it('"expired" provides a userAction pointing to refund', () => {
    const p = presentCoordinatorPhase('expired');
    expect(p.userAction).toMatch(/refund/i);
  });

  it('"timed_out" provides a userAction pointing to refund', () => {
    const p = presentCoordinatorPhase('timed_out');
    expect(p.userAction).toMatch(/refund/i);
  });

  it('terminal success states have empty userAction', () => {
    expect(presentCoordinatorPhase('completed').userAction).toBe('');
    expect(presentCoordinatorPhase('confirmed').userAction).toBe('');
    expect(presentCoordinatorPhase('refunded').userAction).toBe('');
    expect(presentCoordinatorPhase('cancelled').userAction).toBe('');
  });

  it('returns a sensible fallback for unknown states', () => {
    const p = presentCoordinatorPhase('some_future_state');
    expect(p.stepLabel).toBeTruthy();
    expect(p.stepDescription).toBeTruthy();
  });
});

// ── Degraded / partial data resilience ───────────────────────────────────────

describe('presentOrderStatus — degraded data resilience', () => {
  it('does not throw when called with a cast unknown status', () => {
    const unknownStatus = 'some_future_state' as OrderStatus;
    expect(() => presentOrderStatus(unknownStatus)).not.toThrow();
  });

  it('returns a coherent presentation for an unknown status', () => {
    const p = presentOrderStatus('some_future_state' as OrderStatus);
    expect(p.label).toBe('Unknown');
    expect(p.isTerminal).toBe(false);
    expect(p.phase).toBe('initiated');
  });
});
