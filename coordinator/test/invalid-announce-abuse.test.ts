import { describe, it, expect, vi, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { AbuseDetector } from "../src/server/middleware/abuse-detection.js";

const CLIENT = "203.0.113.42";
const OTHER_CLIENT = "198.51.100.7";

let detector: AbuseDetector | undefined;

function makeDetector(opts: { log?: Logger } = {}) {
  detector = new AbuseDetector({
    invalidWindowMs: 1_000,
    invalidThreshold: 3,
    multiRouteWindowMs: 1_000,
    ...opts,
  });
  return detector;
}

function makeLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: "trace" }, sink), lines };
}

afterEach(() => {
  detector?.stop();
  detector = undefined;
  vi.useRealTimers();
});

describe("invalid announce abuse detection (#1136)", () => {
  it("flags repeated malformed announces at the documented threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = makeDetector();
    expect(d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() })).toBe(false);
    expect(d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() })).toBe(false);
    expect(d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() })).toBe(true);
    expect(d.invalidAnnounceCounters).toMatchObject({
      counted: 3,
      flaggedClients: 1,
      trackedClients: 1,
      threshold: 3,
    });
  });

  it("decays flags once the invalid-request window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = makeDetector();
    for (let i = 0; i < 3; i++) {
      d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() });
    }
    expect(d.invalidAnnounceCounters.flaggedClients).toBe(1);

    vi.advanceTimersByTime(1_500);
    expect(d.invalidAnnounceCounters).toMatchObject({ flaggedClients: 0, trackedClients: 0 });
    expect(d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() })).toBe(false);
  });

  it("does not classify transient chain or quote failures as abuse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = makeDetector();
    for (let i = 0; i < 10; i++) {
      d.recordInvalidAnnounce({ clientId: CLIENT, reason: "chain_unavailable", timestamp: Date.now() });
      d.recordInvalidAnnounce({ clientId: CLIENT, reason: "quote_unavailable", timestamp: Date.now() });
    }
    expect(d.invalidAnnounceCounters).toMatchObject({
      counted: 0,
      transientSkipped: 20,
      flaggedClients: 0,
      trackedClients: 0,
    });
    // A later valid retry is unaffected by the transient failures.
    expect(d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() })).toBe(false);
  });

  it("exempts trusted clients and tracks identities independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = makeDetector();
    for (let i = 0; i < 10; i++) {
      d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now(), trusted: true });
    }
    expect(d.invalidAnnounceCounters).toMatchObject({ counted: 0, trustedSkipped: 10, flaggedClients: 0 });

    for (let i = 0; i < 2; i++) {
      d.recordInvalidAnnounce({ clientId: CLIENT, reason: "malformed", timestamp: Date.now() });
      d.recordInvalidAnnounce({ clientId: OTHER_CLIENT, reason: "policy_denied", timestamp: Date.now() });
    }
    expect(d.invalidAnnounceCounters).toMatchObject({ flaggedClients: 0, trackedClients: 2 });
  });

  it("exposes only aggregate counters and never logs raw addresses or bodies", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { log, lines } = makeLogger();
    const d = makeDetector({ log });
    for (let i = 0; i < 3; i++) {
      d.recordInvalidAnnounce({
        clientId: CLIENT,
        reason: "malformed",
        timestamp: Date.now(),
      });
    }
    const output = lines.join("");
    expect(output).not.toContain(CLIENT);
    expect(output).toContain("repeated invalid announce requests");
    expect(JSON.stringify(d.invalidAnnounceCounters)).not.toContain(CLIENT);
    expect(JSON.stringify(d.invalidAnnounceCounters)).not.toContain("requestBody");
  });
});
