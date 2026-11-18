/**
 * Tests for the asset-metadata, RPC-payload, persisted-storage and
 * route-param guards (#733).
 *
 * Grouped by the trust boundary each one closes:
 *
 *   • asset metadata handed over by a caller or a deep link — the loose
 *     `CanonicalStellarAsset` / `CanonicalSolanaAsset` types say nothing
 *     about asset codes, issuers, decimals, or whether a symbol matches its
 *     mint;
 *   • chain RPC replies — EVM logs, Solana account info, Soroban simulations,
 *     JSON-RPC envelopes;
 *   • `localStorage` caches and environment configuration, neither of which
 *     the SDK reads itself but both of which it defines the shape of;
 *   • deep-link query parameters, where a `RouteId` template-literal type
 *     gives a producer all the help and a consumer none.
 */

import { describe, it, expect } from 'vitest';

import { GuardError } from '../src/guards/result.js';
import {
  NATIVE_ASSET_DECIMALS,
  assertAssetMetadata,
  nativeAssetMetadata,
  nativePlaceholderFor,
  solanaAssetMetadata,
  stellarAssetMetadata,
  validateAssetMetadata,
  validateCanonicalId,
} from '../src/guards/asset-metadata.js';
import {
  assertEvmLog,
  assertJsonRpcReply,
  assertSolanaAccountInfo,
  assertSorobanSimulation,
  decodeSorobanRetval,
  validateEvmLog,
  validateJsonRpcReply,
  validateSolanaAccountInfo,
  validateSolanaAccountInfoList,
  validateSorobanSimulation,
} from '../src/guards/rpc-payload.js';
import {
  assertCoordinatorEnvConfig,
  assertPersistedHistoryPage,
  validateCoordinatorBaseUrl,
  validateCoordinatorEnvConfig,
  validatePersistedHistoryPage,
} from '../src/guards/persisted.js';
import {
  assertOrderParam,
  assertRouteLink,
  assertRouteParam,
  fromQueryString,
  fromSearchParams,
  validateAddressParam,
  validateOrderParam,
  validateRouteLink,
  validateRouteParam,
} from '../src/guards/route-params.js';
import { xdr, scValToNative } from '@stellar/stellar-sdk';

import { NATIVE_ETH_ADDRESS, NATIVE_SOL_MINT, NATIVE_STELLAR_ASSET } from '../src/assets/index.js';
import { ETH_DST, ETH_SRC, SOL_SRC, XLM_SRC, PAIR_ETH_TO_XLM } from '../src/fixtures/identities.js';
import { SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE, SOL_HTLC_PROGRAM_ID } from '../src/fixtures/index.js';
import {
  SOROBAN_SIM_RESPONSE_ERROR,
  SOROBAN_SIM_RESPONSE_FUNDED,
} from '../src/fixtures/soroban-wire.js';
import { HISTORY_PAGE_MIXED } from '../src/fixtures/coordinator-flows.js';
import { toHistoryRecord } from '../src/coordinator/history-client.js';

/** A cache page built from real `HistoryRecord`s, as a frontend would store it. */
interface CachedPage {
  transactions: Array<Record<string, unknown>>;
  nextCursor: string | null;
  fetchedAt: number;
}

function cachedPage(transactions: ReadonlyArray<Record<string, unknown>>): CachedPage {
  return {
    transactions: transactions.map(record => toHistoryRecord(record as never)) as unknown as Array<
      Record<string, unknown>
    >,
    nextCursor: null,
    fetchedAt: 1_800_000_000,
  };
}

function issues(result: { ok: boolean; issues?: readonly { field: string }[] }): string[] {
  return result.ok || !result.issues ? [] : result.issues.map(i => i.field);
}

function messages(result: { ok: boolean; issues?: readonly { message: string }[] }): string[] {
  return result.ok || !result.issues ? [] : result.issues.map(i => i.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('validateAssetMetadata', () => {
  const ethUsdc = {
    chain: 'ethereum',
    kind: 'contract',
    symbol: 'USDC',
    decimals: 6,
    address: '0x4C5051f375eE88D5b7681a18CF0F0E793c4B9479',
    issuer: null,
    networks: ['testnet'],
  };

  it('accepts a well-formed contract asset', () => {
    expect(validateAssetMetadata(ethUsdc).ok).toBe(true);
  });

  it('accepts every chain-native asset the SDK defines', () => {
    for (const chain of ['ethereum', 'stellar', 'solana'] as const) {
      const result = nativeAssetMetadata(chain, ['testnet', 'mainnet']);
      expect(result.ok, chain).toBe(true);
      if (!result.ok) continue;
      expect(result.value.symbol).toBe(
        chain === 'ethereum' ? 'ETH' : chain === 'stellar' ? 'XLM' : 'SOL'
      );
      expect(result.value.decimals).toBe(NATIVE_ASSET_DECIMALS[chain]);
      expect(result.value.kind).toBe('native');
    }
  });

  it('rejects a non-object', () => {
    for (const value of [null, undefined, 'USDC', 42, []]) {
      expect(validateAssetMetadata(value).ok).toBe(false);
    }
  });

  it('rejects an unknown chain', () => {
    const result = validateAssetMetadata({ ...ethUsdc, chain: 'bitcoin' });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('asset.chain');
  });

  it('rejects an unknown kind', () => {
    const result = validateAssetMetadata({ ...ethUsdc, kind: 'wrapped' });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('asset.kind');
  });

  it('rejects a lower-case or over-long symbol', () => {
    expect(validateAssetMetadata({ ...ethUsdc, symbol: 'usdc' }).ok).toBe(false);
    expect(validateAssetMetadata({ ...ethUsdc, symbol: 'USDCX' }).ok).toBe(true);
    expect(validateAssetMetadata({ ...ethUsdc, symbol: 'USDC COIN' }).ok).toBe(false);
    expect(validateAssetMetadata({ ...ethUsdc, symbol: 'A'.repeat(11) }).ok).toBe(false);
  });

  it('rejects a null decimals on a contract asset', () => {
    // The important omission in the loose types: a contract asset with no
    // stated decimals cannot be rendered by a UI without guessing, and a
    // wrong guess is a wrong balance.
    const result = validateAssetMetadata({ ...ethUsdc, decimals: null });
    expect(result.ok).toBe(false);
    expect(
      messages(result).some(m => m.includes('null here is only valid for a chain-native'))
    ).toBe(true);
  });

  it('rejects out-of-range decimals', () => {
    for (const decimals of [-1, 37, 1.5, '6', Number.NaN]) {
      expect(validateAssetMetadata({ ...ethUsdc, decimals }).ok, String(decimals)).toBe(false);
    }
  });

  it('rejects a native asset that does not use the chain placeholder', () => {
    const result = validateAssetMetadata({
      chain: 'ethereum',
      kind: 'native',
      symbol: 'ETH',
      decimals: 18,
      address: ETH_DST,
      issuer: null,
      networks: ['mainnet'],
    });
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('placeholder address'))).toBe(true);
  });

  it('rejects a contract asset that does use the native placeholder', () => {
    const result = validateAssetMetadata({ ...ethUsdc, address: NATIVE_ETH_ADDRESS });
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('must not use the native placeholder'))).toBe(
      true
    );
  });

  it('accepts the all-zero address as a native placeholder even though it is rejected as a counterparty', () => {
    // `parseChainAddress` rejects the zero address on purpose — it cannot be
    // a swap counterparty. An asset id is a different question, so the
    // placeholder is handled explicitly rather than by loosening the counterparty
    // rule.
    expect(
      validateAssetMetadata({
        ...ethUsdc,
        kind: 'native',
        address: NATIVE_ETH_ADDRESS,
        decimals: 18,
      }).ok
    ).toBe(true);
  });

  it('rejects an address of the wrong chain', () => {
    expect(validateAssetMetadata({ ...ethUsdc, address: XLM_SRC }).ok).toBe(false);
  });

  it('rejects an issuer on a non-Stellar asset', () => {
    const result = validateAssetMetadata({ ...ethUsdc, issuer: XLM_SRC });
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('only a Stellar asset has an issuer'))).toBe(true);
  });

  it('rejects a malformed issuer address', () => {
    const result = validateAssetMetadata({
      chain: 'stellar',
      kind: 'contract',
      symbol: 'USDC',
      decimals: 7,
      address: XLM_SRC,
      issuer: 'not-a-stellar-address',
      networks: ['testnet'],
    });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('asset.issuer');
  });

  it('rejects an empty or unknown network list', () => {
    expect(validateAssetMetadata({ ...ethUsdc, networks: [] }).ok).toBe(false);
    expect(validateAssetMetadata({ ...ethUsdc, networks: ['devnet'] }).ok).toBe(false);
    expect(validateAssetMetadata({ ...ethUsdc, networks: 'testnet' }).ok).toBe(false);
  });

  it('reports several problems in one pass', () => {
    const result = validateAssetMetadata({
      chain: 'bitcoin',
      kind: 'wrapped',
      symbol: 'usdc',
      decimals: null,
      address: 42,
      issuer: null,
      networks: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(5);
  });

  it('assertAssetMetadata returns a narrowed AssetMetadata', () => {
    const metadata = assertAssetMetadata(ethUsdc);
    expect(metadata.symbol).toBe('USDC');
    expect(metadata.decimals).toBe(6);
    expect(() => assertAssetMetadata({ ...ethUsdc, decimals: null })).toThrow(GuardError);
  });
});

describe('stellarAssetMetadata', () => {
  it("maps native XLM through the SDK's own constant", () => {
    const result = stellarAssetMetadata(NATIVE_STELLAR_ASSET, ['testnet']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('native');
    expect(result.value.symbol).toBe('XLM');
    expect(result.value.issuer).toBeNull();
  });

  it('accepts a CODE:ISSUER key', () => {
    const result = stellarAssetMetadata(`USDC:${XLM_SRC}`, ['testnet']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol).toBe('USDC');
    expect(result.value.issuer).toBe(XLM_SRC);
  });

  it('rejects an issued asset with no issuer — a different asset entirely', () => {
    // `{ code: "USDC" }` type-checks against `CanonicalStellarAsset` and
    // names something that does not exist on the ledger.
    const result = stellarAssetMetadata({ code: 'USDC' }, ['testnet']);
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('no issuer'))).toBe(true);
  });

  it('rejects an illegal Stellar asset code', () => {
    for (const code of ['usdc', 'TOOLONG', 'US DC', '']) {
      const result = stellarAssetMetadata(`${code}:${XLM_SRC}`, ['testnet']);
      expect(result.ok, `accepted code "${code}"`).toBe(false);
    }
  });
});

describe('solanaAssetMetadata', () => {
  it("maps native SOL through the SDK's own constant", () => {
    const result = solanaAssetMetadata({ mint: NATIVE_SOL_MINT, symbol: 'SOL' }, ['testnet']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('native');
    expect(result.value.decimals).toBe(9);
  });

  it('demands decimals for an SPL mint, because only the chain knows them', () => {
    const result = solanaAssetMetadata({ mint: SOL_SRC, symbol: 'USDC' }, ['testnet']);
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('read them from the mint account'))).toBe(true);
  });

  it('accepts an SPL mint once decimals are supplied', () => {
    const result = solanaAssetMetadata({ mint: SOL_SRC, symbol: 'USDC' }, ['testnet'], 6);
    expect(result.ok).toBe(true);
  });

  it('rejects a malformed symbol', () => {
    const result = solanaAssetMetadata({ mint: SOL_SRC, symbol: 'usd c' }, ['testnet'], 6);
    expect(result.ok).toBe(false);
  });
});

describe('validateCanonicalId', () => {
  it("agrees with toCanonicalId for the SDK's own native assets", () => {
    for (const chain of ['ethereum', 'stellar', 'solana'] as const) {
      const metadata = nativeAssetMetadata(chain, ['testnet']);
      expect(metadata.ok).toBe(true);
      if (!metadata.ok) continue;
      const canonical = validateCanonicalId(metadata.value);
      expect(canonical.ok, chain).toBe(true);
      if (canonical.ok) {
        expect(canonical.value).toBe(
          `${chain}:native:${chain === 'ethereum' ? 'ETH' : chain === 'stellar' ? 'XLM' : 'SOL'}`
        );
      }
    }
  });

  it('rejects a hand-built native descriptor that disagrees with the SDK constant', () => {
    const forged = {
      chain: 'ethereum' as const,
      kind: 'native' as const,
      symbol: 'WETH',
      decimals: 18,
      address: NATIVE_ETH_ADDRESS as never,
      issuer: null,
      networks: ['mainnet'] as const,
    };
    // Shape is valid …
    expect(validateAssetMetadata(forged).ok).toBe(true);
    // … but the canonical id is not the one the route registry will move.
    const canonical = validateCanonicalId(forged as never);
    expect(canonical.ok).toBe(false);
  });

  it('nativePlaceholderFor covers all three chains', () => {
    expect(nativePlaceholderFor('ethereum')).toBe(NATIVE_ETH_ADDRESS);
    expect(nativePlaceholderFor('solana')).toBe(NATIVE_SOL_MINT);
    expect(nativePlaceholderFor('stellar')).toHaveLength(56);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RPC payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('validateJsonRpcReply', () => {
  it('accepts a success envelope', () => {
    const result = validateJsonRpcReply({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.isError) return;
    expect(result.value.result).toEqual({ ok: true });
  });

  it('accepts a null result, which is legal JSON-RPC', () => {
    const result = validateJsonRpcReply({ jsonrpc: '2.0', id: 1, result: null });
    expect(result.ok).toBe(true);
  });

  it('classifies an error envelope through the existing rpc-compat taxonomy', () => {
    const result = validateJsonRpcReply({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32097, message: 'rate limit exceeded' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.isError) return;
    expect(result.value.classified.category).toBe('rate_limited');
    expect(result.value.classified.retryable).toBe(true);
  });

  it('rejects a non-2.0 jsonrpc version', () => {
    // A proxy that downgrades the envelope, or a plain REST reply that
    // happens to have a `result` key.
    const result = validateJsonRpcReply({ jsonrpc: '1.0', id: 1, result: {} });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('rpc.jsonrpc');
  });

  it('rejects a reply with neither result nor error', () => {
    const result = validateJsonRpcReply({ jsonrpc: '2.0', id: 1 });
    expect(result.ok).toBe(false);
  });

  it('rejects a reply carrying both', () => {
    const result = validateJsonRpcReply({
      jsonrpc: '2.0',
      id: 1,
      result: {},
      error: { code: -1, message: 'x' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object reply', () => {
    for (const value of [null, undefined, 'ok', 42, []]) {
      expect(validateJsonRpcReply(value).ok).toBe(false);
    }
  });

  it('rejects a malformed error member', () => {
    expect(validateJsonRpcReply({ jsonrpc: '2.0', id: 1, error: 'boom' }).ok).toBe(false);
    expect(validateJsonRpcReply({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }).ok).toBe(
      false
    );
  });

  it('rejects an id that is neither number, string, nor null', () => {
    expect(validateJsonRpcReply({ jsonrpc: '2.0', id: {}, result: 1 }).ok).toBe(false);
  });

  it('assertJsonRpcReply throws on a malformed envelope', () => {
    expect(() => assertJsonRpcReply({ result: 1 })).toThrow(GuardError);
  });
});

describe('validateEvmLog', () => {
  const log = {
    address: ETH_SRC,
    topics: ['0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32)],
    data: '0x',
    blockNumber: '0x1406f40',
    blockHash: '0x' + 'ef'.repeat(32),
    transactionHash: '0x' + '12'.repeat(32),
    logIndex: '0x3',
    removed: false,
  };

  it('accepts a standard entry', () => {
    expect(validateEvmLog(log).ok).toBe(true);
  });

  it('accepts removed: true, which is how a reorg is signalled', () => {
    expect(validateEvmLog({ ...log, removed: true }).ok).toBe(true);
  });

  it('accepts a pending log with null block fields', () => {
    expect(validateEvmLog({ ...log, blockNumber: null, blockHash: null }).ok).toBe(true);
  });

  it('accepts a numeric logIndex, as some providers return', () => {
    expect(validateEvmLog({ ...log, logIndex: 3 }).ok).toBe(true);
  });

  it('rejects a malformed address, topic, data, or transaction hash', () => {
    expect(validateEvmLog({ ...log, address: '0x1234' }).ok).toBe(false);
    expect(validateEvmLog({ ...log, topics: ['0xzz'] }).ok).toBe(false);
    expect(validateEvmLog({ ...log, topics: 'not-an-array' }).ok).toBe(false);
    expect(validateEvmLog({ ...log, data: 'abc' }).ok).toBe(false);
    // Odd-length hex is the classic truncation.
    expect(validateEvmLog({ ...log, data: '0xabc' }).ok).toBe(false);
    expect(validateEvmLog({ ...log, transactionHash: '0xdeadbeef' }).ok).toBe(false);
  });

  it('rejects a non-boolean removed', () => {
    expect(validateEvmLog({ ...log, removed: 'false' }).ok).toBe(false);
  });

  it('assertEvmLog returns a narrowed EvmLog', () => {
    expect(assertEvmLog(log).address).toBe(ETH_SRC);
    expect(() => assertEvmLog({ ...log, address: 'nope' })).toThrow(GuardError);
  });
});

describe('validateSolanaAccountInfo', () => {
  const info = {
    executable: false,
    owner: SOL_HTLC_PROGRAM_ID,
    data: SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
    lamports: 2_010_000_000,
    rentEpoch: 361,
  };

  it('accepts a byte-array payload', () => {
    const result = validateSolanaAccountInfo(info);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toHaveLength(227);
  });

  it('accepts a JSON round-tripped numeric array', () => {
    const asArray = JSON.parse(
      JSON.stringify({ ...info, data: [...SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE] })
    );
    const result = validateSolanaAccountInfo(asArray);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toHaveLength(227);
  });

  it('rejects a base64 or hex *string* payload', () => {
    // The bug this check exists for: `Buffer.from("0x00")` produces the two
    // UTF-8 bytes of the string, not the byte the provider meant, so the
    // failure surfaces three frames later as "account data too small".
    expect(validateSolanaAccountInfo({ ...info, data: '0x0011' }).ok).toBe(false);
    expect(
      validateSolanaAccountInfo({ ...info, data: Buffer.from('0x0011').toString('base64') }).ok
    ).toBe(false);
  });

  it('rejects a numeric array with an out-of-range byte', () => {
    expect(validateSolanaAccountInfo({ ...info, data: [256] }).ok).toBe(false);
    expect(validateSolanaAccountInfo({ ...info, data: [-1] }).ok).toBe(false);
  });

  it('rejects a negative or fractional lamports value', () => {
    expect(validateSolanaAccountInfo({ ...info, lamports: -1 }).ok).toBe(false);
    expect(validateSolanaAccountInfo({ ...info, lamports: 1.5 }).ok).toBe(false);
  });

  it('rejects a missing owner or executable flag', () => {
    const { owner, ...noOwner } = info;
    const { executable, ...noExec } = info;
    void owner;
    void executable;
    expect(validateSolanaAccountInfo(noOwner).ok).toBe(false);
    expect(validateSolanaAccountInfo(noExec).ok).toBe(false);
  });

  it('allows unknown extra keys, because providers add fields', () => {
    expect(validateSolanaAccountInfo({ ...info, someNewField: 1 }).ok).toBe(true);
  });

  it('preserves null entries in a list, so "no account" stays distinct from "empty account"', () => {
    const result = validateSolanaAccountInfoList([info, null, info]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value[1]).toBeNull();
    }
  });

  it('rejects a non-array list', () => {
    expect(validateSolanaAccountInfoList({}).ok).toBe(false);
  });

  it('re-roots the path of a bad entry in a list', () => {
    const result = validateSolanaAccountInfoList([info, { ...info, owner: 1 }]);
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('accounts[1].owner');
  });

  it('assertSolanaAccountInfo throws on a string payload', () => {
    expect(() => assertSolanaAccountInfo({ ...info, data: '0x00' })).toThrow(GuardError);
  });
});

describe('validateSorobanSimulation', () => {
  it('accepts the successful fixture', () => {
    const result = validateSorobanSimulation(SOROBAN_SIM_RESPONSE_FUNDED.result);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'SUCCESS') return;
    expect(result.value.retval).toBe(SOROBAN_SIM_RESPONSE_FUNDED.result.retval);
  });

  it('accepts the error fixture and keeps its events', () => {
    const result = validateSorobanSimulation(SOROBAN_SIM_RESPONSE_ERROR.result);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'ERROR') return;
    expect(result.value.error).toContain('OrderNotFound');
  });

  it('rejects an unknown status', () => {
    const result = validateSorobanSimulation({ status: 'MAYBE', retval: 'AA==' });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('sim.status');
  });

  it('rejects a retval that is not base64', () => {
    // `soroban/index.ts` passes `retval` straight to `scValToNative`, which
    // needs an `ScVal`; a non-base64 retval here is the first place that can
    // be caught.
    const result = validateSorobanSimulation({
      ...SOROBAN_SIM_RESPONSE_FUNDED.result,
      retval: 'not base64!!',
    });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('sim.retval');
  });

  it('rejects an empty retval', () => {
    const result = validateSorobanSimulation({ ...SOROBAN_SIM_RESPONSE_FUNDED.result, retval: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a numeric cost where the wire type is a string', () => {
    const result = validateSorobanSimulation({
      ...SOROBAN_SIM_RESPONSE_FUNDED.result,
      cost: { cpuInsns: 1, memBytes: '2' },
    });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('sim.cost.cpuInsns');
  });

  it('rejects an ERROR status with no error string', () => {
    const result = validateSorobanSimulation({ status: 'ERROR', events: [] });
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('sim.error');
  });

  it('assertSorobanSimulation narrows on the status discriminant', () => {
    const sim = assertSorobanSimulation(SOROBAN_SIM_RESPONSE_FUNDED.result);
    if (sim.status === 'SUCCESS') {
      const retval: string = sim.retval;
      expect(typeof retval).toBe('string');
    } else {
      throw new Error('expected SUCCESS');
    }
  });
});

describe('decodeSorobanRetval', () => {
  it('performs the base64 → ScVal → native sequence soroban/index.ts needs', () => {
    const fromXdr = (value: string, format: 'base64') => xdr.ScVal.fromXDR(value, format);
    const decoded = decodeSorobanRetval(
      SOROBAN_SIM_RESPONSE_FUNDED.result.retval,
      fromXdr,
      scValToNative as (v: never) => unknown
    ) as Record<string, unknown>;
    expect(decoded['status']).toBe(0);
    expect(decoded['amount']).toBe(100_000_000n);
  });

  it('throws on a non-base64 retval rather than producing garbage', () => {
    const fromXdr = (value: string, format: 'base64') => xdr.ScVal.fromXDR(value, format);
    expect(() =>
      decodeSorobanRetval('nope!', fromXdr, scValToNative as (v: never) => unknown)
    ).toThrow(/base64 XDR/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persisted storage and environment configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePersistedHistoryPage', () => {
  it('accepts the page a real HistoryClient would persist', () => {
    // Built from the actual `toHistoryRecord` transform rather than by hand,
    // so this is the shape a frontend's localStorage cache really holds.
    const cached = {
      transactions: HISTORY_PAGE_MIXED.transactions.map(toHistoryRecord),
      nextCursor: null,
      fetchedAt: 1_800_000_000,
    };
    expect(validatePersistedHistoryPage(cached).ok).toBe(true);
  });

  it('rejects a cache that is not an object', () => {
    for (const value of [null, undefined, 'page', 42, []]) {
      expect(validatePersistedHistoryPage(value).ok).toBe(false);
    }
  });

  it('rejects a missing or non-array transactions field', () => {
    const base = { nextCursor: null, fetchedAt: 1_800_000_000 };
    expect(validatePersistedHistoryPage(base).ok).toBe(false);
    expect(validatePersistedHistoryPage({ ...base, transactions: {} }).ok).toBe(false);
  });

  it('rejects a record with a malformed id, direction, status, or hashlock', () => {
    const base = cachedPage([
      {
        ...HISTORY_PAGE_MIXED.transactions[0]!,
        src: { ...HISTORY_PAGE_MIXED.transactions[0]!.src },
        dst: { ...HISTORY_PAGE_MIXED.transactions[0]!.dst },
      },
    ]);
    expect(validatePersistedHistoryPage(base).ok).toBe(true);

    for (const [field, value] of [
      ['id', 'order-1'],
      ['direction', 'btc_to_eth'],
      ['status', 'weird'],
      ['hashlock', 'nope'],
    ] as const) {
      const broken = JSON.parse(JSON.stringify(base));
      broken.transactions[0][field] = value;
      const result = validatePersistedHistoryPage(broken);
      expect(result.ok, `${field}="${value}"`).toBe(false);
    }
  });

  it('rejects a leg with a float amount — the token-precision bug', () => {
    const broken = cachedPage([{ ...HISTORY_PAGE_MIXED.transactions[0]! }]);
    (broken.transactions[0]!['src'] as Record<string, unknown>)['amount'] = '1.5';
    const result = validatePersistedHistoryPage(broken);
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('cache.transactions[0].src.amount');
  });

  it('rejects a fetchedAt that is not an absolute timestamp', () => {
    const page = { transactions: [], nextCursor: null, fetchedAt: Date.now() };
    expect(validatePersistedHistoryPage(page).ok).toBe(false);
    expect(
      validatePersistedHistoryPage({ transactions: [], nextCursor: null, fetchedAt: -1 }).ok
    ).toBe(false);
  });

  it('accepts a page where every optional leg field is null or absent', () => {
    // The forward-compatible case: a cache written by an older SDK omits
    // fields the current type considers required, and both `null` (known
    // absent) and an absent key (unknown) are legal here.
    const page = cachedPage([
      {
        ...HISTORY_PAGE_MIXED.transactions[0]!,
        status: 'announced',
        src: {
          chain: 'ethereum',
          address: ETH_SRC,
          asset: 'native',
          amount: '1',
          safetyDeposit: null,
          orderId: null,
          lockTx: null,
          timelock: null,
        },
        dst: {
          chain: 'stellar',
          address: XLM_SRC,
          asset: 'native',
          amount: '1',
          orderId: null,
          lockTx: null,
          timelock: null,
        },
      },
    ]);
    expect(validatePersistedHistoryPage(page).ok).toBe(true);
  });

  it('rejects a record with no secret block or a malformed resolver', () => {
    const noSecret = cachedPage([{ ...HISTORY_PAGE_MIXED.transactions[0]! }]);
    delete (noSecret.transactions[0] as Record<string, unknown>)['secret'];
    expect(validatePersistedHistoryPage(noSecret).ok).toBe(false);

    const badResolver = cachedPage([{ ...HISTORY_PAGE_MIXED.transactions[0]! }]);
    (badResolver.transactions[0] as Record<string, unknown>)['resolver'] = 1;
    expect(validatePersistedHistoryPage(badResolver).ok).toBe(false);
  });

  it('assertPersistedHistoryPage returns a narrowed page or throws', () => {
    const page = { transactions: [], nextCursor: null, fetchedAt: 1_800_000_000 };
    expect(assertPersistedHistoryPage(page).fetchedAt).toBe(1_800_000_000);
    expect(() => assertPersistedHistoryPage({ transactions: [] })).toThrow(GuardError);
  });
});

describe('validateCoordinatorBaseUrl', () => {
  it('accepts an https URL and strips trailing slashes', () => {
    expect(validateCoordinatorBaseUrl('https://coordinator.example')).toEqual({
      ok: true,
      value: 'https://coordinator.example',
    });
    expect(validateCoordinatorBaseUrl('https://coordinator.example/')).toEqual({
      ok: true,
      value: 'https://coordinator.example',
    });
  });

  it('rejects an empty value, which would fetch against the current origin', () => {
    for (const value of ['', '   ', null, undefined, 42]) {
      expect(validateCoordinatorBaseUrl(value).ok, String(value)).toBe(false);
    }
  });

  it('rejects a schemeless value, which would concatenate into an invalid URL', () => {
    const result = validateCoordinatorBaseUrl('coordinator.example');
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('absolute URL'))).toBe(true);
  });

  it('rejects plain http, which would send the bearer token in clear text', () => {
    const result = validateCoordinatorBaseUrl('http://coordinator.example');
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('clear text'))).toBe(true);
  });

  it('rejects an unsupported scheme', () => {
    expect(validateCoordinatorBaseUrl('ftp://coordinator.example').ok).toBe(false);
    expect(validateCoordinatorBaseUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects a URL carrying a query string or fragment', () => {
    expect(validateCoordinatorBaseUrl('https://coordinator.example?a=1').ok).toBe(false);
    expect(validateCoordinatorBaseUrl('https://coordinator.example#x').ok).toBe(false);
  });
});

describe('validateCoordinatorEnvConfig', () => {
  it('accepts a minimal config', () => {
    const result = validateCoordinatorEnvConfig({ baseUrl: 'https://coordinator.example' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseUrl).toBe('https://coordinator.example');
    expect(result.value.timeoutMs).toBeUndefined();
    expect(result.value.operatorKey).toBeUndefined();
  });

  it('rejects a non-object', () => {
    for (const value of [null, undefined, 'https://x', 42]) {
      expect(validateCoordinatorEnvConfig(value).ok).toBe(false);
    }
  });

  it('rejects a non-positive or absurdly long timeout', () => {
    for (const timeoutMs of [0, -1, 1.5, '5000', 300_000]) {
      const result = validateCoordinatorEnvConfig({
        baseUrl: 'https://coordinator.example',
        timeoutMs,
      });
      expect(result.ok, String(timeoutMs)).toBe(false);
    }
  });

  it('rejects a blank or whitespace-bearing operator key', () => {
    expect(
      validateCoordinatorEnvConfig({
        baseUrl: 'https://coordinator.example',
        operatorKey: '   ',
      }).ok
    ).toBe(false);
    expect(
      validateCoordinatorEnvConfig({
        baseUrl: 'https://coordinator.example',
        operatorKey: 'has space',
      }).ok
    ).toBe(false);
    expect(
      validateCoordinatorEnvConfig({
        baseUrl: 'https://coordinator.example',
        operatorKey: 'tab\there',
      }).ok
    ).toBe(false);
  });

  it('accepts a well-formed operator key and timeout', () => {
    const result = validateCoordinatorEnvConfig({
      baseUrl: 'https://coordinator.example/',
      timeoutMs: 5_000,
      operatorKey: 'wf_op_abc123',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseUrl).toBe('https://coordinator.example');
    expect(result.value.timeoutMs).toBe(5_000);
    expect(result.value.operatorKey).toBe('wf_op_abc123');
  });

  it('reports every problem in one pass', () => {
    const result = validateCoordinatorEnvConfig({
      baseUrl: 'not-a-url',
      timeoutMs: -5,
      operatorKey: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('names the source in every issue so a frontend can point at the right env var', () => {
    const result = validateCoordinatorEnvConfig({ baseUrl: 'nope' }, 'import.meta.env');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.field.startsWith('import.meta.env')).toBe(true);
  });

  it('assertCoordinatorEnvConfig returns a narrowed config or throws', () => {
    const config = assertCoordinatorEnvConfig({ baseUrl: 'https://coordinator.example' });
    expect(config.baseUrl).toBe('https://coordinator.example');
    expect(() => assertCoordinatorEnvConfig({}, 'localStorage')).toThrow(GuardError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deep-link and route params
// ─────────────────────────────────────────────────────────────────────────────

describe('validateRouteParam', () => {
  it('accepts a live route', () => {
    const result = validateRouteParam('eth_to_xlm:native:wafflefinance-htlc');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.direction).toBe('eth_to_xlm');
      expect(result.value.status).toBe('live');
    }
  });

  it('rejects a missing or empty parameter', () => {
    for (const value of [null, undefined, '', 42]) {
      expect(validateRouteParam(value).ok, String(value)).toBe(false);
    }
  });

  it('rejects a malformed id and says what one looks like', () => {
    const result = validateRouteParam('eth_to_xlm:native');
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('direction>:<tokenGroup>:<bridgeMode'))).toBe(
      true
    );
  });

  it('rejects a well-formed id naming an undeclared slug', () => {
    expect(validateRouteParam('eth_to_xlm:doge:wafflefinance-htlc').ok).toBe(false);
    expect(validateRouteParam('btc_to_eth:native:wafflefinance-htlc').ok).toBe(false);
    expect(validateRouteParam('eth_to_xlm:native:wormhole').ok).toBe(false);
  });

  it('rejects a declared-but-planned route, and says so', () => {
    // A share link minted for a route that was never live. `parseRouteId`
    // accepts this — the slug is declared — so the check has to be here.
    const result = validateRouteParam('xlm_to_sol:native:wafflefinance-htlc');
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('not live'))).toBe(true);
  });

  it('rejects a live route that is not enabled on the requested network', () => {
    const result = validateRouteParam('eth_to_xlm:usdc:wafflefinance-htlc', { network: 'mainnet' });
    expect(result.ok).toBe(false);
    expect(messages(result).some(m => m.includes('not enabled on mainnet'))).toBe(true);
  });

  it('accepts a testnet-only route on testnet', () => {
    expect(
      validateRouteParam('eth_to_xlm:usdc:wafflefinance-htlc', { network: 'testnet' }).ok
    ).toBe(true);
  });

  it('assertRouteParam returns a narrowed RouteDefinition', () => {
    expect(assertRouteParam('eth_to_xlm:native:wafflefinance-htlc').id).toBe(
      'eth_to_xlm:native:wafflefinance-htlc'
    );
    expect(() => assertRouteParam('nope')).toThrow(GuardError);
  });
});

describe('validateOrderParam', () => {
  it('accepts a canonical public order id', () => {
    const result = validateOrderParam('wf_0x' + 'ab'.repeat(32));
    expect(result.ok).toBe(true);
  });

  it('rejects a missing parameter', () => {
    for (const value of [null, undefined, '']) {
      expect(validateOrderParam(value).ok, String(value)).toBe(false);
    }
  });

  it('rejects a hashlock with no wf_ prefix', () => {
    expect(validateOrderParam(PAIR_ETH_TO_XLM.hashlock).ok).toBe(false);
  });

  it('assertOrderParam returns a branded id', () => {
    expect(assertOrderParam('wf_0x' + 'ab'.repeat(32))).toBe('wf_0x' + 'ab'.repeat(32));
    expect(() => assertOrderParam('nope')).toThrow(GuardError);
  });
});

describe('validateAddressParam', () => {
  it('accepts a bare address and reports the chain as unknown', () => {
    const result = validateAddressParam(ETH_SRC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.address).toBe(ETH_SRC);
    // The chain cannot be inferred from a raw string, and saying so is
    // better than guessing and rejecting a valid address.
    expect(result.value.chain).toBeNull();
  });

  it('validates the format when the chain is given', () => {
    expect(validateAddressParam(ETH_SRC, 'ethereum').ok).toBe(true);
    expect(validateAddressParam(XLM_SRC, 'stellar').ok).toBe(true);
    expect(validateAddressParam(SOL_SRC, 'solana').ok).toBe(true);
  });

  it('rejects an address of the wrong chain', () => {
    const result = validateAddressParam(XLM_SRC, 'ethereum');
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('address');
  });

  it('rejects an unknown chain', () => {
    const result = validateAddressParam(ETH_SRC, 'bitcoin');
    expect(result.ok).toBe(false);
    expect(issues(result)).toContain('chain');
  });

  it('rejects a missing or blank address', () => {
    for (const value of [null, undefined, '', '   ', 42]) {
      expect(validateAddressParam(value).ok, String(value)).toBe(false);
    }
  });

  it('trims surrounding whitespace and normalises an EVM address to lowercase', () => {
    // Normalisation is deliberate: the same account must not compare unequal
    // because one producer checksummed and another did not.
    const result = validateAddressParam(`  ${ETH_SRC}  `, 'ethereum');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.address).toBe(ETH_SRC.toLowerCase());
    // A base-58 Solana address is case-sensitive and must not be folded.
    const sol = validateAddressParam(` ${SOL_SRC} `, 'solana');
    expect(sol.ok && sol.value.address).toBe(SOL_SRC);
  });
});

describe('validateRouteLink', () => {
  it('parses a full swap deep link', () => {
    const source = fromQueryString(
      '?route=eth_to_xlm:native:wafflefinance-htlc&order=wf_0x' +
        'ab'.repeat(32) +
        '&address=' +
        ETH_DST +
        '&chain=ethereum'
    );
    const result = validateRouteLink(source, { network: 'testnet' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route?.id).toBe('eth_to_xlm:native:wafflefinance-htlc');
    expect(result.value.order).toBe('wf_0x' + 'ab'.repeat(32));
    expect(result.value.address?.chain).toBe('ethereum');
  });

  it('accepts a link carrying only a route', () => {
    const result = validateRouteLink(
      fromQueryString('?route=eth_to_xlm:native:wafflefinance-htlc')
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.order).toBeNull();
    expect(result.value.address).toBeNull();
  });

  it('accepts a link carrying nothing at all', () => {
    const result = validateRouteLink(fromQueryString(''));
    expect(result.ok).toBe(true);
  });

  it('reports every bad parameter in one pass, so a link is diagnosed once', () => {
    const result = validateRouteLink(
      fromQueryString('?route=nope&order=also-nope&address=' + XLM_SRC + '&chain=ethereum')
    );
    expect(result.ok).toBe(false);
    const reported = issues(result);
    expect(reported).toContain('route');
    expect(reported).toContain('order');
    expect(reported).toContain('address');
  });

  it('adapts a real URLSearchParams', () => {
    const params = new URLSearchParams({ route: 'eth_to_xlm:native:wafflefinance-htlc' });
    expect(validateRouteLink(fromSearchParams(params)).ok).toBe(true);
  });

  it('tolerates a leading question mark only once', () => {
    expect(fromQueryString('?a=1').get('a')).toBe('1');
    expect(fromQueryString('a=1').get('a')).toBe('1');
  });

  it('assertRouteLink returns a narrowed link or throws', () => {
    const link = assertRouteLink(fromQueryString('?route=eth_to_xlm:native:wafflefinance-htlc'));
    expect(link.route?.direction).toBe('eth_to_xlm');
    expect(() => assertRouteLink(fromQueryString('?route=nope'))).toThrow(GuardError);
  });
});
