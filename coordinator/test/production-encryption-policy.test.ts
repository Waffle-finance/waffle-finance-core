/**
 * Production encryption policy and safe key generation (issue #1129).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { OrderService } from "../src/services/order-service.js";
import {
  SecretService,
  requiresEncryptedStorage
} from "../src/services/secret-service.js";

const orders = {} as OrderService;
const VALID_KEY = "c".repeat(64);

function captureLog() {
  const lines: string[] = [];
  const log = {
    info: (msg: string) => lines.push(String(msg)),
    warn: (msg: string) => lines.push(String(msg)),
    error: (msg: string) => lines.push(String(msg)),
    debug: (msg: string) => lines.push(String(msg))
  } as unknown as Logger;
  return { log, lines };
}

describe("environment-aware encryption policy", () => {
  it("allows plaintext only for local development / test", () => {
    expect(requiresEncryptedStorage("testnet", "development")).toBe(false);
    expect(requiresEncryptedStorage("testnet", "test")).toBe(false);
  });

  it("requires a key on mainnet and in any production deployment", () => {
    expect(requiresEncryptedStorage("mainnet", "development")).toBe(true);
    expect(requiresEncryptedStorage("testnet", "production")).toBe(true);
  });

  it("fails closed on production startup with a missing key and explains how to fix it", () => {
    for (const [network, nodeEnv] of [
      ["mainnet", "development"],
      ["testnet", "production"]
    ] as const) {
      const { log, lines } = captureLog();
      expect(() => new SecretService(orders, log, undefined, network, nodeEnv)).toThrow(
        /SECRET_STORAGE_KEY is required in production/
      );
      expect(lines.join("\n")).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it("rejects malformed keys without echoing the key value", () => {
    const { log, lines } = captureLog();
    const malformed = "not-a-key";
    expect(
      () => new SecretService(orders, log, malformed, "testnet", "production")
    ).toThrow(/invalid SECRET_STORAGE_KEY/);
    expect(lines.join("\n")).not.toContain(malformed);
  });

  it("accepts a valid key in production and never logs key material", () => {
    const { log, lines } = captureLog();
    expect(
      () => new SecretService(orders, log, VALID_KEY, "mainnet", "production")
    ).not.toThrow();
    expect(lines.join("\n")).not.toContain(VALID_KEY);
  });

  it("provides a key-generation command that writes only a hex key to stdout", () => {
    const script = resolve("scripts/generate-key.mjs");
    const output = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(output.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(output.trim().length).toBe(64);
  });
});
