import { Router } from "express";
import type { QuoteService } from "../../services/quote-service.js";
import type { Logger } from "pino";
import { classifiedExpensiveRouteLimiter } from "../middleware/expensive-route-limits.js";

/**
 * Quote routes.
 *
 * GET /api/quotes/eth-xlm  — ETH/XLM exchange rate (SWR-cached)
 * GET /api/quotes/eth-sol  — ETH/SOL exchange rate (SWR-cached)
 * GET /api/prices          — Aggregated price feed consumed by the frontend;
 *                            combines both pairs into a single response so
 *                            the BridgeForm can fetch one endpoint.
 */
export function quotesRoutes(quotes: QuoteService, log?: Logger): Router {
  const router = Router();

  // Quotes are expensive (price fetch + calculation): separate anonymous and
  // authenticated policies, with an audited bypass for configured identities.
  router.use(classifiedExpensiveRouteLimiter("quotes", { log }));

  /**
   * ETH/XLM quote.
   *
   * Response shape:
   *   {
   *     ethUsd:     string | null,   // USD price of 1 ETH
   *     xlmUsd:     string | null,   // USD price of 1 XLM
   *     source:     "coingecko" | "cache" | "fallback",
   *     staleness:  "fresh" | "stale" | "fallback",
   *     fetchedAt:  number,          // unix ms when data was last fetched
   *     ageMs:      number           // milliseconds since fetchedAt
   *   }
   */
  router.get("/quotes/eth-xlm", async (_req, res, next) => {
    try {
      const snap = await quotes.getQuote("ETH-XLM");
      res.json({
        ethUsd: snap.srcUsd !== null ? String(snap.srcUsd) : null,
        xlmUsd: snap.dstUsd !== null ? String(snap.dstUsd) : null,
        rate: snap.rate,
        source: snap.source,
        staleness: snap.staleness,
        fetchedAt: snap.fetchedAt,
        ageMs: snap.ageMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * ETH/SOL quote.
   *
   * Response shape mirrors /quotes/eth-xlm but for the SOL leg.
   */
  router.get("/quotes/eth-sol", async (_req, res, next) => {
    try {
      const snap = await quotes.getQuote("ETH-SOL");
      res.json({
        ethUsd: snap.srcUsd !== null ? String(snap.srcUsd) : null,
        solUsd: snap.dstUsd !== null ? String(snap.dstUsd) : null,
        rate: snap.rate,
        source: snap.source,
        staleness: snap.staleness,
        fetchedAt: snap.fetchedAt,
        ageMs: snap.ageMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Aggregated price endpoint consumed by the BridgeForm frontend component.
   *
   * Fetches ETH-XLM and ETH-SOL concurrently and merges them into the shape
   * the frontend expects.  The `staleness` field in the response is the
   * worst staleness across all pairs — if any pair is stale/fallback, the
   * UI should show a "prices may be stale" indicator.
   *
   * Response shape:
   *   {
   *     ethUsd:     number,
   *     xlmUsd:     number,
   *     solUsd:     number,
   *     xlmPerEth:  number,
   *     ethPerXlm:  number,
   *     source:     "coingecko" | "cache" | "fallback",
   *     staleness:  "fresh" | "stale" | "fallback",
   *     fetchedAt:  number,
   *     ageMs:      number
   *   }
   */
  router.get("/prices", async (_req, res, next) => {
    try {
      const [ethXlm, ethSol] = await Promise.all([
        quotes.getQuote("ETH-XLM"),
        quotes.getQuote("ETH-SOL"),
      ]);

      // Coerce nulls to fallback constants so the frontend always gets numbers
      // it can render without crashing. The `staleness` field is the honest
      // signal for the UI to decide whether to show a warning.
      const ethUsd = ethXlm.srcUsd ?? 3_500;
      const xlmUsd = ethXlm.dstUsd ?? 0.12;
      const solUsd = ethSol.dstUsd ?? 150;

      // Worst-staleness wins for the aggregate source/staleness fields.
      const STALENESS_RANK = { fresh: 0, stale: 1, fallback: 2 } as const;
      const worstStaleness =
        STALENESS_RANK[ethXlm.staleness] >= STALENESS_RANK[ethSol.staleness]
          ? ethXlm.staleness
          : ethSol.staleness;

      const worstSource =
        ethXlm.source === "fallback" || ethSol.source === "fallback"
          ? "fallback"
          : ethXlm.source === "cache" || ethSol.source === "cache"
          ? "cache"
          : "coingecko";

      const oldestFetchedAt = Math.min(ethXlm.fetchedAt, ethSol.fetchedAt);

      res.json({
        ethUsd,
        xlmUsd,
        solUsd,
        xlmPerEth: xlmUsd > 0 ? ethUsd / xlmUsd : null,
        ethPerXlm: ethUsd > 0 ? xlmUsd / ethUsd : null,
        source: worstSource,
        staleness: worstStaleness,
        fetchedAt: oldestFetchedAt,
        ageMs: Date.now() - oldestFetchedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
