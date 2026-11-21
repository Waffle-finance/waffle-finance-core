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
 * Scope: the publishable packages and required artifact checks are read from
 * the release-check manifest (scripts/release-checks.json), which is the
 * single source of truth for release gates.  Private service packages
 * (coordinator, relayer, resolver, frontend) are excluded; their artifact
 * verification is part of the per-service build step.
 *
 * Exit codes
 *   0  All declared artifact paths exist.
 *   1  One or more declared artifact paths are missing; error messages
 *      identify each missing path by its declaring field and resolved location.
 *   2  The release-check manifest is missing or malformed.
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
const MANIFEST_PATH = path.join(__dirname, 'release-checks.json');

const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Load the release-check manifest and return the artifact-verification
 * section.  The manifest is the single source of truth for which packages
 * must be built and which artifact fields must resolve before release.
 */
function loadArtifactManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`❌  Unable to read release-check manifest at ${MANIFEST_PATH}`);
    console.error(`     ${err.message}`);
    process.exit(2);
  }

  const artifacts = manifest?.artifacts;
  if (!artifacts || !Array.isArray(artifacts.packages) || artifacts.packages.length === 0) {
    console.error(`❌  Release-check manifest at ${MANIFEST_PATH} has no artifacts.packages entries.`);
    process.exit(2);
  }

  for (const entry of artifacts.packages) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      console.error(`❌  Release-check manifest artifact entry is missing a "path": ${JSON.stringify(entry)}`);
      process.exit(2);
    }
  }

  return artifacts;
}

const ARTIFACT_MANIFEST = loadArtifactManifest();
// Packages whose export artifacts must be verified before release.
const PUBLISHABLE_PACKAGES = ARTIFACT_MANIFEST.packages.map((entry) => entry.path);
// Artifact fields (e.g. main, types, exports) that must resolve on disk.
const REQUIRED_ARTIFACT_FIELDS = Array.isArray(ARTIFACT_MANIFEST.requiredFields)
  ? ARTIFACT_MANIFEST.requiredFields
  : ['main', 'module', 'types', 'typings', 'exports'];

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

  for (const field of REQUIRED_ARTIFACT_FIELDS) {
    if (field === 'exports') {
      if (pkg.exports) {
        for (const entry of extractExportPaths(pkg.exports)) {
          // Skip the package.json re-export special case
          if (entry.value === './package.json' || entry.value === 'package.json') continue;
          toCheck.push(entry);
        }
      }
      continue;
    }
    if (pkg[field]) toCheck.push({ field, value: pkg[field] });
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
console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
console.log('Prerequisite: packages must be built before this check.');
for (const entry of ARTIFACT_MANIFEST.packages) {
  const label = entry.name ?? entry.path;
  console.log(`  pnpm --filter ${label} build`);
}
console.log('');

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
  const buildCommands = ARTIFACT_MANIFEST.packages
    .map((entry) => `pnpm --filter ${entry.name ?? entry.path} build`)
    .join(' && ');
  console.error(
    '❌  Release artifact verification failed.\n' +
    `    Run \`${buildCommands}\` and try again.`
  );
  process.exit(1);
}
