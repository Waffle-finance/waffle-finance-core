/**
 * Route-specific payload size limits for the coordinator API.
 *
 * Design rationale
 * ----------------
 * The global `express.json({ limit: "1mb" })` in app.ts is a last-resort
 * safety net. Each write endpoint that accepts user-supplied JSON gets its
 * own, tighter limit enforced *before* the JSON parser runs — so an oversized
 * body never consumes memory, never reaches validation, and never touches
 * persistence or logs.
 *
 * Limits are expressed as bytes and documented here as the single source of
 * truth.  Tests import these constants directly so the documented values and
 * the enforced values cannot drift.
 *
 * Limit rationale per route
 * -------------------------
 * announce      – largest realistic payload:  12 fields × ~100 chars each
 *                 ≈ 1.2 KB.  We allow 8 KB so edge-case long Stellar/Solana
 *                 addresses and human error have room, while still being two
 *                 orders of magnitude below the 1 MB global cap.
 *
 * secrets/reveal – three fields (publicId, preimage, txHash), all bounded:
 *                 publicId ≤ 100 chars, preimage ≤ 132 chars, txHash ≤ 132 chars.
 *                 2 KB is generous.
 *
 * src-locked /
 * dst-locked    – four/five fields (orderId, txHash, blockNumber, timelock,
 *                 optional resolver).  2 KB is ample.
 *
 * import        – not currently a public endpoint; placeholder at 16 KB for
 *                 future batch import use.
 */

import type { Request, Response, NextFunction } from "express";

// ── Documented limits (bytes) ─────────────────────────────────────────────────

export const PAYLOAD_LIMITS = {
  /** POST /api/orders/announce */
  announce: 8_192,
  /** POST /api/secrets/reveal */
  secretReveal: 2_048,
  /** POST /api/orders/:id/src-locked */
  srcLocked: 2_048,
  /** POST /api/orders/:id/dst-locked */
  dstLocked: 2_048,
  /** Reserved for future POST /api/orders/import */
  orderImport: 16_384,
} as const satisfies Record<string, number>;

export type PayloadLimitRoute = keyof typeof PAYLOAD_LIMITS;

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that rejects requests whose `Content-Length`
 * header or actual body exceeds `limitBytes` with HTTP 413 before any JSON
 * parsing occurs.
 *
 * Two-stage enforcement:
 *  1. Content-Length header check — fast path, zero body read.
 *  2. Streaming byte counter — catches chunked transfers that omit the
 *     Content-Length header.
 *
 * The 413 response body follows the standard API error envelope so clients
 * can handle it the same way as validation failures.
 */
export function payloadLimit(limitBytes: number, routeName: PayloadLimitRoute) {
  return function checkPayloadSize(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // ── Stage 1: Content-Length fast path ─────────────────────────────────
    const declared = req.headers["content-length"];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isFinite(length) || length > limitBytes) {
        res.status(413).json({
          error: "payload_too_large",
          message: `Request body exceeds the ${limitBytes}-byte limit for ${routeName}`,
        });
        return;
      }
    }

    // ── Stage 2: Streaming byte counter ───────────────────────────────────
    let received = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > limitBytes) {
        rejected = true;
        // Destroy the socket cleanly so the client gets a reset rather than
        // a half-parsed response body.
        req.destroy();
        if (!res.headersSent) {
          res.status(413).json({
            error: "payload_too_large",
            message: `Request body exceeds the ${limitBytes}-byte limit for ${routeName}`,
          });
        }
      }
    });

    next();
  };
}

/**
 * Pre-built middleware instances for each documented route.
 *
 * Usage:
 *   router.post("/orders/announce", LIMITS.announce, announceRateLimit, handler);
 */
export const LIMITS = {
  announce: payloadLimit(PAYLOAD_LIMITS.announce, "announce"),
  secretReveal: payloadLimit(PAYLOAD_LIMITS.secretReveal, "secretReveal"),
  srcLocked: payloadLimit(PAYLOAD_LIMITS.srcLocked, "srcLocked"),
  dstLocked: payloadLimit(PAYLOAD_LIMITS.dstLocked, "dstLocked"),
  orderImport: payloadLimit(PAYLOAD_LIMITS.orderImport, "orderImport"),
} as const;
