#!/usr/bin/env node
/**
 * scripts/dep-graph.mjs
 *
 * Deterministic workspace dependency graph.
 *
 * Reads every workspace package.json, resolves direct @wafflefinance/*
 * dependency edges (declared in dependencies, devDependencies, and
 * peerDependencies), and writes a text or JSON report.
 *
 * Changed-package comparison mode (--changed <pkg,...>):
 *   Given a comma-separated list of changed package names, prints which
 *   other workspace packages directly depend on them.  Useful during
 *   release preparation to identify all consumers of a changed SDK,
 *   config, or generated-binding package without maintaining a manual list.
 *
 * Usage:
 *   node scripts/dep-graph.mjs
 *   node scripts/dep-graph.mjs --format json
 *   node scripts/dep-graph.mjs --format text        # default
 *   node scripts/dep-graph.mjs --changed @wafflefinance/sdk
 *   node scripts/dep-graph.mjs --changed @wafflefinance/sdk,@wafflefinance/config
 *   node scripts/dep-graph.mjs --format json --out dep-graph.json
 *
 * Exit codes:
 *   0  Report generated (or no consumers found in --changed mode).
 *   1  Error reading workspace manifests.
 *
 * Determinism guarantee:
 *   Package names and edges are sorted alphabetically before output.
 *   The same workspace produces identical output on every run.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

const format      = getArg('--format')  ?? 'text';
const outFile     = getArg('--out')     ?? null;
const changedRaw  = getArg('--changed') ?? null;
const changedPkgs = changedRaw ? changedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

if (!['text', 'json'].includes(format)) {
  console.error(`Unknown format "${format}". Use --format text or --format json.`);
  process.exit(1);
}

// ─── Workspace discovery ──────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function discoverPackages() {
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  if (!rootPkg) throw new Error('Root package.json not found');

  const results = [];

  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(ROOT, pattern.replace('/*', ''));
      if (!fs.existsSync(parent)) continue;
      for (const sub of fs.readdirSync(parent)) {
        const dir = path.join(parent, sub);
        if (!fs.statSync(dir).isDirectory()) continue;
        const pkg = readJson(path.join(dir, 'package.json'));
        if (pkg?.name) results.push({ dir, pkg, name: pkg.name });
      }
    } else {
      const dir = path.join(ROOT, pattern);
      if (!fs.existsSync(dir)) continue;
      const pkg = readJson(path.join(dir, 'package.json'));
      if (pkg?.name) results.push({ dir, pkg, name: pkg.name });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Graph construction ───────────────────────────────────────────────────────

/**
 * Build a map of:
 *   packageName → sorted list of @wafflefinance/* packages it directly depends on
 *
 * Only workspace-to-workspace edges are included (workspace:* ranges, or any
 * range that resolves to a name present in the workspace).
 */
function buildGraph(packages) {
  const workspaceNames = new Set(packages.map(p => p.name));
  const graph = new Map(); // name → Set of dependency names

  for (const { name, pkg } of packages) {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const edges = new Set();

    for (const [dep, range] of Object.entries(allDeps)) {
      if (!workspaceNames.has(dep)) continue;        // not a workspace package
      if (dep === name) continue;                     // self-reference (shouldn't happen)
      edges.add(dep);
    }

    graph.set(name, [...edges].sort());
  }

  return graph;
}

/**
 * Build the reverse graph: packageName → sorted list of packages that
 * directly depend on it.
 */
function buildReverseGraph(graph) {
  const reverse = new Map();
  for (const [pkg] of graph) reverse.set(pkg, []);

  for (const [consumer, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, []);
      reverse.get(dep).push(consumer);
    }
  }

  for (const [pkg, consumers] of reverse) {
    reverse.set(pkg, [...consumers].sort());
  }

  return reverse;
}

// ─── Output formatters ────────────────────────────────────────────────────────

function renderText(graph, reverse, packages) {
  const lines = [];

  lines.push('WaffleFinance — Workspace Dependency Graph');
  lines.push('==========================================');
  lines.push('');
  lines.push('Direction: consumer → depends on → producer');
  lines.push('');

  // Forward graph: what each package depends on
  lines.push('── Forward edges (package → its workspace dependencies)');
  lines.push('');
  for (const [name, deps] of [...graph.entries()].sort()) {
    if (deps.length === 0) {
      lines.push(`  ${name}`);
      lines.push('    (no workspace dependencies)');
    } else {
      lines.push(`  ${name}`);
      for (const dep of deps) {
        lines.push(`    → ${dep}`);
      }
    }
    lines.push('');
  }

  // Reverse graph: who depends on each package
  lines.push('── Reverse edges (package → direct workspace consumers)');
  lines.push('');
  for (const [name, consumers] of [...reverse.entries()].sort()) {
    if (consumers.length === 0) {
      lines.push(`  ${name}`);
      lines.push('    (no direct workspace consumers)');
    } else {
      lines.push(`  ${name}`);
      for (const c of consumers) {
        lines.push(`    ← ${c}`);
      }
    }
    lines.push('');
  }

  // Edge count summary
  let totalEdges = 0;
  for (const deps of graph.values()) totalEdges += deps.length;
  lines.push(`Total workspace packages : ${graph.size}`);
  lines.push(`Total dependency edges   : ${totalEdges}`);

  return lines.join('\n');
}

function renderJson(graph, reverse, packages) {
  let totalEdges = 0;
  for (const deps of graph.values()) totalEdges += deps.length;

  const obj = {
    generatedAt: new Date().toISOString(),
    totalPackages: graph.size,
    totalEdges,
    packages: {},
  };

  for (const { name, pkg } of [...packages].sort((a, b) => a.name.localeCompare(b.name))) {
    obj.packages[name] = {
      version:  pkg.version ?? null,
      dir:      path.relative(ROOT, packages.find(p => p.name === name)?.dir ?? ROOT),
      dependsOn: graph.get(name) ?? [],
      consumedBy: reverse.get(name) ?? [],
    };
  }

  return JSON.stringify(obj, null, 2);
}

function renderChangedReport(changedPkgs, reverse) {
  const lines = [];
  lines.push('WaffleFinance — Changed-Package Consumer Report');
  lines.push('===============================================');
  lines.push('');
  lines.push(`Changed package(s): ${changedPkgs.join(', ')}`);
  lines.push('');

  // All known workspace names for validation
  const knownNames = new Set(reverse.keys());
  const unknown = changedPkgs.filter(p => !knownNames.has(p));
  if (unknown.length > 0) {
    lines.push(`⚠️  Unknown package(s) — not in workspace: ${unknown.join(', ')}`);
    lines.push('   Check the name against pnpm-workspace.yaml / package.json.');
    lines.push('');
  }

  // Collect all direct consumers across all changed packages
  const consumerMap = new Map(); // consumer → Set of changed packages it depends on
  for (const changed of changedPkgs) {
    for (const consumer of (reverse.get(changed) ?? [])) {
      if (!consumerMap.has(consumer)) consumerMap.set(consumer, new Set());
      consumerMap.get(consumer).add(changed);
    }
  }

  if (consumerMap.size === 0) {
    lines.push('No other workspace packages directly depend on the changed package(s).');
    lines.push('');
    lines.push('Note: external (non-workspace) consumers are not tracked here.');
  } else {
    lines.push(`Direct workspace consumers affected (${consumerMap.size}):`);
    lines.push('');
    for (const [consumer, deps] of [...consumerMap.entries()].sort()) {
      const via = [...deps].sort().join(', ');
      lines.push(`  ${consumer}`);
      lines.push(`    via: ${via}`);
    }
    lines.push('');
    lines.push(
      'These packages should be rebuilt and tested before tagging the release.\n' +
      'See .github/RELEASE_CHECKLIST.md §1 for the cross-package impact matrix.'
    );
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  let packages;
  try {
    packages = discoverPackages();
  } catch (err) {
    console.error('❌ Failed to discover workspace packages:', err.message);
    process.exit(1);
  }

  const graph   = buildGraph(packages);
  const reverse = buildReverseGraph(graph);

  let output;

  if (changedPkgs.length > 0) {
    // Changed-package comparison mode
    output = renderChangedReport(changedPkgs, reverse);
  } else if (format === 'json') {
    output = renderJson(graph, reverse, packages);
  } else {
    output = renderText(graph, reverse, packages);
  }

  if (outFile) {
    const outPath = path.resolve(ROOT, outFile);
    fs.writeFileSync(outPath, output + '\n', 'utf8');
    console.log(`✅  Report written to ${path.relative(ROOT, outPath)}`);
  } else {
    console.log(output);
  }
}

main();
