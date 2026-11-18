#!/usr/bin/env node
/**
 * Measure the per-entry-point import cost of the built SDK (#731).
 *
 * Why this exists
 * ───────────────
 * `npm run analyze` only checks that a hand-written list of files exists in
 * `dist/`. It cannot answer the question #731 actually asks: *if a consumer
 * imports one subpath, what does that drag in?* A file existing in `dist/`
 * says nothing about whether the other two chains came with it.
 *
 * So this script does two things, for every subpath in the `exports` map:
 *
 *  1. Walks the static ESM module graph of the emitted entry file, following
 *     relative `import` / `export ... from` / `import()` specifiers, and
 *     reports how many SDK modules are reachable, how many bytes they are,
 *     and which third-party chain SDKs (viem / @stellar/stellar-sdk /
 *     @solana/web3.js) the graph touches. A subpath that pulls a chain SDK it
 *     does not need is the coupling this issue is about.
 *
 *  2. Optionally (`--bundle`) bundles a synthetic one-import consumer entry per
 *     subpath with esbuild and reports real minified+gzipped bytes. esbuild is
 *     not a declared dependency of this package, so this half is skipped with
 *     a note when esbuild cannot be resolved.
 *
 * The output is a table, so a before/after diff is eyeballable:
 *
 *   node scripts/measure-entry-cost.mjs
 *   node scripts/measure-entry-cost.mjs --bundle
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(__dirname, '..');
const distDir = path.join(pkgDir, 'dist');

/**
 * Chain SDKs whose presence in an entry's graph is the thing we care about.
 * Each one is a large dependency that only one chain's code needs.
 */
const CHAIN_SDKS = {
  viem: 'ethereum',
  '@stellar/stellar-sdk': 'soroban',
  '@solana/web3.js': 'solana',
};

/** Source-ish bytes of a specifier, ignoring nothing — we sum emitted JS. */
const sizeOf = file => fs.statSync(file).size;

/**
 * Extract every module specifier a file statically references.
 *
 * Deliberately conservative: we only follow *relative* specifiers here, so the
 * walk stays inside this package and never wanders into `node_modules`. Bare
 * specifiers are collected separately as "external deps".
 */
function specifiersOf(source) {
  const specs = new Set();
  const patterns = [
    // `from "x"` — covers import ... from, export ... from, and export * from.
    /\bfrom\s*["']([^"']+)["']/g,
    // bare `import "x"` (side-effect import)
    /\bimport\s+["']([^"']+)["']/g,
    // dynamic import("x")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * Breadth-first walk of the emitted ESM graph from `entryFile`.
 *
 * @returns {{modules: string[], bytes: number, externals: Set<string>}}
 */
function walkGraph(entryFile) {
  const seen = new Set();
  const externals = new Set();
  let bytes = 0;
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    bytes += sizeOf(file);

    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec);
        // Emitted output always carries the extension; guard anyway.
        const target = resolved.endsWith('.js') ? resolved : path.join(resolved, 'index.js');
        if (fs.existsSync(target)) queue.push(target);
      } else {
        externals.add(spec);
      }
    }
  }

  return { modules: [...seen], bytes, externals };
}

/** Resolve `exports[subpath].import` to an absolute file path. */
function entryFileFor(subpath, pkg) {
  const node = pkg.exports[subpath];
  if (typeof node === 'string') return path.join(pkgDir, node);
  if (node && typeof node === 'object' && node.import) {
    return path.join(pkgDir, node.import);
  }
  return null;
}

/**
 * Try hard to find esbuild without it being a declared dependency: the normal
 * `import()` first, then the pnpm virtual store (which is where a hoisted
 * transitive copy lives in a pnpm workspace).
 */
async function loadEsbuild() {
  const require = createRequire(import.meta.url);
  try {
    return require('esbuild');
  } catch {
    /* fall through to the store scan */
  }
  const store = path.join(pkgDir, '..', '..', 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) return null;
  const candidates = fs
    .readdirSync(store)
    .filter(d => d.startsWith('esbuild@'))
    .sort()
    .reverse();
  for (const c of candidates) {
    try {
      return require(path.join(store, c, 'node_modules', 'esbuild'));
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Bundle a synthetic consumer that imports only from `specifier`. */
async function bundleSubpath(esbuild, specifier) {
  // The synthetic entry has to live *inside* this package so that the bare
  // `@wafflefinance/sdk/...` specifier resolves as a self-reference through
  // the real `exports` map — that is the whole point of the measurement.
  const tmp = path.join(pkgDir, '.sdk-cost-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const entry = path.join(tmp, 'entry.mjs');
    // A real import, so the SDK graph is genuinely pulled in.
    fs.writeFileSync(
      entry,
      `import * as sdk from ${JSON.stringify(specifier)};\nexport { sdk };\n`
    );
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      platform: 'neutral',
      // Bare chain SDKs stay external so we measure *our* graph, not viem's
      // internals; the externals table above already reports who they are.
      external: Object.keys(CHAIN_SDKS),
      logLevel: 'silent',
      absWorkingDir: pkgDir,
    });
    const code = result.outputFiles[0].contents;
    return { bytes: code.length, gzip: gzipSync(code).length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function kib(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

/** The bare specifier a consumer would write for a given `exports` key. */
function specifierFor(subpath) {
  return subpath === '.' ? '@wafflefinance/sdk' : `@wafflefinance/sdk/${subpath.slice(2)}`;
}

async function main() {
  const wantBundle = process.argv.includes('--bundle');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

  if (!fs.existsSync(distDir)) {
    console.error('dist/ not found — run `pnpm build` first.');
    process.exit(1);
  }

  const subpaths = Object.keys(pkg.exports);
  const esbuild = wantBundle ? await loadEsbuild() : null;
  if (wantBundle && !esbuild) {
    console.log('note: esbuild not resolvable — reporting module-graph cost only.\n');
  }

  console.log(`\nPer-entry import cost for @wafflefinance/sdk (${subpaths.length} subpaths)\n`);
  const header = ['subpath', 'modules', 'graph', 'chains reached', 'bundle'];
  const rows = [];

  for (const subpath of subpaths) {
    const file = entryFileFor(subpath, pkg);
    if (!file || !fs.existsSync(file)) {
      rows.push([subpath, '-', 'DANGLING', '-', '-']);
      continue;
    }
    const graph = walkGraph(file);
    const chains = new Set();
    for (const ext of graph.externals) {
      if (CHAIN_SDKS[ext]) chains.add(CHAIN_SDKS[ext]);
      else if (ext === 'node:buffer' || ext === 'buffer') chains.add('node:buffer');
    }
    let bundle = '-';
    if (esbuild) {
      const b = await bundleSubpath(esbuild, specifierFor(subpath));
      bundle = `${kib(b.bytes)} / ${kib(b.gzip)} gz`;
    }
    rows.push([
      subpath,
      String(graph.modules.length),
      kib(graph.bytes),
      chains.size ? [...chains].join('+') : '(none)',
      bundle,
    ]);
  }

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = cells =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  console.log(line(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));

  // Anything emitted but not reachable through `exports` is dead weight that
  // ships to every consumer. Report it — it is usually a missing subpath.
  const reachable = new Set();
  for (const subpath of subpaths) {
    const file = entryFileFor(subpath, pkg);
    if (file && fs.existsSync(file)) {
      for (const m of walkGraph(file).modules) reachable.add(path.relative(distDir, m));
    }
  }
  const orphans = [];
  const scan = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.d.js')) {
        const rel = path.relative(distDir, p);
        if (!reachable.has(rel)) orphans.push(rel);
      }
    }
  };
  scan(distDir);

  console.log('');
  if (orphans.length === 0) {
    console.log('Every emitted module is reachable from at least one exports subpath.');
  } else {
    console.log(`Emitted but NOT reachable from any exports subpath (${orphans.length}):`);
    for (const o of orphans) console.log(`  - ${o}`);
  }
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
