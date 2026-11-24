/**
 * Trusted proxy configuration validation and forwarded-header spoofing tests (#1132).
 */
import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  parseTrustedProxies,
  resolveClientIp
} from "../src/server/middleware/ratelimit.js";

function req(peer: string, forwarded?: string): Request {
  return {
    socket: { remoteAddress: peer },
    headers: forwarded ? { "x-forwarded-for": forwarded } : {}
  } as unknown as Request;
}

describe("COORDINATOR_TRUSTED_PROXIES parsing", () => {
  it("defaults to trusting no forwarded headers", () => {
    const config = parseTrustedProxies(undefined);
    expect(config.addresses.size).toBe(0);
    expect(config.cidrs).toEqual([]);
    expect(config.hops).toBe(0);
    expect(resolveClientIp(req("203.0.113.9", "1.2.3.4"), config)).toBe("203.0.113.9");
  });

  it("accepts exact IPs, IPv4 CIDRs and hop counts", () => {
    const config = parseTrustedProxies("127.0.0.1, 10.0.0.0/8, hops=1");
    expect(config.addresses.has("127.0.0.1")).toBe(true);
    expect(config.cidrs.length).toBe(1);
    expect(config.hops).toBe(1);
  });

  it.each(["not-an-ip", "10.0.0.0/33", "10.0.0.0/abc", "hops=99", "10.0.0.0/8/9"])(
    "rejects malformed entry %s",
    (entry) => {
      expect(() => parseTrustedProxies(entry)).toThrow(/invalid trusted proxy/);
    }
  );
});

describe("client identity selection", () => {
  it("ignores X-Forwarded-For from an untrusted caller", () => {
    const config = parseTrustedProxies("10.0.0.0/8");
    expect(resolveClientIp(req("203.0.113.9", "198.51.100.7"), config)).toBe("203.0.113.9");
  });

  it("uses the first forwarded address when the direct peer is trusted", () => {
    const config = parseTrustedProxies("127.0.0.1");
    expect(resolveClientIp(req("::ffff:127.0.0.1", "198.51.100.7, 10.0.0.2"), config))
      .toBe("198.51.100.7");
  });

  it("honours hop count for multi-hop chains", () => {
    const config = parseTrustedProxies("10.0.0.0/8,hops=2");
    // Rightmost two entries are our proxies; the client is leftmost.
    expect(resolveClientIp(req("10.0.0.5", "198.51.100.7, 10.1.0.1, 10.1.0.2"), config))
      .toBe("198.51.100.7");
    // Single-hop header cannot satisfy a two-hop policy: fall back to peer.
    expect(resolveClientIp(req("10.0.0.5", "198.51.100.7"), config)).toBe("10.0.0.5");
  });

  it("never lets an untrusted caller select another identity via hops", () => {
    const config = parseTrustedProxies("127.0.0.1,hops=1");
    expect(resolveClientIp(req("203.0.113.9", "198.51.100.7, 127.0.0.1"), config))
      .toBe("203.0.113.9");
  });
});
