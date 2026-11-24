/**
 * scripts/test/check-docs-drift.test.mjs
 *
 * Unit tests for the pnpm --filter script-reference checks in
 * scripts/check-docs-drift.mjs (Check 6).
 *
 * Run with:
 *   node --test scripts/test/check-docs-drift.test.mjs
 *
 * Uses Node's built-in test runner (node:test) — no additional dependencies.
 *
 * Fixture layout:
 *   scripts/test/fixtures/pnpm-filter/
 *     valid-commands.md      — all pnpm --filter references are correct
 *     unknown-package.md     — references a package not in the workspace
 *     unknown-script.md      — references a script that does not exist
 *     shell-args.md          — CLI flags after a script name; must not be flagged
 *     workspace/             — fake workspace root used as pkgNameMap source
 *       package.json         — lists "packages/*" as workspaces
 *       packages/app/        — @wafflefinance/fixture-app with build/test/lint
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkScriptReferences,
  buildPkgNameMap,
} from '../check-docs-drift.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pnpm-filter');
const WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'workspace');

// Build the package name → directory map once for all tests.
const pkgNameMap = buildPkgNameMap(WORKSPACE_ROOT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the check against a single fixture file; returns the error array. */
function checkFile(filename) {
  return checkScriptReferences(
    [path.join(FIXTURES_DIR, filename)],
    pkgNameMap,
    WORKSPACE_ROOT,
  );
}

// ---------------------------------------------------------------------------
// Workspace fixture sanity
// ---------------------------------------------------------------------------

describe('fixture workspace', () => {
  it('resolves @wafflefinance/fixture-app from the workspace', () => {
    assert.ok(
      pkgNameMap.has('@wafflefinance/fixture-app'),
      `Expected @wafflefinance/fixture-app in pkgNameMap; got keys: ${[...pkgNameMap.keys()].join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// valid-commands.md — no errors expected
// ---------------------------------------------------------------------------

describe('checkScriptReferences — valid commands', () => {
  it('produces no errors for valid pnpm --filter invocations', () => {
    const errors = checkFile('valid-commands.md');
    assert.equal(
      errors.length,
      0,
      `Expected 0 errors but got:\n${JSON.stringify(errors, null, 2)}`,
    );
  });

  it('does not flag pnpm built-in verbs (install, exec) after --filter', () => {
    // valid-commands.md contains `pnpm --filter @wafflefinance/fixture-app install`
    // and `pnpm --filter @wafflefinance/fixture-app exec tsc --noEmit`
    const errors = checkFile('valid-commands.md');
    assert.equal(errors.length, 0);
  });

  it('does not flag placeholder syntax (<package-name>)', () => {
    // valid-commands.md contains `pnpm --filter <package-name> <script-name>`
    const errors = checkFile('valid-commands.md');
    assert.equal(errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// shell-args.md — CLI flags must never be false-positives
// ---------------------------------------------------------------------------

describe('checkScriptReferences — shell arguments are not script names', () => {
  it('does not flag --reporter as an unknown script', () => {
    const errors = checkFile('shell-args.md');
    assert.equal(
      errors.length,
      0,
      `Expected 0 errors (flags are not scripts) but got:\n${JSON.stringify(errors, null, 2)}`,
    );
  });

  it('does not flag --coverage as an unknown script', () => {
    const errors = checkFile('shell-args.md');
    const coverageError = errors.find((e) => e.invocation?.includes('--coverage'));
    assert.equal(coverageError, undefined, 'Should not flag --coverage');
  });

  it('does not flag short flags (-u) as unknown scripts', () => {
    const errors = checkFile('shell-args.md');
    assert.equal(errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// unknown-package.md — must report the bad package name
// ---------------------------------------------------------------------------

describe('checkScriptReferences — unknown package', () => {
  it('reports an error for a package not in the workspace', () => {
    const errors = checkFile('unknown-package.md');
    assert.ok(
      errors.length >= 1,
      `Expected at least 1 error but got ${errors.length}`,
    );
  });

  it('error message names the unknown package', () => {
    const errors = checkFile('unknown-package.md');
    const hasPackageInMessage = errors.some((e) =>
      e.message.includes('@wafflefinance/does-not-exist'),
    );
    assert.ok(
      hasPackageInMessage,
      `Expected error mentioning "@wafflefinance/does-not-exist"; got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });

  it('error includes the source file path', () => {
    const errors = checkFile('unknown-package.md');
    for (const e of errors) {
      assert.ok(
        e.file.endsWith('unknown-package.md'),
        `Expected error.file to end with unknown-package.md, got ${e.file}`,
      );
    }
  });

  it('error includes a positive line number', () => {
    const errors = checkFile('unknown-package.md');
    for (const e of errors) {
      assert.ok(
        typeof e.line === 'number' && e.line >= 1,
        `Expected positive line number, got ${e.line}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// unknown-script.md — must report the missing script
// ---------------------------------------------------------------------------

describe('checkScriptReferences — unknown script in a known package', () => {
  it('reports an error for a script that does not exist in the package', () => {
    const errors = checkFile('unknown-script.md');
    assert.ok(
      errors.length >= 1,
      `Expected at least 1 error but got ${errors.length}`,
    );
  });

  it('error message names the missing script', () => {
    const errors = checkFile('unknown-script.md');
    const hasDeploy = errors.some((e) => e.message.includes('"deploy"'));
    assert.ok(
      hasDeploy,
      `Expected error mentioning "deploy"; got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });

  it('error message names the target package', () => {
    const errors = checkFile('unknown-script.md');
    const hasPackage = errors.some((e) =>
      e.message.includes('@wafflefinance/fixture-app'),
    );
    assert.ok(
      hasPackage,
      `Expected error mentioning "@wafflefinance/fixture-app"; got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });

  it('error includes the source file path', () => {
    const errors = checkFile('unknown-script.md');
    for (const e of errors) {
      assert.ok(
        e.file.endsWith('unknown-script.md'),
        `Expected error.file to end with unknown-script.md, got ${e.file}`,
      );
    }
  });

  it('error includes a positive line number', () => {
    const errors = checkFile('unknown-script.md');
    for (const e of errors) {
      assert.ok(
        typeof e.line === 'number' && e.line >= 1,
        `Expected positive line number, got ${e.line}`,
      );
    }
  });

  it('invocation field is present in the error', () => {
    const errors = checkFile('unknown-script.md');
    for (const e of errors) {
      assert.ok(
        typeof e.invocation === 'string' && e.invocation.length > 0,
        `Expected non-empty invocation field, got ${JSON.stringify(e.invocation)}`,
      );
    }
  });
});
