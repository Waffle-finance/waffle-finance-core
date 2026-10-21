/**
 * Tests for the route-identity registry.
 *
 * Covers:
 *   - Registry invariants (ids match parts, legs match the direction map)
 *   - Route-map change detection (the declared id set is pinned)
 *   - Stable serialisation: formatRouteId / parseRouteId round-trips
 *   - Supported-route resolution, including per-network availability
 *   - Unknown-route rejection: every reason code, via all three entry points
 *   - Route identity of orders and history records (routeIdForOrder, sameRoute)
 *   - Coordinator validation consuming the registry rather than its own tables
 */

import { describe, it, expect } from "vitest";
import {
  BRIDGE_MODES,
  DEFAULT_BRIDGE_MODE,
  LIVE_DIRECTION_CHAINS,
  LIVE_ROUTE_DIRECTIONS,
  QUOTE_MODELS,
  ROUTE_CHAIN_DIRECTIONS,
  ROUTE_DIRECTIONS,
  ROUTE_IDS,
  ROUTE_REGISTRY,
  SUPPORTED_CHAINS,
  TOKEN_GROUPS,
  UnknownRouteError,
  assertSupportedRoute,
  chainsForDirection,
  directionForChains,
  formatRouteId,
  getRoute,
  isLiveDirection,
  isRouteId,
  isRouteOnNetwork,
  isSupportedRoute,
  listRoutes,
  listRoutesForNetwork,
  networksForRoute,
  parseRouteId,
  resolveRoute,
  routeIdForOrder,
  sameRoute,
  tokenGroupForAsset,
} from "../src/routes/index.js";
import type { RouteId, RouteIdentitySource } from "../src/routes/index.js";
import {
  DIRECTION_CHAINS,
  SUPPORTED_DIRECTIONS,
  validateAnnounceRequest,
} from "../src/coordinator/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const NATIVE_SOL = "So11111111111111111111111111111111111111112";
const ETH_USDC = "0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b";
const XLM_USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SOL_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function order(
  direction: string,
  srcChain: string,
  srcAsset: string,
  dstChain: string,
  dstAsset: string,
): RouteIdentitySource {
  return {
    direction,
    src: { chain: srcChain, asset: srcAsset },
    dst: { chain: dstChain, asset: dstAsset },
  };
}

// ── Registry invariants ──────────────────────────────────────────────────────

describe("route registry invariants", () => {
  it("declares an id that matches its own components", () => {
    for (const route of ROUTE_REGISTRY) {
      expect(route.id).toBe(
        formatRouteId({
          direction: route.direction,
          tokenGroup: route.tokenGroup,
          bridgeMode: route.bridgeMode,
        }),
      );
    }
  });

  it("declares legs that match the direction map", () => {
    for (const route of ROUTE_REGISTRY) {
      const chains = ROUTE_CHAIN_DIRECTIONS[route.direction];
      expect(route.src).toBe(chains.src);
      expect(route.dst).toBe(chains.dst);
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(ROUTE_IDS).size).toBe(ROUTE_IDS.length);
  });

  it("uses only declared slugs on every axis", () => {
    for (const route of ROUTE_REGISTRY) {
      expect(ROUTE_DIRECTIONS).toContain(route.direction);
      expect(TOKEN_GROUPS).toContain(route.tokenGroup);
      expect(BRIDGE_MODES).toContain(route.bridgeMode);
      expect(QUOTE_MODELS).toContain(route.quoteModel);
    }
  });

  it("gives live routes at least one network and planned routes none", () => {
    for (const route of ROUTE_REGISTRY) {
      if (route.status === "live") {
        expect(route.networks.length).toBeGreaterThan(0);
      } else {
        expect(route.networks).toEqual([]);
      }
    }
  });

  it("derives SUPPORTED_CHAINS from the direction map", () => {
    expect([...SUPPORTED_CHAINS].sort()).toEqual(["ethereum", "solana", "stellar"]);
  });

  it("keeps LIVE_DIRECTION_CHAINS a subset of ROUTE_CHAIN_DIRECTIONS", () => {
    for (const direction of LIVE_ROUTE_DIRECTIONS) {
      expect(LIVE_DIRECTION_CHAINS[direction]).toEqual(ROUTE_CHAIN_DIRECTIONS[direction]);
    }
  });

  it("only ever groups mapped non-native assets as usdc", () => {
    // tokenGroupForAsset returns "usdc" for anything mapped and non-native.
    // Adding a second non-native group means teaching it to read the asset's
    // symbol first — this assertion is the tripwire for that.
    expect(TOKEN_GROUPS.filter((g) => g !== "native")).toEqual(["usdc"]);
  });
});

// ── Route-map change detection ───────────────────────────────────────────────

describe("route map", () => {
  it("declares exactly the expected route ids", () => {
    // Adding, removing, or renaming a route must be a deliberate edit here.
    expect([...ROUTE_IDS]).toEqual([
      "eth_to_xlm:native:wafflefinance-htlc",
      "eth_to_xlm:usdc:wafflefinance-htlc",
      "xlm_to_eth:native:wafflefinance-htlc",
      "xlm_to_eth:usdc:wafflefinance-htlc",
      "eth_to_sol:native:wafflefinance-htlc",
      "eth_to_sol:usdc:wafflefinance-htlc",
      "sol_to_eth:native:wafflefinance-htlc",
      "sol_to_eth:usdc:wafflefinance-htlc",
      "xlm_to_sol:native:wafflefinance-htlc",
      "sol_to_xlm:native:wafflefinance-htlc",
    ]);
  });

  it("lists native routes on both networks and USDC routes on testnet only", () => {
    expect(listRoutesForNetwork("testnet").map((r) => r.id)).toEqual(
      ROUTE_REGISTRY.filter((r) => r.status === "live").map((r) => r.id),
    );
    expect(listRoutesForNetwork("mainnet").every((r) => r.tokenGroup === "native")).toBe(true);
  });

  it("filters by any axis", () => {
    expect(listRoutes({ direction: "eth_to_xlm" }).map((r) => r.tokenGroup)).toEqual([
      "native",
      "usdc",
    ]);
    expect(listRoutes({ status: "planned" }).map((r) => r.direction)).toEqual([
      "xlm_to_sol",
      "sol_to_xlm",
    ]);
    expect(listRoutes({ bridgeMode: "cctp-v2" })).toEqual([]);
  });
});

// ── Serialisation ────────────────────────────────────────────────────────────

describe("route id serialisation", () => {
  it("round-trips every declared route", () => {
    for (const route of ROUTE_REGISTRY) {
      const parts = parseRouteId(route.id);
      expect(parts).not.toBeNull();
      expect(parts).toEqual({
        direction: route.direction,
        tokenGroup: route.tokenGroup,
        bridgeMode: route.bridgeMode,
      });
      expect(formatRouteId(parts!)).toBe(route.id);
    }
  });

  it("is stable and comparable with ===", () => {
    const a = formatRouteId({
      direction: "eth_to_xlm",
      tokenGroup: "usdc",
      bridgeMode: "wafflefinance-htlc",
    });
    const b = formatRouteId({
      direction: "eth_to_xlm",
      tokenGroup: "usdc",
      bridgeMode: "wafflefinance-htlc",
    });
    expect(a).toBe(b);
    expect(a).toBe("eth_to_xlm:usdc:wafflefinance-htlc");
  });

  it("rejects malformed ids", () => {
    for (const bad of [
      "",
      "eth_to_xlm",
      "eth_to_xlm:native",
      "eth_to_xlm:native:wafflefinance-htlc:extra",
      "eth_to_xlm/native/wafflefinance-htlc",
      "ETH_TO_XLM:native:wafflefinance-htlc",
      " eth_to_xlm:native:wafflefinance-htlc",
    ]) {
      expect(parseRouteId(bad)).toBeNull();
      expect(isRouteId(bad)).toBe(false);
    }
  });

  it("rejects ids naming undeclared slugs", () => {
    expect(parseRouteId("eth_to_btc:native:wafflefinance-htlc")).toBeNull();
    expect(parseRouteId("eth_to_xlm:wbtc:wafflefinance-htlc")).toBeNull();
    expect(parseRouteId("eth_to_xlm:native:hop-protocol")).toBeNull();
  });

  it("parses declared-but-planned combinations without asserting support", () => {
    // Parsing is a syntax check; support is a registry question.
    expect(parseRouteId("xlm_to_sol:native:wafflefinance-htlc")).not.toBeNull();
    expect(isSupportedRoute({ direction: "xlm_to_sol" })).toBe(false);
  });

  it("only accepts non-string values as non-ids", () => {
    for (const bad of [null, undefined, 42, {}, ["eth_to_xlm:native:wafflefinance-htlc"]]) {
      expect(isRouteId(bad)).toBe(false);
    }
  });
});

// ── Supported routes ─────────────────────────────────────────────────────────

describe("supported route resolution", () => {
  it("resolves every live route by selector", () => {
    for (const route of listRoutes({ status: "live" })) {
      const result = resolveRoute({
        direction: route.direction,
        tokenGroup: route.tokenGroup,
        bridgeMode: route.bridgeMode,
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.route.id).toBe(route.id);
    }
  });

  it("defaults tokenGroup to native and bridgeMode to the HTLC engine", () => {
    const resolved = assertSupportedRoute({ direction: "eth_to_xlm" });
    expect(resolved.id).toBe("eth_to_xlm:native:wafflefinance-htlc");
    expect(resolved.tokenGroup).toBe("native");
    expect(resolved.bridgeMode).toBe(DEFAULT_BRIDGE_MODE);
  });

  it("resolves by id and exposes quote model and networks", () => {
    const route = getRoute("sol_to_eth:native:wafflefinance-htlc");
    expect(route?.quoteModel).toBe("atomic-htlc");
    expect(route?.src).toBe("solana");
    expect(route?.dst).toBe("ethereum");
    expect(networksForRoute(route!.id)).toEqual(["testnet", "mainnet"]);
  });

  it("honours per-network availability", () => {
    expect(isSupportedRoute({ direction: "eth_to_xlm", tokenGroup: "usdc", network: "testnet" }))
      .toBe(true);
    expect(isSupportedRoute({ direction: "eth_to_xlm", tokenGroup: "usdc", network: "mainnet" }))
      .toBe(false);
    expect(isRouteOnNetwork("eth_to_xlm:usdc:wafflefinance-htlc", "mainnet")).toBe(false);
    expect(isRouteOnNetwork("eth_to_xlm:native:wafflefinance-htlc", "mainnet")).toBe(true);
  });

  it("maps chains to directions and back", () => {
    expect(directionForChains("ethereum", "stellar")).toBe("eth_to_xlm");
    expect(directionForChains("solana", "stellar")).toBe("sol_to_xlm");
    expect(directionForChains("ethereum", "ethereum")).toBeNull();
    expect(directionForChains("bitcoin", "stellar")).toBeNull();
    expect(chainsForDirection("sol_to_eth")).toEqual({ src: "solana", dst: "ethereum" });
    expect(chainsForDirection("eth_to_btc")).toBeNull();
  });

  it("recognises live directions only", () => {
    for (const direction of LIVE_ROUTE_DIRECTIONS) {
      expect(isLiveDirection(direction)).toBe(true);
    }
    expect(isLiveDirection("xlm_to_sol")).toBe(false);
    expect(isLiveDirection("nonsense")).toBe(false);
    expect(isLiveDirection(undefined)).toBe(false);
  });
});

// ── Unknown-route rejection ──────────────────────────────────────────────────

describe("unknown-route rejection", () => {
  const cases: Array<{
    name: string;
    selector: Parameters<typeof resolveRoute>[0];
    reason: string;
  }> = [
    {
      name: "undeclared direction",
      selector: { direction: "eth_to_btc" },
      reason: "malformed_route_id",
    },
    {
      name: "undeclared token group",
      selector: { direction: "eth_to_xlm", tokenGroup: "wbtc" },
      reason: "malformed_route_id",
    },
    {
      name: "undeclared bridge mode",
      selector: { direction: "eth_to_xlm", bridgeMode: "hop-protocol" },
      reason: "malformed_route_id",
    },
    {
      name: "declared axes with no registry entry",
      selector: { direction: "xlm_to_sol", tokenGroup: "usdc" },
      reason: "unknown_route",
    },
    {
      name: "reserved bridge mode with no adapter",
      selector: { direction: "eth_to_xlm", bridgeMode: "cctp-v2" },
      reason: "unknown_route",
    },
    {
      name: "declared but planned route",
      selector: { direction: "xlm_to_sol" },
      reason: "route_not_live",
    },
    {
      name: "live route on the wrong network",
      selector: { direction: "sol_to_eth", tokenGroup: "usdc", network: "mainnet" },
      reason: "route_not_on_network",
    },
  ];

  for (const { name, selector, reason } of cases) {
    it(`rejects ${name} with reason ${reason}`, () => {
      const result = resolveRoute(selector);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe(reason);
    });

    it(`rejects ${name} consistently across entry points`, () => {
      expect(isSupportedRoute(selector)).toBe(false);
      expect(() => assertSupportedRoute(selector)).toThrow(UnknownRouteError);
    });
  }

  it("reports the reason and route on the thrown error", () => {
    try {
      assertSupportedRoute({ direction: "xlm_to_sol" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRouteError);
      const routeErr = err as UnknownRouteError;
      expect(routeErr.name).toBe("UnknownRouteError");
      expect(routeErr.reason).toBe("route_not_live");
      expect(routeErr.route).toBe("xlm_to_sol:native:wafflefinance-htlc");
      expect(routeErr.message).toContain("route_not_live");
    }
  });

  // #895: an unsupported route must fail deterministically with the specific
  // UnknownRouteError reason *and* still let the caller discover what IS
  // supported via listRoutes()/getRoute() metadata, rather than surfacing a
  // generic/RPC-looking failure.
  it.each([
    { name: "planned but not-yet-live direction (xlm_to_sol)", selector: { direction: "xlm_to_sol" }, reason: "route_not_live" },
    { name: "planned but not-yet-live direction (sol_to_xlm)", selector: { direction: "sol_to_xlm" }, reason: "route_not_live" },
    { name: "live route requested off its enabled network", selector: { direction: "sol_to_eth", tokenGroup: "usdc", network: "mainnet" }, reason: "route_not_on_network" },
  ])("surfaces supported-route metadata alongside the $reason failure for $name", ({ selector, reason }) => {
    expect(() => assertSupportedRoute(selector)).toThrow(UnknownRouteError);
    try {
      assertSupportedRoute(selector);
    } catch (err) {
      expect((err as UnknownRouteError).reason).toBe(reason);
    }
    // The registry still knows about the route (metadata is discoverable)
    // even though it cannot be used right now — this is what distinguishes
    // "unsupported route" from "malformed RPC/address input", which never
    // appears in the registry at all.
    const declared = listRoutes({ direction: selector.direction as any });
    expect(declared.length).toBeGreaterThan(0);
  });

  it("returns undefined from getRoute for undeclared ids", () => {
    expect(getRoute("eth_to_btc:native:wafflefinance-htlc")).toBeUndefined();
    expect(getRoute("not-a-route-id")).toBeUndefined();
  });
});

// ── Token groups ─────────────────────────────────────────────────────────────

describe("token group resolution", () => {
  it("recognises native assets on both legs", () => {
    expect(tokenGroupForAsset("eth_to_xlm", "src", NATIVE_ETH)).toBe("native");
    expect(tokenGroupForAsset("eth_to_xlm", "dst", "XLM")).toBe("native");
    expect(tokenGroupForAsset("sol_to_eth", "src", NATIVE_SOL)).toBe("native");
    expect(tokenGroupForAsset("sol_to_eth", "dst", NATIVE_ETH)).toBe("native");
  });

  it("recognises mapped USDC on both legs", () => {
    expect(tokenGroupForAsset("eth_to_xlm", "src", ETH_USDC)).toBe("usdc");
    expect(tokenGroupForAsset("eth_to_xlm", "dst", XLM_USDC)).toBe("usdc");
    expect(tokenGroupForAsset("eth_to_sol", "dst", SOL_USDC)).toBe("usdc");
    expect(tokenGroupForAsset("sol_to_eth", "src", SOL_USDC)).toBe("usdc");
  });

  it("normalises before lookup", () => {
    expect(tokenGroupForAsset("eth_to_xlm", "src", ETH_USDC.toUpperCase().replace("0X", "0x")))
      .toBe("usdc");
    expect(tokenGroupForAsset("eth_to_xlm", "dst", ` ${XLM_USDC} `)).toBe("usdc");
  });

  it("returns null for unmapped assets, unknown directions, and unmapped networks", () => {
    expect(tokenGroupForAsset("eth_to_xlm", "src", "0x" + "9".repeat(40))).toBeNull();
    expect(tokenGroupForAsset("eth_to_btc", "src", NATIVE_ETH)).toBeNull();
    expect(tokenGroupForAsset("eth_to_xlm", "src", ETH_USDC, "mainnet")).toBeNull();
    expect(tokenGroupForAsset("xlm_to_sol", "src", XLM_USDC)).toBeNull();
  });
});

// ── Route identity of orders and history records ──────────────────────────────

describe("route identity of orders", () => {
  it("derives the route id of a native order", () => {
    expect(routeIdForOrder(order("eth_to_xlm", "ethereum", NATIVE_ETH, "stellar", "XLM"))).toBe(
      "eth_to_xlm:native:wafflefinance-htlc",
    );
  });

  it("derives the route id of a USDC order", () => {
    expect(routeIdForOrder(order("sol_to_eth", "solana", SOL_USDC, "ethereum", ETH_USDC))).toBe(
      "sol_to_eth:usdc:wafflefinance-htlc",
    );
  });

  it("produces an id that resolves back to a registry entry", () => {
    const id = routeIdForOrder(order("eth_to_sol", "ethereum", ETH_USDC, "solana", SOL_USDC));
    expect(getRoute(id as RouteId)?.tokenGroup).toBe("usdc");
  });

  it("returns null when the legs contradict the direction", () => {
    expect(routeIdForOrder(order("eth_to_xlm", "solana", NATIVE_SOL, "stellar", "XLM"))).toBeNull();
    expect(routeIdForOrder(order("eth_to_xlm", "ethereum", NATIVE_ETH, "solana", NATIVE_SOL)))
      .toBeNull();
  });

  it("returns null for unroutable assets and unknown directions", () => {
    expect(routeIdForOrder(order("eth_to_xlm", "ethereum", "0x" + "7".repeat(40), "stellar", "XLM")))
      .toBeNull();
    expect(routeIdForOrder(order("eth_to_btc", "ethereum", NATIVE_ETH, "bitcoin", "BTC")))
      .toBeNull();
  });

  it("is network-aware", () => {
    const usdcOrder = order("eth_to_xlm", "ethereum", ETH_USDC, "stellar", XLM_USDC);
    expect(routeIdForOrder(usdcOrder, "testnet")).toBe("eth_to_xlm:usdc:wafflefinance-htlc");
    expect(routeIdForOrder(usdcOrder, "mainnet")).toBeNull();
  });

  it("compares a request payload against a stored history record", () => {
    // Same route, different amounts/addresses/casing — the fields that are not
    // part of route identity must not affect the comparison.
    const request = order("eth_to_xlm", "ethereum", ETH_USDC.toUpperCase().replace("0X", "0x"),
      "stellar", XLM_USDC);
    const stored = order("eth_to_xlm", "ethereum", ETH_USDC, "stellar", XLM_USDC);
    expect(sameRoute(request, stored)).toBe(true);
  });

  it("does not treat different token groups or directions as the same route", () => {
    const native = order("eth_to_xlm", "ethereum", NATIVE_ETH, "stellar", "XLM");
    const usdc = order("eth_to_xlm", "ethereum", ETH_USDC, "stellar", XLM_USDC);
    const reverse = order("xlm_to_eth", "stellar", "XLM", "ethereum", NATIVE_ETH);
    expect(sameRoute(native, usdc)).toBe(false);
    expect(sameRoute(native, reverse)).toBe(false);
  });

  it("never reports two unresolvable records as the same route", () => {
    const bogus = order("eth_to_btc", "ethereum", NATIVE_ETH, "bitcoin", "BTC");
    expect(sameRoute(bogus, bogus)).toBe(false);
  });
});

// ── Coordinator validation now reads the registry ────────────────────────────

describe("coordinator validation via the registry", () => {
  it("re-exports the registry tables rather than keeping its own", () => {
    expect(DIRECTION_CHAINS).toBe(LIVE_DIRECTION_CHAINS);
    expect(SUPPORTED_DIRECTIONS).toBe(LIVE_ROUTE_DIRECTIONS);
  });

  it("rejects a direction that is declared but not live", () => {
    const result = validateAnnounceRequest({
      direction: "xlm_to_sol",
      hashlock: "0x" + "ab".repeat(32),
      srcChain: "stellar",
      srcAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
      srcAsset: "XLM",
      srcAmount: "1000",
      srcSafetyDeposit: "10",
      dstChain: "solana",
      dstAddress: "11111111111111111111111111111111",
      dstAsset: NATIVE_SOL,
      dstAmount: "1000",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "direction")).toBe(true);
  });
});
