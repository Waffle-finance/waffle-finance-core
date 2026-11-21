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
 *
 * Release provenance manifest
 *   After a successful check the script writes a deterministic
 *   `release-manifest.json` at the repository root.  It records the source
 *   commit, package versions, Node and pnpm versions, and a SHA-256 digest of
 *   every declared artifact.  Environment values and credentials are never
 *   included.  The manifest is deterministic for the same source revision and
 *   build environment (entries are sorted and contain no timestamps).
 *
 *   Pass `--verify-manifest` to instead verify an existing manifest: every
 *   listed file must exist and match its recorded digest.  Verification fails
 *   (exit code 1) when a declared artifact is missing or modified.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
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
const verifyManifest = process.argv.includes('--verify-manifest');

const MANIFEST_NAME = 'release-manifest.json';
const MANIFEST_PATH = path.join(ROOT, MANIFEST_NAME);
const MANIFEST_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getCommit() {
  return tryExec('git', ['rev-parse', 'HEAD']) ?? 'unknown';
}

function getPnpmVersion() {
  return tryExec('pnpm', ['--version']) ?? 'unknown';
}

/**
 * Collect the declared artifact paths for a package, mirroring the checks in
 * checkPackage.  Returns entries with the declaring field and the path
 * relative to the repository root (POSIX separators for determinism).
 */
function collectArtifacts(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { name: pkgDir, version: null, artifacts: [] };

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const name = pkg.name ?? pkgDir;

  const toCheck = [];
  if (pkg.main) toCheck.push({ field: 'main', value: pkg.main });
  if (pkg.module) toCheck.push({ field: 'module', value: pkg.module });
  if (pkg.types) toCheck.push({ field: 'types', value: pkg.types });
  if (pkg.typings) toCheck.push({ field: 'typings', value: pkg.typings });
  if (pkg.exports) {
    for (const entry of extractExportPaths(pkg.exports)) {
      if (entry.value === './package.json' || entry.value === 'package.json') continue;
      toCheck.push(entry);
    }
  }

  const artifacts = toCheck.map(({ field, value }) => {
    const relative = value.startsWith('./') ? value.slice(2) : value;
    const full = path.resolve(pkgDir, relative);
    return {
      field,
      declared: value,
      path: path.relative(ROOT, full).split(path.sep).join('/'),
      full,
    };
  });

  return { name, version: pkg.version ?? null, artifacts };
}

function buildManifest() {
  const packages = PUBLISHABLE_PACKAGES.map((rel) => {
    const { name, version, artifacts } = collectArtifacts(path.resolve(ROOT, rel));
    return {
      name,
      version,
      artifacts: artifacts
        .map(({ field, path: relPath, full }) => ({
          field,
          path: relPath,
          sha256: sha256(full),
        }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.field.localeCompare(b.field)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    commit: getCommit(),
    node: process.version,
    pnpm: getPnpmVersion(),
    packages,
  };
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n📝  Wrote ${MANIFEST_NAME}`);
}

function verifyExistingManifest() {
  console.log('=== Release manifest verification ===\n');

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`❌  Manifest not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`❌  Manifest is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  let ok = true;
  let checked = 0;

  for (const pkg of manifest.packages ?? []) {
    for (const artifact of pkg.artifacts ?? []) {
      checked += 1;
      const full = path.resolve(ROOT, artifact.path);
      if (!fs.existsSync(full)) {
        console.error(
          `❌  ${pkg.name}: missing artifact declared in ${artifact.field}\n` +
          `     path:      ${artifact.path}\n` +
          `     resolved:  ${full}`
        );
        ok = false;
        continue;
      }
      const actual = sha256(full);
      if (actual !== artifact.sha256) {
        console.error(
          `❌  ${pkg.name}: digest mismatch for ${artifact.path}\n` +
          `     expected:  ${artifact.sha256}\n` +
          `     actual:    ${actual}`
        );
        ok = false;
      } else if (verbose) {
        console.log(`  ✓ ${artifact.path}`);
      }
    }
  }

  console.log('');
  if (ok) {
    console.log(`✅  Manifest verified — ${checked} artifact(s) match their digests.`);
  } else {
    console.error('❌  Manifest verification failed.');
    process.exit(1);
  }
}

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

if (verifyManifest) {
  verifyExistingManifest();
  process.exit(0);
}

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
  writeManifest(buildManifest());
} else {
  console.error(
    '❌  Release artifact verification failed.\n' +
    '    Run `pnpm --filter @wafflefinance/sdk build && ' +
    'pnpm --filter @wafflefinance/config build` and try again.'
  );
  process.exit(1);
}
