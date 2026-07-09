import { Router } from "express";
import type { Request, Response } from "express";
import { registry } from "../metrics.js";

export function metricsRouter(): Router {
  const router = Router();

  router.get("/metrics", async (_req: Request, res: Response) => {
    try {
      const output = await registry.metrics();
      res.set("Content-Type", registry.contentType);
      res.end(output);
    } catch (err: unknown) {
      res.status(500).end(
        `# Error collecting metrics\n# ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  });

  return router;
}
