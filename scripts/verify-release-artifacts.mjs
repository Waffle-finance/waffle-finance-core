#!/usr/bin/env node
/**
 * Release-artifact verification for shared workspace packages.
 *
 * Verifies that every path declared in a package's `exports` map, as well as
 * the top-level `main` and `types` fields, resolves to an existing file on
 * disk **after the package has been built**.  Missing files are reported with
 * their exact declared path and resolved absolute path so the exact artifact
 * is immediately identifiable.
 *
 * Prerequisite: build the target packages before running this check.
 *
 *   pnpm --filter @wafflefinance/sdk build
 *   pnpm --filter @wafflefinance/config build
 *   node scripts/verify-release-artifacts.mjs
 *
 * Scope: publishable packages only — @wafflefinance/sdk and
 * @wafflefinance/config.  Private service packages (coordinator, relayer,
 * resolver, frontend) are excluded; their artifact verification is part of
 * the per-service build step.
 *
 * Exit codes
 *   0  All declared artifact paths exist.
 *   1  One or more declared artifact paths are missing; error messages
 *      identify each missing path by its declaring field and resolved location.
 *
 * Usage
 *   node scripts/verify-release-artifacts.mjs           # check all targets
 *   node scripts/verify-release-artifacts.mjs --verbose # extra per-path output
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Packages whose export artifacts must be verified before release.
// Only publishable (non-private) packages belong here.
const PUBLISHABLE_PACKAGES = [
  'packages/sdk',
  'packages/config',
];

const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractExportPaths(val, prefix = 'exports') {
  if (typeof val === 'string') {
    // Skip special entries that are not file paths
    if (val === 'package.json') return [];
    return [{ field: prefix, value: val }];
  }
  if (typeof val === 'object' && val !== null) {
    return Object.entries(val).flatMap(([k, v]) => extractExportPaths(v, `${prefix}["${k}"]`));
  }
  return [];
}

function checkPackage(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`❌  No package.json in ${pkgDir}`);
    return false;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const name = pkg.name ?? pkgDir;

  if (verbose) console.log(`\nChecking ${name} …`);

  const toCheck = [];

  if (pkg.main) toCheck.push({ field: 'main', value: pkg.main });
  if (pkg.module) toCheck.push({ field: 'module', value: pkg.module });
  if (pkg.types) toCheck.push({ field: 'types', value: pkg.types });
  if (pkg.typings) toCheck.push({ field: 'typings', value: pkg.typings });

  if (pkg.exports) {
    for (const entry of extractExportPaths(pkg.exports)) {
      // Skip the package.json re-export special case
      if (entry.value === './package.json' || entry.value === 'package.json') continue;
      toCheck.push(entry);
    }
  }

  let packageOk = true;

  for (const { field, value } of toCheck) {
    // Normalise: strip leading "./" so path.resolve works correctly
    const relative = value.startsWith('./') ? value.slice(2) : value;
    const full = path.resolve(pkgDir, relative);

    if (!fs.existsSync(full)) {
      console.error(
        `❌  ${name}: missing artifact declared in ${field}\n` +
        `     declared:  ${value}\n` +
        `     resolved:  ${full}`
      );
      packageOk = false;
    } else if (verbose) {
      console.log(`  ✓ ${field}: ${value}`);
    }
  }

  if (packageOk && !verbose) {
    console.log(`  ✓ ${name} — all ${toCheck.length} export targets present`);
  }

  return packageOk;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('=== Release artifact verification ===\n');
console.log('Prerequisite: packages must be built before this check.');
console.log('  pnpm --filter @wafflefinance/sdk build');
console.log('  pnpm --filter @wafflefinance/config build\n');

let allOk = true;

for (const rel of PUBLISHABLE_PACKAGES) {
  const absDir = path.resolve(ROOT, rel);
  if (!fs.existsSync(absDir)) {
    console.error(`❌  Package directory not found: ${absDir}`);
    allOk = false;
    continue;
  }
  const ok = checkPackage(absDir);
  if (!ok) allOk = false;
}

console.log('');
if (allOk) {
  console.log('✅  All release artifact paths verified — packages are ready to publish.');
} else {
  console.error(
    '❌  Release artifact verification failed.\n' +
    '    Run `pnpm --filter @wafflefinance/sdk build && ' +
    'pnpm --filter @wafflefinance/config build` and try again.'
  );
  process.exit(1);
}
