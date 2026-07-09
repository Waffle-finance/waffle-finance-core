import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/metrics.js";

beforeEach(() => {
  registry.resetMetrics();
});

describe("resolver metrics", () => {
  it("registers all expected metrics", async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_events_total");
    expect(metrics).toContain("resolver_listener_errors_total");
    expect(metrics).toContain("resolver_listener_poll_duration_seconds");
    expect(metrics).toContain("resolver_listener_poll_runs_total");
    expect(metrics).toContain("resolver_listener_last_event_timestamp_seconds");
    expect(metrics).toContain("resolver_active_listeners");
    expect(metrics).toContain("resolver_registration_info");
    expect(metrics).toContain("resolver_registration_changes_total");
    expect(metrics).toContain("resolver_start_time_seconds");
    expect(metrics).toContain("resolver_orders_processed_total");
    expect(metrics).toContain("resolver_claim_attempts_total");
    expect(metrics).toContain("resolver_refund_attempts_total");
    expect(metrics).toContain("resolver_retry_attempts_total");
    expect(metrics).toContain("resolver_operation_duration_seconds");
    expect(metrics).toContain("resolver_operation_failures_total");
    expect(metrics).toContain("resolver_active_operations");
  });

  it("increments events_total counter", async () => {
    const { eventsTotal } = await import("../src/metrics.js");
    eventsTotal.inc({ chain: "ethereum", event_type: "order_created" });
    eventsTotal.inc({ chain: "ethereum", event_type: "order_created" });
    eventsTotal.inc({ chain: "soroban", event_type: "contract_event" });

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_events_total{chain="ethereum",event_type="order_created"} 2');
    expect(metrics).toContain('resolver_events_total{chain="soroban",event_type="contract_event"} 1');
  });

  it("increments listener_errors_total counter", async () => {
    const { listenerErrorsTotal } = await import("../src/metrics.js");
    listenerErrorsTotal.inc({ chain: "ethereum", error_type: "handler_error" });

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_listener_errors_total{chain="ethereum",error_type="handler_error"} 1');
  });

  it("records operation duration histogram", async () => {
    const { operationDurationSeconds } = await import("../src/metrics.js");
    const end = operationDurationSeconds.startTimer({ operation: "claim", chain: "ethereum" });
    end();

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_operation_duration_seconds_count{operation="claim",chain="ethereum"} 1');
  });

  it("sets start_time_seconds gauge", async () => {
    const { startTimeSeconds } = await import("../src/metrics.js");
    startTimeSeconds.set(Math.floor(Date.now() / 1000));

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_start_time_seconds");
    const lines = metrics.split("\n").filter(l => l.startsWith("resolver_start_time_seconds"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^resolver_start_time_seconds \d/);
  });

  it("tracks active operations gauge", async () => {
    const { activeOperations } = await import("../src/metrics.js");
    activeOperations.set({ operation: "claim" }, 2);

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_active_operations{operation="claim"} 2');
  });

  it("increments claim_attempts_total with failure_reason", async () => {
    const { claimAttemptsTotal } = await import("../src/metrics.js");
    claimAttemptsTotal.inc({ chain: "ethereum", result: "success", failure_reason: "" });
    claimAttemptsTotal.inc({ chain: "ethereum", result: "failure", failure_reason: "insufficient_balance" });

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_claim_attempts_total{chain="ethereum",result="success",failure_reason=""} 1');
    expect(metrics).toContain('resolver_claim_attempts_total{chain="ethereum",result="failure",failure_reason="insufficient_balance"} 1');
  });

  it("exposes metrics via the metrics route", async () => {
    const { metricsRouter } = await import("../src/routes/metrics.js");
    const router = metricsRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe("function");
  });

  it("exports all expected metric handles in resolverMetrics", async () => {
    const { resolverMetrics } = await import("../src/metrics.js");
    expect(resolverMetrics.eventsTotal).toBeDefined();
    expect(resolverMetrics.listenerErrorsTotal).toBeDefined();
    expect(resolverMetrics.listenerPollDurationSeconds).toBeDefined();
    expect(resolverMetrics.listenerPollRunsTotal).toBeDefined();
    expect(resolverMetrics.listenerLastEventTimestampSeconds).toBeDefined();
    expect(resolverMetrics.activeListeners).toBeDefined();
    expect(resolverMetrics.registrationInfo).toBeDefined();
    expect(resolverMetrics.registrationChangesTotal).toBeDefined();
    expect(resolverMetrics.startTimeSeconds).toBeDefined();
    expect(resolverMetrics.ordersProcessedTotal).toBeDefined();
    expect(resolverMetrics.claimAttemptsTotal).toBeDefined();
    expect(resolverMetrics.refundAttemptsTotal).toBeDefined();
    expect(resolverMetrics.retryAttemptsTotal).toBeDefined();
    expect(resolverMetrics.operationDurationSeconds).toBeDefined();
    expect(resolverMetrics.operationFailuresTotal).toBeDefined();
    expect(resolverMetrics.activeOperations).toBeDefined();
  });
});
