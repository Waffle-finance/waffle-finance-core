#!/usr/bin/env node
/**
 * Workspace Node and pnpm version consistency check.
 *
 * Verifies that the declared Node and pnpm versions are consistent across:
 *   - .nvmrc
 *   - package.json engines
 *   - package.json packageManager
 *   - GitHub Actions workflow setup steps
 *   - Dev container setup
 *
 * This is a dependency-free Node script.  It does not install, download, or
 * contact any registry.  It only reads local files and compares strings.
 *
 * Usage:
 *   node scripts/check-versions.mjs
 *
 * Exit codes:
 *   0  All version sources agree.
 *   1  One or more sources disagree; error messages identify each drift.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const errors = [];

// ---------------------------------------------------------------------------
// Read version sources
// ---------------------------------------------------------------------------

// 1. .nvmrc — should contain a bare major version (e.g. "22") or a full
//    version string (e.g. "22.5.0").  We extract the major version.
function readNvmrc() {
  const p = path.join(ROOT, '.nvmrc');
  if (!fs.existsSync(p)) {
    errors.push('.nvmrc not found — add the Node major version (e.g. "22")');
    return null;
  }
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) {
    errors.push('.nvmrc is empty — add the Node major version (e.g. "22")');
    return null;
  }
  return raw;
}

// 2. package.json engines.node and packageManager
function readRootPkg() {
  const p = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const nodeRange = pkg.engines?.node ?? null;
  const pnpmRange = pkg.engines?.pnpm ?? null;
  const packageManager = pkg.packageManager ?? null;

  // Extract major version from range like ">=22.0.0" or "^22"
  const nodeMajor = nodeRange ? nodeRange.match(/\d+/)?.[0] : null;
  const pnpmMajor = pnpmRange ? pnpmRange.match(/\d+/)?.[0] : null;
  // packageManager is like "pnpm@8.15.0"
  const pmMajor = packageManager ? packageManager.split('@')[1]?.split('.')[0] : null;

  return { nodeRange, pnpmRange, packageManager, nodeMajor, pnpmMajor, pmMajor };
}

// 3. GitHub Actions workflows — extract node-version and pnpm version values
function readWorkflows() {
  const wfDir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return {};

  const results = {};
  for (const file of fs.readdirSync(wfDir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const content = fs.readFileSync(path.join(wfDir, file), 'utf8');

    // Match node-version: 22  or  node-version: "22"
    const nodeMatches = [...content.matchAll(/node-version:\s*["']?(\d+)/g)];
    const nodeVersions = nodeMatches.map(m => m[1]);

    // Match pnpm version: 8  or  version: "8"  — but only within
    // pnpm/action-setup context, not node-version lines.
    // We look for "version:" that is NOT preceded by "node-".
    const pnpmMatches = [...content.matchAll(/(?<!node-)version:\s*["']?(\d+)\b/g)];
    const pnpmVersions = pnpmMatches.map(m => m[1]);

    if (nodeVersions.length > 0 || pnpmVersions.length > 0) {
      results[file] = { nodeVersions, pnpmVersions };
    }
  }
  return results;
}

// 4. .devcontainer/setup.sh — check pnpm install version
function readDevcontainer() {
  const p = path.join(ROOT, '.devcontainer', 'setup.sh');
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8');
  const match = content.match(/pnpm@(\d+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Check consistency
// ---------------------------------------------------------------------------

const nvmrc = readNvmrc();
const root = readRootPkg();
const workflows = readWorkflows();
const devcontainerPnpm = readDevcontainer();

const EXPECTED_NODE_MAJOR = root.nodeMajor; // from engines.node
const EXPECTED_PNPM_MAJOR = root.pmMajor;   // from packageManager

console.log('=== Workspace version consistency check ===\n');
console.log(`  engines.node:        ${root.nodeRange ?? '(missing)'}`);
console.log(`  engines.pnpm:       ${root.pnpmRange ?? '(missing)'}`);
console.log(`  packageManager:      ${root.packageManager ?? '(missing)'}`);
console.log(`  .nvmrc:              ${nvmrc ?? '(missing)'}`);
console.log(`  devcontainer pnpm:   ${devcontainerPnpm ?? '(not found)'}`);
console.log('');

// Check .nvmrc major version matches engines.node
if (nvmrc && EXPECTED_NODE_MAJOR) {
  const nvmMajor = nvmrc.match(/\d+/)?.[0];
  if (nvmMajor && nvmMajor !== EXPECTED_NODE_MAJOR) {
    errors.push(
      `.nvmrc major version "${nvmMajor}" does not match engines.node ` +
      `("${root.nodeRange}" → major ${EXPECTED_NODE_MAJOR}). ` +
      `Update .nvmrc to "${EXPECTED_NODE_MAJOR}".`
    );
  }
}

// Check engines.pnpm major matches packageManager major
if (root.pnpmMajor && root.pmMajor && root.pnpmMajor !== root.pmMajor) {
  errors.push(
    `engines.pnpm ("${root.pnpmRange}" → major ${root.pnpmMajor}) does not ` +
    `match packageManager ("${root.packageManager}" → major ${root.pmMajor}).`
  );
}

// Check workflow Node versions
for (const [file, info] of Object.entries(workflows)) {
  for (const v of info.nodeVersions) {
    if (EXPECTED_NODE_MAJOR && v !== EXPECTED_NODE_MAJOR) {
      errors.push(
        `.github/workflows/${file}: node-version "${v}" does not match ` +
        `engines.node major ${EXPECTED_NODE_MAJOR}.`
      );
    }
  }
}

// Check workflow pnpm versions against packageManager
for (const [file, info] of Object.entries(workflows)) {
  for (const v of info.pnpmVersions) {
    if (EXPECTED_PNPM_MAJOR && v !== EXPECTED_PNPM_MAJOR) {
      errors.push(
        `.github/workflows/${file}: pnpm version "${v}" does not match ` +
        `packageManager major ${EXPECTED_PNPM_MAJOR} ` +
        `(${root.packageManager}).`
      );
    }
  }
}

// Check devcontainer pnpm version
if (devcontainerPnpm && EXPECTED_PNPM_MAJOR && devcontainerPnpm !== EXPECTED_PNPM_MAJOR) {
  errors.push(
    `.devcontainer/setup.sh: installs pnpm@${devcontainerPnpm} but ` +
    `packageManager is ${root.packageManager} (major ${EXPECTED_PNPM_MAJOR}).`
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (errors.length === 0) {
  console.log('✅  All Node and pnpm version sources agree.');
  process.exit(0);
} else {
  for (const e of errors) {
    console.error(`❌  ${e}`);
  }
  console.error('');
  console.error(`Fix the drift(s) above.  Expected: Node ${EXPECTED_NODE_MAJOR}, pnpm ${EXPECTED_PNPM_MAJOR}.`);
  process.exit(1);
}
