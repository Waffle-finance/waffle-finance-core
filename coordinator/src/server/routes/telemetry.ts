import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import { makeRateLimiter, loadApiKeys, loadTrustedProxies } from "../middleware/ratelimit.js";
import type { AbuseDetector } from "../middleware/abuse-detection.js";
import { validationError } from "../errors.js";

const telemetrySchema = z.object({
  orderId: z.string().optional(),
  direction: z.string(),
  step: z.string(),
  walletType: z.enum(['metamask', 'freighter', 'unknown']),
  failureType: z.enum(['wallet_rejection', 'network_failure', 'contract_rejection', 'unknown']),
  errorCode: z.union([z.string(), z.number()]).optional(),
  errorMessage: z.string(),
  state: z.record(z.any()).optional()
});

export function telemetryRoutes(log: Logger, abuseDetector?: AbuseDetector): Router {
  const router = Router();

  const apiKeys = loadApiKeys();
  const trustedProxies = loadTrustedProxies();

  const telemetryRateLimit = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    name: "telemetry",
    log,
    apiKeys,
    trustedProxies,
    abuseDetector
  });

  router.post("/telemetry", telemetryRateLimit, async (req, res, next) => {
    try {
      const body = telemetrySchema.parse(req.body);

      // Log the telemetry event.
      // wallet_rejection is a user-level cancel, log as warn.
      // others are system/blockchain errors, log as error.
      const logFn = body.failureType === 'wallet_rejection' ? log.warn.bind(log) : log.error.bind(log);
      logFn(
        {
          telemetry: {
            orderId: body.orderId,
            direction: body.direction,
            step: body.step,
            walletType: body.walletType,
            failureType: body.failureType,
            errorCode: body.errorCode,
            errorMessage: body.errorMessage,
            state: body.state
          }
        },
        `Transaction submission failed: ${body.failureType} at ${body.step}`
      );

      res.status(202).json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  return router;
}
