/**
 * Settlement status and manual recovery routes.
 *
 * GET  /api/settlement/status
 *   Returns a snapshot of all settlement records and per-state counts.
 *   Useful for operator dashboards and monitoring.
 *
 * GET  /api/settlement/status/:orderId
 *   Returns the settlement record for a specific order.
 *
 * POST /api/settlement/recover/:orderId
 *   Manually trigger reconciliation for a specific order.
 *   Body: { coordinatorRef?: string }  (optional — advance to coordinator_recorded)
 *
 * POST /api/settlement/reconcile
 *   Trigger a full reconciliation sweep (all non-terminal records).
 *   Body: { trigger?: 'manual' }
 *
 * All write endpoints are gated behind requireAdminAuth() in production.
 */

import { Router, type Request, type Response } from 'express';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import {
  SettlementService,
  SettlementError,
} from '../services/settlement-service.js';
import { TxStateStore, TxStateError } from '../services/tx-state-store.js';
import { settlementRecoveryTotal } from '../metrics.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function settlementRouter(
  service: SettlementService,
): Router {
  const router = Router();
  const isProduction = process.env.NODE_ENV === 'production';

  // ── GET /api/settlement/status ──────────────────────────────────────────
  router.get('/api/settlement/status', (req: Request, res: Response) => {
    const counts = service.stateCounts();
    const records = service.snapshot().map((r) => ({
      orderId: r.orderId,
      correlationId: r.correlationId,
      route: r.route,
      state: r.state,
      txHash: r.txHash,
      minedBlock: r.minedBlock,
      failureReason: r.failureReason,
      recoveryAttempts: r.recoveryAttempts,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      transitionCount: r.transitions.length,
    }));

    res.json({
      counts,
      total: records.length,
      records,
    });
  });

  // ── GET /api/settlement/status/:orderId ─────────────────────────────────
  router.get('/api/settlement/status/:orderId', (req: Request, res: Response) => {
    const { orderId } = req.params;
    const record = service.getStatus(orderId);
    if (!record) {
      return res.status(404).json({
        error: 'Settlement record not found',
        orderId,
      });
    }
    return res.json({ record });
  });

  // ── POST /api/settlement/recover/:orderId ───────────────────────────────
  // Conditionally gated behind admin auth in production.
  const recoverHandler = async (req: Request, res: Response) => {
    const { orderId } = req.params;
    const { coordinatorRef: rawCoordinatorRef } = req.body ?? {};
    const coordinatorRef = typeof rawCoordinatorRef === 'string' ? rawCoordinatorRef.trim() : rawCoordinatorRef;

    const record = service.getStatus(orderId);
    if (!record) {
      return res.status(404).json({ error: 'Settlement record not found', orderId });
    }

    if (record.state === 'complete') {
      return res.json({
        success: true,
        orderId,
        state: record.state,
        message: 'Order is already complete — no recovery needed.',
      });
    }

    if (record.state === 'terminal_failure') {
      return res.status(409).json({
        error: 'Order is in terminal_failure state and cannot be automatically recovered.',
        orderId,
        failureReason: record.failureReason,
        suggestion:
          'Review the failure reason. If it was a transient outage you may create a new order.',
      });
    }

    // If coordinator ref is provided, advance from chain_mined → coordinator_recorded.
    if (coordinatorRef && record.state === 'chain_mined') {
      try {
        service.recordCoordinatorAck(orderId, coordinatorRef);
        settlementRecoveryTotal.inc({ direction: record.route, trigger: 'manual' });
        const updated = service.getStatus(orderId);
        return res.json({
          success: true,
          orderId,
          previousState: record.state,
          newState: updated?.state,
          coordinatorRef,
        });
      } catch (err) {
        return res.status(500).json({
          error: 'Failed to advance coordinator ack',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Run reconciliation for just this order via the full reconcile sweep.
    try {
      const summary = await service.reconcile(null, 'manual', record.route);
      settlementRecoveryTotal.inc({ direction: record.route, trigger: 'manual' });
      const updated = service.getStatus(orderId);
      return res.json({
        success: true,
        orderId,
        previousState: record.state,
        newState: updated?.state,
        reconcileSummary: summary,
      });
    } catch (err) {
      return res.status(500).json({
        error: 'Recovery failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (isProduction) {
    router.post('/api/settlement/recover/:orderId', requireAdminAuth(), recoverHandler);
  } else {
    router.post('/api/settlement/recover/:orderId', recoverHandler);
  }

  // ── POST /api/settlement/reconcile ──────────────────────────────────────
  const reconcileHandler = async (req: Request, res: Response) => {
    const trigger = req.body?.trigger === 'startup' ? 'startup' : 'manual';
    try {
      const summary = await service.reconcile(null, trigger);
      settlementRecoveryTotal.inc({ direction: 'all', trigger });
      return res.json({ success: true, summary });
    } catch (err) {
      return res.status(500).json({
        error: 'Reconciliation failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (isProduction) {
    router.post('/api/settlement/reconcile', requireAdminAuth(), reconcileHandler);
  } else {
    router.post('/api/settlement/reconcile', reconcileHandler);
  }

  return router;
}
