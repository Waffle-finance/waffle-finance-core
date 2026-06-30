/**
 * Unit tests for scripts/validateEnv.ts
 *
 * These tests run entirely in-process — no Hardhat network, no RPC calls,
 * no real private keys. They verify that:
 *
 *   1. Each required env var, when missing or malformed, produces the correct
 *      hard error.
 *   2. Advisory conditions (zero minSafetyDeposit, low minStake, missing RPC)
 *      produce warnings but do not block deployment.
 *   3. A correctly configured environment passes without errors or unexpected
 *      warnings.
 *   4. `runPreflightChecks` throws on hard errors and does NOT throw on a
 *      valid environment.
 *
 * CI note: this file is included in `tsc --noEmit` (via tsconfig include glob)
 * but is NOT run by the CI hardhat test command (which targets only
 * HTLCEscrow.test.ts and ResolverRegistry.test.ts). It can be run locally
 * with `pnpm test:validate`.
 */

import { expect } from "chai";
import {
  validateDeployEnv,
  runPreflightChecks,
  isValidAddress,
  isZeroAddress,
  isValidPrivateKey,
  isValidRpcUrl,
} from "../scripts/validateEnv";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** A syntactically valid 64-hex-char private key (all a's — never a real key). */
const VALID_KEY = "0x" + "a".repeat(64);

/** A plausible ERC20 address. */
const VALID_ADDR = "0x" + "1".repeat(40);

/** A full environment that passes all checks on the "sepolia" network. */
function validEnv(): Record<string, string> {
  return {
    RELAYER_PRIVATE_KEY: VALID_KEY,
    V2_STAKE_ASSET: VALID_ADDR,
    V2_MIN_STAKE: "100000000000000000000", // 100e18
    V2_MIN_SAFETY_DEPOSIT: "1000000000000000", // 0.001 ETH
    SEPOLIA_RPC_URL: "https://sepolia.infura.io/v3/testkey",
  };
}

/** Return a copy of `base` without the specified key. */
function omit(
  base: Record<string, string>,
  key: string
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...base };
  copy[key] = undefined;
  return copy;
}

// ─── isValidAddress ───────────────────────────────────────────────────────────

describe("isValidAddress", () => {
  it("accepts a lowercase 40-hex-char address", () => {
    expect(isValidAddress("0x" + "a".repeat(40))).to.be.true;
  });

  it("accepts a mixed-case address", () => {
    expect(isValidAddress("0xAbCd" + "1".repeat(36))).to.be.true;
  });

  it("rejects an address without 0x prefix", () => {
    expect(isValidAddress("a".repeat(40))).to.be.false;
  });

  it("rejects an address that is too short", () => {
    expect(isValidAddress("0x" + "a".repeat(39))).to.be.false;
  });

  it("rejects an address that is too long", () => {
    expect(isValidAddress("0x" + "a".repeat(41))).to.be.false;
  });

  it("rejects an empty string", () => {
    expect(isValidAddress("")).to.be.false;
  });

  it("rejects non-hex characters", () => {
    expect(isValidAddress("0x" + "g".repeat(40))).to.be.false;
  });
});

// ─── isZeroAddress ────────────────────────────────────────────────────────────

describe("isZeroAddress", () => {
  it("identifies the canonical zero address", () => {
    expect(isZeroAddress("0x" + "0".repeat(40))).to.be.true;
  });

  it("returns false for a non-zero address", () => {
    expect(isZeroAddress(VALID_ADDR)).to.be.false;
  });
});

// ─── isValidPrivateKey ────────────────────────────────────────────────────────

describe("isValidPrivateKey", () => {
  it("accepts a 0x-prefixed 64-hex-char key", () => {
    expect(isValidPrivateKey("0x" + "a".repeat(64))).to.be.true;
  });

  it("accepts a raw 64-hex-char key without 0x prefix", () => {
    expect(isValidPrivateKey("b".repeat(64))).to.be.true;
  });

  it("rejects undefined", () => {
    expect(isValidPrivateKey(undefined)).to.be.false;
  });

  it("rejects an empty string", () => {
    expect(isValidPrivateKey("")).to.be.false;
  });

  it("rejects a key that is too short (63 hex chars)", () => {
    expect(isValidPrivateKey("0x" + "a".repeat(63))).to.be.false;
  });

  it("rejects a key that is too long (65 hex chars)", () => {
    expect(isValidPrivateKey("0x" + "a".repeat(65))).to.be.false;
  });

  it("rejects non-hex characters", () => {
    expect(isValidPrivateKey("0x" + "z".repeat(64))).to.be.false;
  });

  it("rejects a key that is only whitespace", () => {
    expect(isValidPrivateKey("   ")).to.be.false;
  });
});

// ─── isValidRpcUrl ────────────────────────────────────────────────────────────

describe("isValidRpcUrl", () => {
  it("accepts an https URL", () => {
    expect(isValidRpcUrl("https://sepolia.infura.io/v3/key")).to.be.true;
  });

  it("accepts an http URL", () => {
    expect(isValidRpcUrl("http://localhost:8545")).to.be.true;
  });

  it("accepts a wss URL", () => {
    expect(isValidRpcUrl("wss://mainnet.infura.io/ws/v3/key")).to.be.true;
  });

  it("rejects undefined", () => {
    expect(isValidRpcUrl(undefined)).to.be.false;
  });

  it("rejects an empty string", () => {
    expect(isValidRpcUrl("")).to.be.false;
  });

  it("rejects a plain hostname without protocol", () => {
    expect(isValidRpcUrl("sepolia.infura.io")).to.be.false;
  });

  it("rejects a non-URL string", () => {
    expect(isValidRpcUrl("not-a-url")).to.be.false;
  });
});

// ─── validateDeployEnv — happy path ───────────────────────────────────────────

describe("validateDeployEnv — valid configuration", () => {
  it("passes with a fully configured sepolia environment", () => {
    const result = validateDeployEnv(validEnv(), "sepolia");
    expect(result.valid).to.be.true;
    expect(result.errors).to.be.empty;
  });

  it("passes on local hardhat network with minimal env (no live-network requirements)", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        // V2_MIN_STAKE intentionally absent — OK for local
      },
      "hardhat"
    );
    expect(result.valid).to.be.true;
    expect(result.errors).to.be.empty;
  });

  it("passes when INFURA_API_KEY is supplied instead of SEPOLIA_RPC_URL", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
        V2_MIN_SAFETY_DEPOSIT: "1000000000000000",
        INFURA_API_KEY: "somekey",
      },
      "sepolia"
    );
    expect(result.valid).to.be.true;
    expect(result.errors).to.be.empty;
  });
});

// ─── validateDeployEnv — private key errors ───────────────────────────────────

describe("validateDeployEnv — private key errors", () => {
  it("errors when RELAYER_PRIVATE_KEY is missing", () => {
    const result = validateDeployEnv(omit(validEnv(), "RELAYER_PRIVATE_KEY"), "sepolia");
    expect(result.valid).to.be.false;
    expect(result.errors.some((e) => e.includes("private key"))).to.be.true;
  });

  it("errors when RELAYER_PRIVATE_KEY is an empty string", () => {
    const result = validateDeployEnv(
      { ...validEnv(), RELAYER_PRIVATE_KEY: "" },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(result.errors.some((e) => e.includes("private key"))).to.be.true;
  });

  it("errors when RELAYER_PRIVATE_KEY is malformatted", () => {
    const result = validateDeployEnv(
      { ...validEnv(), RELAYER_PRIVATE_KEY: "not-a-key" },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(result.errors.some((e) => e.includes("invalid format"))).to.be.true;
  });

  it("does NOT include the private key value in any error message", () => {
    // Use a recognisable but syntactically invalid key so we can search for it.
    const badKey = "SECRETBADKEY_SHOULD_NOT_APPEAR";
    const result = validateDeployEnv(
      { ...validEnv(), RELAYER_PRIVATE_KEY: badKey },
      "sepolia"
    );
    const allMessages = [...result.errors, ...result.warnings].join(" ");
    expect(allMessages).to.not.include(badKey);
  });

  it("accepts PRIVATE_KEY as a fallback when RELAYER_PRIVATE_KEY is absent", () => {
    const result = validateDeployEnv(
      {
        PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
        V2_MIN_SAFETY_DEPOSIT: "1000000000000000",
        SEPOLIA_RPC_URL: "https://sepolia.infura.io/v3/testkey",
      },
      "sepolia"
    );
    expect(result.valid).to.be.true;
    expect(result.errors).to.be.empty;
  });
});

// ─── validateDeployEnv — stake asset errors ───────────────────────────────────

describe("validateDeployEnv — V2_STAKE_ASSET errors", () => {
  it("errors when V2_STAKE_ASSET is missing", () => {
    const result = validateDeployEnv(omit(validEnv(), "V2_STAKE_ASSET"), "sepolia");
    expect(result.valid).to.be.false;
    expect(result.errors.some((e) => e.includes("V2_STAKE_ASSET"))).to.be.true;
  });

  it("errors when V2_STAKE_ASSET is not a valid address", () => {
    const result = validateDeployEnv(
      { ...validEnv(), V2_STAKE_ASSET: "not-an-address" },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(
      result.errors.some(
        (e) => e.includes("V2_STAKE_ASSET") && e.includes("valid Ethereum address")
      )
    ).to.be.true;
  });

  it("errors when V2_STAKE_ASSET is the zero address", () => {
    const result = validateDeployEnv(
      { ...validEnv(), V2_STAKE_ASSET: "0x" + "0".repeat(40) },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(
      result.errors.some(
        (e) => e.includes("V2_STAKE_ASSET") && e.includes("zero address")
      )
    ).to.be.true;
  });
});

// ─── validateDeployEnv — minStake errors & warnings ──────────────────────────

describe("validateDeployEnv — V2_MIN_STAKE", () => {
  it("errors when V2_MIN_STAKE is missing on a live network", () => {
    const result = validateDeployEnv(omit(validEnv(), "V2_MIN_STAKE"), "sepolia");
    expect(result.valid).to.be.false;
    expect(
      result.errors.some((e) => e.includes("V2_MIN_STAKE") && e.includes("live"))
    ).to.be.true;
  });

  it("only warns (does not error) when V2_MIN_STAKE is missing on hardhat", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
      },
      "hardhat"
    );
    expect(result.valid).to.be.true;
    expect(result.warnings.some((w) => w.includes("V2_MIN_STAKE"))).to.be.true;
  });

  it("errors when V2_MIN_STAKE is not a valid integer", () => {
    const result = validateDeployEnv(
      { ...validEnv(), V2_MIN_STAKE: "not-a-number" },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(
      result.errors.some(
        (e) => e.includes("V2_MIN_STAKE") && e.includes("valid integer")
      )
    ).to.be.true;
  });

  it("warns when V2_MIN_STAKE is below 1 token (1e18) on a live network", () => {
    const result = validateDeployEnv(
      { ...validEnv(), V2_MIN_STAKE: "1" }, // 1 wei — suspiciously low
      "sepolia"
    );
    expect(result.valid).to.be.true;
    expect(result.warnings.some((w) => w.includes("V2_MIN_STAKE"))).to.be.true;
  });

  it("does NOT warn about low minStake on local hardhat network", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "1",
      },
      "hardhat"
    );
    const hasLowStakeWarn = result.warnings.some(
      (w) => w.includes("V2_MIN_STAKE") && w.includes("less than 1 token")
    );
    expect(hasLowStakeWarn).to.be.false;
  });
});

// ─── validateDeployEnv — minSafetyDeposit warnings ───────────────────────────

describe("validateDeployEnv — V2_MIN_SAFETY_DEPOSIT", () => {
  it("warns when V2_MIN_SAFETY_DEPOSIT is absent", () => {
    const result = validateDeployEnv(
      omit(validEnv(), "V2_MIN_SAFETY_DEPOSIT"),
      "sepolia"
    );
    expect(result.valid).to.be.true;
    expect(
      result.warnings.some((w) => w.includes("V2_MIN_SAFETY_DEPOSIT"))
    ).to.be.true;
  });

  it("errors when V2_MIN_SAFETY_DEPOSIT is not a valid integer", () => {
    const result = validateDeployEnv(
      { ...validEnv(), V2_MIN_SAFETY_DEPOSIT: "0.001 ETH" },
      "sepolia"
    );
    expect(result.valid).to.be.false;
    expect(
      result.errors.some(
        (e) => e.includes("V2_MIN_SAFETY_DEPOSIT") && e.includes("valid integer")
      )
    ).to.be.true;
  });
});

// ─── validateDeployEnv — RPC warnings ────────────────────────────────────────

describe("validateDeployEnv — RPC URL warnings", () => {
  it("warns when no RPC source is configured for sepolia", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
        V2_MIN_SAFETY_DEPOSIT: "1000000000000000",
        // Deliberately omit all RPC-related vars
      },
      "sepolia"
    );
    expect(result.valid).to.be.true; // RPC issues are warnings, not errors
    expect(
      result.warnings.some((w) => w.includes("RPC") || w.includes("rpc"))
    ).to.be.true;
  });

  it("does NOT warn about RPC on local hardhat network", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
      },
      "hardhat"
    );
    const hasRpcWarn = result.warnings.some((w) =>
      w.toLowerCase().includes("rpc")
    );
    expect(hasRpcWarn).to.be.false;
  });
});

// ─── validateDeployEnv — mainnet guard ───────────────────────────────────────

describe("validateDeployEnv — mainnet guard", () => {
  it("always emits a mainnet deployment warning", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
        V2_MIN_SAFETY_DEPOSIT: "1000000000000000",
        MAINNET_RPC_URL: "https://mainnet.infura.io/v3/key",
      },
      "mainnet"
    );
    expect(result.warnings.some((w) => w.includes("MAINNET"))).to.be.true;
  });

  it("passes a fully configured mainnet environment", () => {
    const result = validateDeployEnv(
      {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
        V2_MIN_STAKE: "100000000000000000000",
        V2_MIN_SAFETY_DEPOSIT: "1000000000000000",
        MAINNET_RPC_URL: "https://mainnet.infura.io/v3/key",
      },
      "mainnet"
    );
    expect(result.valid).to.be.true;
    expect(result.errors).to.be.empty;
  });
});

// ─── validateDeployEnv — multiple errors at once ─────────────────────────────

describe("validateDeployEnv — multiple simultaneous errors", () => {
  it("reports all errors at once rather than failing on the first one", () => {
    const result = validateDeployEnv({}, "sepolia");
    // At minimum: missing key, missing stakeAsset, missing minStake
    expect(result.valid).to.be.false;
    expect(result.errors.length).to.be.gte(3);
  });
});

// ─── runPreflightChecks ───────────────────────────────────────────────────────

describe("runPreflightChecks", () => {
  it("throws when the environment is invalid", () => {
    expect(() => runPreflightChecks("sepolia", {})).to.throw(/Preflight check failed/);
  });

  it("does NOT throw when the environment is valid", () => {
    expect(() => runPreflightChecks("sepolia", validEnv())).to.not.throw();
  });

  it("thrown error message states the number of errors found", () => {
    let caught: Error | undefined;
    try {
      runPreflightChecks("sepolia", {});
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught!.message).to.match(/\d+ error/);
  });

  it("does NOT throw on a valid local hardhat environment", () => {
    expect(() =>
      runPreflightChecks("hardhat", {
        RELAYER_PRIVATE_KEY: VALID_KEY,
        V2_STAKE_ASSET: VALID_ADDR,
      })
    ).to.not.throw();
  });
});
