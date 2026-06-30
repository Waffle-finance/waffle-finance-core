#!/usr/bin/env node

/**
 * Release preparation script
 * 
 * This script helps prepare for a release by:
 * 1. Checking that all package versions are synchronized
 * 2. Running tests
 * 3. Building all packages
 * 4. Validating the release
 * 
 * Usage: node scripts/prepare-release.mjs [patch|minor|major]
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const PACKAGES = [
  'packages/sdk',
  'frontend',
  'contracts',
  'relayer',
  'resolver',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function exec(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
}

function checkVersionSync() {
  console.log('\n📦 Checking package version synchronization...');
  
  const versions = new Map();
  
  for (const pkg of PACKAGES) {
    const pkgPath = join(rootDir, pkg, 'package.json');
    try {
      const pkgJson = readJson(pkgPath);
      versions.set(pkg, pkgJson.version);
      console.log(`  ${pkg}: ${pkgJson.version}`);
    } catch (err) {
      console.warn(`  ⚠️  ${pkg}: not found or invalid`);
    }
  }
  
  const uniqueVersions = new Set(versions.values());
  
  if (uniqueVersions.size > 1) {
    console.error('\n❌ Version mismatch detected!');
    console.error('Packages have different versions. Please synchronize them.');
    process.exit(1);
  }
  
  console.log('✅ All packages have synchronized versions\n');
  return versions.values().next().value;
}

function bumpVersion(type) {
  console.log(`\n🔖 Bumping version (${type})...`);
  
  const currentVersion = checkVersionSync();
  const parts = currentVersion.split('.').map(Number);
  
  if (type === 'patch') {
    parts[2]++;
  } else if (type === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else if (type === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else {
    console.error(`Invalid version type: ${type}`);
    process.exit(1);
  }
  
  const newVersion = parts.join('.');
  console.log(`  ${currentVersion} → ${newVersion}`);
  
  for (const pkg of PACKAGES) {
    const pkgPath = join(rootDir, pkg, 'package.json');
    try {
      const pkgJson = readJson(pkgPath);
      pkgJson.version = newVersion;
      writeJson(pkgPath, pkgJson);
      console.log(`  Updated ${pkg}`);
    } catch (err) {
      console.warn(`  ⚠️  Skipped ${pkg}`);
    }
  }
  
  return newVersion;
}

function runTests() {
  console.log('\n🧪 Running tests...');
  try {
    exec('pnpm test');
    console.log('✅ Tests passed\n');
  } catch (err) {
    console.error('\n❌ Tests failed');
    process.exit(1);
  }
}

function buildPackages() {
  console.log('\n🔨 Building packages...');
  try {
    exec('pnpm build');
    console.log('✅ Build successful\n');
  } catch (err) {
    console.error('\n❌ Build failed');
    process.exit(1);
  }
}

function validateRelease() {
  console.log('\n✅ Validating release...');
  try {
    exec('node scripts/validate-workspace.mjs');
    console.log('✅ Validation passed\n');
  } catch (err) {
    console.error('\n❌ Validation failed');
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || 'patch';
  
  console.log('🚀 Preparing release...\n');
  
  // Step 1: Check current version sync
  const currentVersion = checkVersionSync();
  
  // Step 2: Bump version
  const newVersion = bumpVersion(type);
  
  // Step 3: Run tests
  runTests();
  
  // Step 4: Build packages
  buildPackages();
  
  // Step 5: Validate release
  validateRelease();
  
  console.log('✨ Release preparation complete!');
  console.log(`\n📝 Next steps:`);
  console.log(`  1. Review changes with: git diff`);
  console.log(`  2. Commit: git commit -am "chore: release v${newVersion}"`);
  console.log(`  3. Tag: git tag -a v${newVersion} -m "Release v${newVersion}"`);
  console.log(`  4. Push: git push && git push --tags`);
  console.log(`  5. Publish: pnpm -r publish --access public`);
}

main();
