import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { registry, recordListenerProgress, resolverLockActionsTotal } from "../src/metrics.js";
import {
  ALLOWED_LABELS,
  auditMetricLabels,
  formatViolations,
  MAX_LABELS_PER_METRIC,
} from "../../scripts/validate-metric-labels.mjs";

const tempRoots: string[] = [];
afterAll(() => tempRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("metric label budget", () => {
  it("accepts the current coordinator, relayer and resolver label inventory", () => {
    const violations = auditMetricLabels();
    expect(formatViolations(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  it("rejects an identifier label and names the offending metric", () => {
    const root = mkdtempSync(join(tmpdir(), "metric-labels-"));
    tempRoots.push(root);
    mkdirSync(join(root, "coordinator/src"), { recursive: true });
    writeFileSync(
      join(root, "coordinator/src/metrics.ts"),
      `new Counter({ name: "coordinator_bad_metric", labelNames: ["order_id"] })`
    );

    const violations = auditMetricLabels(root).filter((v) => v.metric === "coordinator_bad_metric");
    expect(violations.length).toBeGreaterThan(0);
    expect(formatViolations(violations)).toContain("coordinator_bad_metric");
    expect(formatViolations(violations)).toContain("order_id");
  });

  it("exposes only allowed label names and bounded sample counts", async () => {
    registry.resetMetrics();
    recordListenerProgress("ethereum", 120, 125);
    resolverLockActionsTotal.inc({ action: "dst_lock" });

    const samples = new Map<string, number>();
    for (const line of (await registry.metrics()).split("\n")) {
      if (!line.startsWith("coordinator_")) continue;
      const name = line.slice(0, line.indexOf("{") === -1 ? line.indexOf(" ") : line.indexOf("{"));
      if (!name.startsWith("coordinator_")) continue;
      const labelBlock = line.match(/\{([^}]*)\}/)?.[1];
      if (labelBlock) {
        for (const pair of labelBlock.split(",")) {
          const label = pair.trim().split("=")[0];
          if (label && !label.startsWith("le")) {
            expect(ALLOWED_LABELS.has(label), `metric ${name} exposes forbidden label ${label}`).toBe(true);
          }
        }
      }
      const base = name.replace(/_(bucket|sum|count)$/, "");
      samples.set(base, (samples.get(base) ?? 0) + 1);
    }
    expect(samples.size).toBeGreaterThan(0);
    for (const [metric, count] of samples) {
      expect(count, `${metric} exceeded the sample budget`).toBeLessThanOrEqual(200);
      expect(MAX_LABELS_PER_METRIC).toBe(4);
    }
  });
});
