#!/usr/bin/env node
/**
 * Prove, from a real consumer's runtime, that a deep subpath import does not
 * pull the other chains in (#731).
 *
 * Why a runtime probe and not just a module-graph count
 * ─────────────────────────────────────────────────────
 * A static read of the emitted `import` statements says what the graph *could*
 * reach. It does not say what Node actually *loads*. And the difference matters
 * here: this package sets `sideEffects: false`, so bundlers already drop the
 * unused parts of the root barrel — the root barrel costs a bundler nothing
 * extra. It costs a *Node ESM consumer* the whole graph, eagerly, at import
 * time. That gap is invisible to `tsc` and to a static analyser, and it is the
 * one that actually breaks start-up time for the relayer/resolver/e2e.
 *
 * So this script installs a module-resolution hook, imports one subpath, and
 * asserts on the set of files the loader was actually asked for:
 *
 *   - no foreign chain SDK (`@stellar/stellar-sdk`, `@solana/web3.js`) resolved
 *   - no foreign chain's emitted modules (`dist/soroban/**`, `dist/solana/**`)
 *
 * Run it against the built output:
 *
 *   pnpm build && pnpm verify:subpaths
 *
 * Exits non-zero on the first violation, so it is usable as a CI gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(__dirname, '..');
const distDir = path.join(pkgDir, 'dist');

/**
 * Which chain each subpath is *allowed* to touch. Anything outside its own
 * chain is a coupling bug.
 */
const CHAIN_OF = {
  './ethereum': 'ethereum',
  './ethereum/adapter': 'ethereum',
  './soroban': 'soroban',
  './soroban/adapter': 'soroban',
  './soroban/orchestrator': 'soroban',
  './solana': 'solana',
  './solana/adapter': 'solana',
  './solana/rpc-provider': 'solana',
  './solana/account-validation': 'solana',
  './solana/idl': 'solana',
};

/** Bare specifier → chain. A missing entry means "not a chain SDK". */
const CHAIN_SDK = {
  viem: 'ethereum',
  '@stellar/stellar-sdk': 'soroban',
  '@solana/web3.js': 'solana',
};

/** Emitted top-level directory → the chain it belongs to. */
const CHAIN_DIR = {
  ethereum: 'ethereum',
  soroban: 'soroban',
  solana: 'solana',
};

/**
 * Couplings that are known and deliberately accepted, so this gate is green
 * today and still trips on anything *new*. Each one needs a reason and an
 * owner-visible escape hatch — an unfixed violation here is a maintenance
 * debt with a name attached, not a silent pass.
 */
const KNOWN_COUPLINGS = {
  // `secrets` hashes with viem's sha256/keccak256. viem is the SDK's only
  // source of keccak256 (node:crypto has sha256 but not keccak256), so a
  // chain-neutral secret helper currently loads the Ethereum chain SDK.
  // Fixing it means reimplementing keccak256 in the SDK or swapping the
  // dependency — a change to hashing code, deliberately out of scope for #731.
  // Keyed by the chain that leaked in, so the allowlist reads the same way the
  // violation does.
  './secrets': {
    ethereum: 'secrets uses viem for keccak256; node:crypto has sha256 only',
  },
  // `fixtures` is the cross-chain test-benchmark module for #732: a fixture
  // that only described Ethereum would not be a benchmark for an
  // ETH<->XLM<->SOL bridge. It imports the per-chain encoders it feeds
  // (keccak256 from viem, StrKey from the Stellar SDK, the Anchor IDL and
  // the Solana deserialiser), so a multi-chain entry necessarily reaches all
  // three chain SDKs. Consumers should import the chain-specific runtime
  // subpaths, never this one, so nothing client-facing depends on it.
  './fixtures': {
    ethereum: 'fixtures encodes EVM addresses/hashes with keccak256 via viem',
    soroban: 'fixtures encodes Stellar StrKeys via @stellar/stellar-sdk',
    solana: 'fixtures builds Anchor buffers via the Solana IDL and deserialiser',
  },
};

/** Couplings acknowledged above, matched by the offending chain. */
function knownCouplingFor(subpath, chain) {
  return Object.prototype.hasOwnProperty.call(KNOWN_COUPLINGS[subpath] ?? {}, chain);
}

const resolveLog = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    resolveLog.push({ specifier, url: resolved.url });
    return resolved;
  },
});

/** Classify a resolved file URL as a chain, or `null` if it is chain-neutral. */
function chainOfUrl(url) {
  if (!url.startsWith('file:')) return null;
  const file = fileURLToPath(url);
  const rel = path.relative(distDir, file).split(path.sep).join('/');
  if (rel.startsWith('..')) return null; // outside dist/ — not our concern
  const top = rel.split('/')[0];
  return CHAIN_DIR[top] ?? null;
}

function specifierFor(subpath) {
  // exports keys are "./foo"; the specifier a consumer writes is
  // "@wafflefinance/sdk/foo".
  return `@wafflefinance/sdk/${subpath.replace(/^\.\//, '')}`;
}

async function checkSubpath(subpath) {
  resolveLog.length = 0;
  await import(specifierFor(subpath));

  const expected = CHAIN_OF[subpath] ?? null;
  const violations = [];
  const accepted = [];

  for (const { specifier, url } of resolveLog) {
    // A bare specifier is a third-party dependency.
    const bareChain = CHAIN_SDK[specifier];
    // A file inside this package's dist/.
    const fileChain = chainOfUrl(url);

    for (const [what, chain] of [
      ...(bareChain ? [['SDK ' + specifier, bareChain]] : []),
      ...(fileChain ? [['module ' + path.relative(distDir, fileURLToPath(url)), fileChain]] : []),
    ]) {
      if (expected && chain === expected) continue; // its own chain — fine
      if (knownCouplingFor(subpath, chain)) {
        accepted.push({ what, chain });
        continue;
      }
      violations.push(
        expected
          ? `pulled foreign chain ${what} (${chain})`
          : `chain-neutral subpath pulled ${what} (${chain})`
      );
    }
  }

  const unique = [...new Set(violations)];
  const acceptedUnique = [...new Map(accepted.map(a => [`${a.what}|${a.chain}`, a])).values()];
  const sdkModules = new Set(
    resolveLog
      .map(r => r.url)
      .filter(u => u.startsWith('file:') && fileURLToPath(u).startsWith(distDir))
  ).size;

  return { subpath, expected, unique, acceptedUnique, sdkModules, resolved: resolveLog.length };
}

async function main() {
  if (!fs.existsSync(distDir)) {
    console.error('dist/ not found — run `pnpm build` first.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const subpaths = Object.keys(pkg.exports).filter(s => s !== './package.json' && s !== '.');

  console.log('\n🔬 Subpath isolation probe (runtime, via module resolution hook)\n');
  let failed = 0;

  for (const subpath of subpaths) {
    let result;
    try {
      result = await checkSubpath(subpath);
    } catch (err) {
      console.log(`❌ ${subpath.padEnd(28)} failed to import: ${err.message}`);
      failed += 1;
      continue;
    }
    const scope = result.expected ?? 'chain-neutral';
    if (result.unique.length === 0) {
      console.log(
        `✅ ${subpath.padEnd(28)} ${String(result.sdkModules).padStart(2)} SDK modules, ` +
          `chain: ${scope}`
      );
      for (const a of result.acceptedUnique) {
        console.log(
          `     ⚠️  known coupling: ${a.what} — ${KNOWN_COUPLINGS[subpath]?.[a.chain] ?? ''}`
        );
      }
    } else {
      failed += 1;
      console.log(`❌ ${subpath.padEnd(28)} chain: ${scope}`);
      for (const v of result.unique) console.log(`     ${v}`);
    }
  }

  // The root barrel is the documented convenience entry and is *expected* to
  // reach every chain. Probe it too, so its cost stays visible and its link
  // integrity stays verified — it was silently broken (ESM link error) before
  // #731 and nothing in the test suite caught it.
  let rootOk = true;
  try {
    await import('@wafflefinance/sdk');
    console.log(`\n✅ ${'.'.padEnd(28)} root barrel loads and links`);
  } catch (err) {
    rootOk = false;
    failed += 1;
    console.log(`\n❌ ${'.'.padEnd(28)} root barrel failed to link: ${err.message}`);
  }

  console.log('');
  if (failed > 0) {
    console.error(`✗ ${failed} subpath(s) violated their chain boundary`);
    process.exit(1);
  }
  console.log(
    rootOk ? '✨ Every subpath is isolated to its own chain, and the root barrel links.' : ''
  );
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
