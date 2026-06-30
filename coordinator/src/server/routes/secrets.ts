import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { SecretService } from "../../services/secret-service.js";
import { SecretRevealError } from "../../services/secret-errors.js";
import { makeRateLimiter, loadApiKeys, loadTrustedProxies } from "../middleware/ratelimit.js";
import type { AbuseDetector } from "../middleware/abuse-detection.js";
import { validationError, notRevealedError } from "../errors.js";

export function secretsRoutes(secrets: SecretService, log?: Logger, abuseDetector?: AbuseDetector): Router {
  const router = Router();

  const apiKeys = loadApiKeys();
  const trustedProxies = loadTrustedProxies();

  // Secret reveal is high-value: stricter window (5 reveals per IP per minute).
  // Resolvers presenting a valid API key bypass this limit entirely.
  const revealRateLimit = makeRateLimiter({
    windowMs: 60_000,
    max: 5,
    name: "secrets/reveal",
    log,
    apiKeys,
    trustedProxies,
    abuseDetector
  });

  // Secret GET endpoint: 30 reads per IP per minute (lenient — it's a public read).
  const getSecretRateLimit = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    name: "secrets/get",
    log,
    apiKeys,
    trustedProxies,
    abuseDetector
  });

  const revealSchema = z.object({
    publicId: z.string().min(1),
    preimage: z.string().regex(/^0x[0-9a-fA-F]+$/),
    txHash: z.string().min(1)
  });

  router.post("/secrets/reveal", revealRateLimit, async (req, res, next) => {
    try {
      const body = revealSchema.parse(req.body);
      await secrets.reveal(body.publicId, body.preimage, body.txHash);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      // Classified reveal failures map to distinct status codes and stable
      // `error` codes so clients can decide whether to retry or abandon.
      // The error messages are pre-sanitized in SecretService and never
      // contain secret material.
      if (err instanceof SecretRevealError) {
        res.status(err.httpStatus).json({
          error: err.code,
          message: err.message,
          retryable: err.retryable
        });
        return;
      }
      next(err);
    }
  });

  router.get("/secrets/:publicId", getSecretRateLimit, async (req, res, next) => {
    try {
      const publicId = req.params["publicId"] ?? "";
      const preimage = await secrets.get(publicId);
      if (!preimage) {
        res.status(404).json(notRevealedError());
        return;
      }
      res.json({ publicId, preimage });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
