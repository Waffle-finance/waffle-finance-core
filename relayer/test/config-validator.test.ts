import { describe, it, expect } from "vitest";
import {
  validateRelayerStartup,
  formatStartupErrors,
  type ConfigError,
} from "../src/config-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ETH_KEY =
  "0x" + "a".repeat(63) + "1"; // 64 non-zero hex chars → real-looking key
const VALID_STELLAR_SECRET = "S" + "A".repeat(55); // 56-char S-prefixed key
const VALID_ENV = {
  ETHEREUM_RPC_URL: "https://eth-mainnet.example.com/v3/key",
  STELLAR_HORIZON_URL: "https://horizon.stellar.org",
};
const VALID_CFG = {
  ethereumPrivateKey: VALID_ETH_KEY,
  stellarSecretKey: VALID_STELLAR_SECRET,
};

function fieldCodes(errors: ConfigError[]): Record<string, string> {
  return Object.fromEntries(errors.map((e) => [e.field, e.code]));
}

// ---------------------------------------------------------------------------
// Happy-path: no errors
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — valid config", () => {
  it("returns an empty array when all fields are present and non-placeholder", () => {
    const errors = validateRelayerStartup(VALID_ENV, VALID_CFG);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing fields
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — missing fields", () => {
  it("reports missing ETHEREUM_RPC_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: undefined },
      VALID_CFG
    );
    const codes = fieldCodes(errors);
    expect(codes["ETHEREUM_RPC_URL"]).toBe("missing");
  });

  it("reports missing STELLAR_HORIZON_URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: undefined },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("missing");
  });

  it("reports missing ethereum private key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: undefined,
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("missing");
  });

  it("reports missing stellar secret key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: undefined,
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("missing");
  });

  it("aggregates all missing fields in one call instead of stopping at the first", () => {
    const errors = validateRelayerStartup({}, {});
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("ETHEREUM_RPC_URL");
    expect(fields).toContain("STELLAR_HORIZON_URL");
    expect(fields).toContain("RELAYER_PRIVATE_KEY");
    expect(fields).toContain("RELAYER_STELLAR_SECRET");
    // All four must be reported in a single call
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — placeholder values", () => {
  it("rejects ETHEREUM_RPC_URL that contains YOUR_", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: "https://YOUR_API_KEY.infura.io" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["ETHEREUM_RPC_URL"]).toBe("placeholder");
  });

  it("rejects STELLAR_HORIZON_URL that contains REPLACE_ME", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: "https://REPLACE_ME.horizon.org" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("placeholder");
  });

  it("rejects an Ethereum key that contains YOUR_", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "YOUR_PRIVATE_KEY_HERE",
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("placeholder");
  });

  it("rejects a Stellar secret that contains SAMPLE", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: "SAMPLE_STELLAR_SECRET_KEY",
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("placeholder");
  });
});

// ---------------------------------------------------------------------------
// Format checks
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — invalid format", () => {
  it("rejects ETHEREUM_RPC_URL that is not an http(s) URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: "wss://eth-node.example.com" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["ETHEREUM_RPC_URL"]).toBe("invalid_format");
  });

  it("rejects STELLAR_HORIZON_URL that is not an http(s) URL", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, STELLAR_HORIZON_URL: "ftp://horizon.stellar.org" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["STELLAR_HORIZON_URL"]).toBe("invalid_format");
  });

  it("rejects a Stellar secret key that does not match the expected format", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      stellarSecretKey: "notAStellarKey",
    });
    expect(fieldCodes(errors)["RELAYER_STELLAR_SECRET"]).toBe("invalid_format");
  });
});

// ---------------------------------------------------------------------------
// Invalid value: zero / dummy Ethereum key
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — zero / dummy Ethereum key", () => {
  it("rejects an all-zero private key", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "0x" + "0".repeat(64),
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("invalid_value");
  });

  it("rejects the canonical dummy key (0x000...001)", () => {
    const errors = validateRelayerStartup(VALID_ENV, {
      ...VALID_CFG,
      ethereumPrivateKey: "0x" + "0".repeat(63) + "1",
    });
    expect(fieldCodes(errors)["RELAYER_PRIVATE_KEY"]).toBe("invalid_value");
  });
});

// ---------------------------------------------------------------------------
// env-variable fallback (cfg not supplied)
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — env-variable fallback", () => {
  it("reads RELAYER_PRIVATE_KEY from env when cfg.ethereumPrivateKey is absent", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_PRIVATE_KEY: VALID_ETH_KEY },
      { stellarSecretKey: VALID_STELLAR_SECRET }
    );
    const fields = errors.map((e) => e.field);
    expect(fields).not.toContain("RELAYER_PRIVATE_KEY");
  });

  it("reads RELAYER_STELLAR_SECRET from env when cfg.stellarSecretKey is absent", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_STELLAR_SECRET: VALID_STELLAR_SECRET },
      { ethereumPrivateKey: VALID_ETH_KEY }
    );
    const fields = errors.map((e) => e.field);
    expect(fields).not.toContain("RELAYER_STELLAR_SECRET");
  });
});

// ---------------------------------------------------------------------------
// formatStartupErrors
// ---------------------------------------------------------------------------

describe("formatStartupErrors", () => {
  it("returns a multi-line string with one line per error", () => {
    const errors = validateRelayerStartup({}, {});
    const formatted = formatStartupErrors(errors);
    const lines = formatted.split("\n").filter(Boolean);
    expect(lines.length).toBe(errors.length);
  });

  it("includes the field name and code in each line", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, ETHEREUM_RPC_URL: undefined },
      VALID_CFG
    );
    const formatted = formatStartupErrors(errors);
    expect(formatted).toContain("ETHEREUM_RPC_URL");
    expect(formatted).toContain("missing");
  });
});

// ---------------------------------------------------------------------------
// Negative polling intervals
// ---------------------------------------------------------------------------

describe("validateRelayerStartup — negative polling intervals", () => {
  it("rejects a negative RELAYER_ACTIVE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "-5000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("rejects a negative RELAYER_IDLE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_IDLE_POLL_INTERVAL_MS: "-1000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("rejects a non-numeric RELAYER_ACTIVE_POLL_INTERVAL_MS", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "abc" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBe("invalid_value");
  });

  it("accepts a valid positive polling interval", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "15000", RELAYER_IDLE_POLL_INTERVAL_MS: "120000" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });

  it("accepts zero polling interval (disabled polling)", () => {
    const errors = validateRelayerStartup(
      { ...VALID_ENV, RELAYER_ACTIVE_POLL_INTERVAL_MS: "0", RELAYER_IDLE_POLL_INTERVAL_MS: "0" },
      VALID_CFG
    );
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });

  it("does not report polling interval error when env var is absent", () => {
    const errors = validateRelayerStartup(VALID_ENV, VALID_CFG);
    expect(fieldCodes(errors)["RELAYER_ACTIVE_POLL_INTERVAL_MS"]).toBeUndefined();
    expect(fieldCodes(errors)["RELAYER_IDLE_POLL_INTERVAL_MS"]).toBeUndefined();
  });
});
