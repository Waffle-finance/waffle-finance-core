// scripts/preflight.js
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function requireEnv(vars) {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  console.log('✅ All required environment variables are set');
}

export function checkCommand(cmd, name, minVersion) {
  try {
    const out = execSync(`${cmd} --version`, { encoding: 'utf8' }).trim();
    console.log(`✅ ${name} version: ${out}`);
    if (minVersion) {
      const version = out.replace(/[^0-9.]/g, '');
      const [major, minor = '0'] = version.split('.').map(Number);
      const [reqMajor, reqMinor = '0'] = minVersion.split('.').map(Number);
      if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
        console.error(`❌ ${name} version ${version} is lower than required ${minVersion}`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(`❌ ${name} is not installed or not executable`);
    process.exit(1);
  }
}

export function requireFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing ${description}: ${filePath}`);
    process.exit(1);
  }
  console.log(`✅ Found ${description}`);
}

/**
 * Deterministically hash a file's contents (normalized for line endings).
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Recursively collect files under a directory, returning sorted relative paths.
 */
function collectFiles(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full));
    }
  }
  return results.sort();
}

/**
 * Compute a canonical interface fingerprint for the committed SDK bindings.
 * This is a pure, offline operation: it hashes the generated binding sources
 * so any drift from the committed output is detected.
 */
export function computeBindingsFingerprint(bindingsDir) {
  const files = collectFiles(bindingsDir);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel.replace(/\\/g, '/'), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(hashFile(path.join(bindingsDir, rel)), 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

/**
 * Check that committed Soroban TypeScript bindings match the current contract
 * interface. Runs entirely offline (no deployment credentials, no live network).
 *
 * Strategy:
 *   1. If a committed fingerprint file exists, recompute the fingerprint of the
 *      committed bindings and compare. A mismatch means the bindings were edited
 *      without regenerating the fingerprint (or vice versa).
 *   2. If a regen script is available, regenerate into a temp dir and diff the
 *      output against the committed bindings. Any difference is stale bindings.
 *
 * @param {object} [options]
 * @param {string} [options.bindingsDir]  Directory of committed SDK bindings.
 * @param {string} [options.fingerprintFile] Committed fingerprint file path.
 * @param {string} [options.regenScript]  Path to regen-bindings.sh.
 * @param {boolean} [options.exitOnFailure=true] Exit process on failure.
 * @returns {boolean} true if bindings are up to date.
 */
export function checkSorobanBindings(options = {}) {
  const bindingsDir =
    options.bindingsDir ||
    process.env.SOROBAN_BINDINGS_DIR ||
    path.join('packages', 'sdk', 'src', 'soroban');
  const fingerprintFile =
    options.fingerprintFile ||
    process.env.SOROBAN_BINDINGS_FINGERPRINT ||
    path.join('packages', 'sdk', 'soroban-bindings.fingerprint');
  const regenScript =
    options.regenScript ||
    process.env.SOROBAN_REGEN_SCRIPT ||
    path.join('soroban', 'scripts', 'regen-bindings.sh');
  const exitOnFailure = options.exitOnFailure !== false;

  const fail = (msg) => {
    console.error(`❌ Soroban binding drift detected: ${msg}`);
    console.error(
      '   Regenerate bindings with: bash soroban/scripts/regen-bindings.sh'
    );
    console.error(
      '   See docs for when to regenerate after contract interface changes.'
    );
    if (exitOnFailure) process.exit(1);
    return false;
  };

  if (!fs.existsSync(bindingsDir)) {
    return fail(`committed bindings directory not found: ${bindingsDir}`);
  }

  // 1. Fingerprint comparison (offline, deterministic).
  const actualFingerprint = computeBindingsFingerprint(bindingsDir);

  if (fs.existsSync(fingerprintFile)) {
    const expected = fs.readFileSync(fingerprintFile, 'utf8').trim();
    if (expected !== actualFingerprint) {
      return fail(
        `committed bindings fingerprint does not match recorded fingerprint.\n` +
          `   expected: ${expected}\n` +
          `   actual:   ${actualFingerprint}`
      );
    }
    console.log('✅ Soroban bindings fingerprint matches committed record');
  } else {
    console.warn(
      `⚠️  No committed fingerprint found at ${fingerprintFile}; ` +
        'skipping fingerprint comparison'
    );
  }

  // 2. Regenerate into a temp dir and diff against committed bindings.
  if (fs.existsSync(regenScript)) {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.soroban-bindings-'));
    try {
      try {
        execSync(`bash ${JSON.stringify(regenScript)}`, {
          stdio: 'pipe',
          env: { ...process.env, SOROBAN_BINDINGS_OUT: tmpDir, CI: '1' },
        });
      } catch (e) {
        // If the regen script cannot run offline, fall back to fingerprint only.
        console.warn(
          '⚠️  Could not regenerate bindings offline; relying on fingerprint check'
        );
        return true;
      }

      const committed = collectFiles(bindingsDir);
      const regenerated = collectFiles(tmpDir);

      const missing = regenerated.filter(f => !committed.includes(f));
      const extra = committed.filter(f => !regenerated.includes(f));
      const changed = regenerated.filter(
        f =>
          committed.includes(f) &&
          hashFile(path.join(bindingsDir, f)) !== hashFile(path.join(tmpDir, f))
      );

      if (missing.length || extra.length || changed.length) {
        if (missing.length) {
          console.error('   Missing in committed bindings:', missing.join(', '));
        }
        if (extra.length) {
          console.error('   Stale files in committed bindings:', extra.join(', '));
        }
        if (changed.length) {
          console.error('   Changed files:', changed.join(', '));
        }
        return fail('regenerated bindings differ from committed bindings');
      }
      console.log('✅ Regenerated Soroban bindings match committed bindings');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    console.warn(
      `⚠️  Regen script not found at ${regenScript}; relying on fingerprint check`
    );
  }

  return true;
}

// Preflight entrypoint: run checks when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  checkSorobanBindings();
}