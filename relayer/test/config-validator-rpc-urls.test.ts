/**
 * RPC endpoint URL validation tests for validateRelayerStartup.
 *
 * Context
 * -------
 * Without a URL parse check at startup an operator could supply a malformed
 * RPC endpoint string that silently passes validation and only fails later —
 * when the relayer attempts a live network request.  This test suite verifies
 * that invalid endpoint strings are caught immediately with a descriptive
 * error, that valid HTTP(S) endpoints remain accepted, and that no network
 * request is required to validate the configuration.
 *
 * Coverage
 * --------
 *   - Completely unparseable strings (not a URL at all)
 *   - Strings that are parseable but use unsupported protocols (ws, wss, ftp,
 *     postgres, ipfs, …)
 *   - Bare hostnames / IPs without a scheme
 *   - Valid http and https endpoints remain unchanged
 *   - Error messages identify the failing field by name
 *   - No actual network connection is required (pure synchronous validation)
 */

import { describe, it, expect } from "vitest";
import {
  validateRelayerStartup,
  type ConfigError,
} from "../src/config-validator.js";

// ── Baseline valid config ─────────────────────────────────────────────────────

const VALID_ETH_KEY = "0x" + "a".repeat(63) + "1";
const VALID_STELLAR_SECRET = "S" + "A".repeat(55);

const VALID_CFG = {
  ethereumPrivateKey: VALID_ETH_KEY,
  stellarSecretKey: VALID_STELLAR_SECRET,
};

function onlyRpcErrors(errors: ConfigError[]): ConfigError[] {
  return errors.filter(
    (e) =>
      e.field === "ETHEREUM_RPC_URL" || e.field === "STELLAR_HORIZON_URL",
  );
}

// ── ETHEREUM_RPC_URL — malformed / unparseable strings ───────────────────────

describe("validateRelayerStartup — ETHEREUM_RPC_URL malformed strings", () => {
  const base = { STELLAR_HORIZON_URL: "https://horizon.stellar.org" };

  it("rejects a completely non-URL string with invalid_format", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "not-a-url-at-all" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc).toBeDefined();
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a bare hostname without a scheme", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "eth-node.example.com" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects an IP address without a scheme", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "192.168.1.1:8545" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a wss:// (WebSocket) endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "wss://eth-node.example.com" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a ws:// (plain WebSocket) endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "ws://eth-node.example.com" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a ftp:// endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "ftp://eth-node.example.com" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a postgres:// endpoint (accidental DB URL in wrong field)", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "postgres://user:pass@localhost:5432/db" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.code).toBe("invalid_format");
  });

  it("rejects a string with only whitespace", () => {
    // Empty/whitespace-only values are caught as 'missing' (falsy check).
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "   " },
      VALID_CFG,
    );
    // The validation should reject this — either 'missing' or 'invalid_format'.
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc).toBeDefined();
    expect(["missing", "invalid_format", "placeholder"]).toContain(rpc?.code);
  });

  it("error message names the failing field (ETHEREUM_RPC_URL)", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "not-a-url" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc?.message).toMatch(/ETHEREUM_RPC_URL/i);
  });

  it("accepts a valid http:// endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "http://eth-node.internal:8545" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc).toBeUndefined();
  });

  it("accepts a valid https:// endpoint with a path and API key", () => {
    const errors = validateRelayerStartup(
      { ...base, ETHEREUM_RPC_URL: "https://mainnet.infura.io/v3/abc123" },
      VALID_CFG,
    );
    const rpc = onlyRpcErrors(errors).find((e) => e.field === "ETHEREUM_RPC_URL");
    expect(rpc).toBeUndefined();
  });
});

// ── STELLAR_HORIZON_URL — malformed / unsupported protocols ──────────────────

describe("validateRelayerStartup — STELLAR_HORIZON_URL malformed strings", () => {
  const base = { ETHEREUM_RPC_URL: "https://eth-mainnet.example.com/v3/key" };

  it("rejects a completely non-URL string with invalid_format", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "not-a-url-either" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon?.code).toBe("invalid_format");
  });

  it("rejects a bare hostname without a scheme", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "horizon.stellar.org" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon?.code).toBe("invalid_format");
  });

  it("rejects a ftp:// Horizon URL", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "ftp://horizon.stellar.org" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon?.code).toBe("invalid_format");
  });

  it("rejects an ipfs:// endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "ipfs://bafybei..." },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon?.code).toBe("invalid_format");
  });

  it("error message names the failing field (STELLAR_HORIZON_URL)", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "not-a-url" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon?.message).toMatch(/STELLAR_HORIZON_URL/i);
  });

  it("accepts the canonical Horizon https endpoint", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "https://horizon.stellar.org" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon).toBeUndefined();
  });

  it("accepts a private http:// Horizon instance", () => {
    const errors = validateRelayerStartup(
      { ...base, STELLAR_HORIZON_URL: "http://horizon.internal:8000" },
      VALID_CFG,
    );
    const horizon = onlyRpcErrors(errors).find(
      (e) => e.field === "STELLAR_HORIZON_URL",
    );
    expect(horizon).toBeUndefined();
  });
});

// ── Both fields invalid simultaneously ────────────────────────────────────────

describe("validateRelayerStartup — both RPC endpoints malformed", () => {
  it("reports both ETHEREUM_RPC_URL and STELLAR_HORIZON_URL when both are malformed", () => {
    const errors = validateRelayerStartup(
      {
        ETHEREUM_RPC_URL: "not-a-url",
        STELLAR_HORIZON_URL: "also-not-a-url",
      },
      VALID_CFG,
    );
    const rpcErrors = onlyRpcErrors(errors);
    const fields = rpcErrors.map((e) => e.field);
    expect(fields).toContain("ETHEREUM_RPC_URL");
    expect(fields).toContain("STELLAR_HORIZON_URL");
  });

  it("collects all errors in one pass (does not stop at the first invalid URL)", () => {
    const errors = validateRelayerStartup(
      {
        ETHEREUM_RPC_URL: "wss://eth.example.com",
        STELLAR_HORIZON_URL: "ftp://horizon.example.com",
      },
      VALID_CFG,
    );
    const rpcErrors = onlyRpcErrors(errors);
    expect(rpcErrors.length).toBe(2);
    expect(rpcErrors.every((e) => e.code === "invalid_format")).toBe(true);
  });
});
