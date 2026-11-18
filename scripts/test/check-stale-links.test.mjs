/**
 * scripts/test/check-stale-links.test.mjs
 *
 * Unit tests for scripts/check-stale-links.mjs.
 *
 * Run with:
 *   node --test scripts/test/check-stale-links.test.mjs
 *
 * Uses Node's built-in test runner (node:test) — no additional dependencies.
 *
 * Fixture layout:
 *   scripts/test/fixtures/stale-links/
 *     valid.md           — links that should all pass
 *     another.md         — target of valid.md's relative links
 *     broken.md          — links that should all fail
 *     subdir/nested.md   — target of valid.md's subdirectory link
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractLinks,
  checkBrokenLinks,
  collectMarkdownFiles,
} from '../check-stale-links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'stale-links');

// ---------------------------------------------------------------------------
// extractLinks
// ---------------------------------------------------------------------------

describe('extractLinks', () => {
  it('extracts a simple relative link', () => {
    const links = extractLinks('[text](other.md)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'other.md');
    assert.equal(links[0].lineNumber, 1);
  });

  it('strips the anchor fragment and keeps only the path', () => {
    const links = extractLinks('[text](other.md#section)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'other.md');
  });

  it('returns fragment as target when there is no path', () => {
    const links = extractLinks('[text](#heading)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, '#heading');
  });

  it('strips optional inline title', () => {
    const links = extractLinks('[text](other.md "a title")');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'other.md');
  });

  it('decodes percent-encoded targets', () => {
    const links = extractLinks('[text](a%20doc.md)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'a doc.md');
  });

  it('decodes simple percent-encoding (.md → %2emd)', () => {
    // %2e is the percent-encoded form of '.'
    const links = extractLinks('[text](another%2emd)');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'another.md');
  });

  it('skips links inside fenced code blocks', () => {
    const content = [
      '```markdown',
      '[broken](does-not-exist.md)',
      '```',
    ].join('\n');
    const links = extractLinks(content);
    assert.equal(links.length, 0);
  });

  it('skips links inside inline code spans', () => {
    const content = 'Use `[broken](does-not-exist.md)` syntax.';
    const links = extractLinks(content);
    assert.equal(links.length, 0);
  });

  it('reports correct line numbers', () => {
    const content = 'line one\nline two\n[text](target.md)\nline four';
    const links = extractLinks(content);
    assert.equal(links.length, 1);
    assert.equal(links[0].lineNumber, 3);
  });

  it('extracts multiple links from the same document', () => {
    const content = '[a](a.md)\n[b](b.md)\n[c](c.md)';
    const links = extractLinks(content);
    assert.equal(links.length, 3);
    assert.deepEqual(
      links.map((l) => l.target),
      ['a.md', 'b.md', 'c.md'],
    );
  });
});

// ---------------------------------------------------------------------------
// checkBrokenLinks — valid fixture
// ---------------------------------------------------------------------------

describe('checkBrokenLinks — valid fixture', () => {
  it('produces no errors for valid.md (all targets exist)', () => {
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    assert.equal(
      errors.length,
      0,
      `Expected 0 errors but got: ${JSON.stringify(errors)}`,
    );
  });

  it('does not flag external URLs', () => {
    const content = '[GitHub](https://github.com)\n[npm](http://npmjs.com)';
    const errors = checkBrokenLinks(
      // Write content to a temp in-memory check by using extractLinks directly
      // (checkBrokenLinks reads from disk, so use a fixture path)
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    // valid.md contains external links — confirm no errors
    assert.equal(errors.length, 0);
  });

  it('does not flag fragment-only links', () => {
    // valid.md includes `[heading](#valid-links-fixture)` — no error expected
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    assert.equal(errors.length, 0);
  });

  it('does not flag links inside fenced code blocks', () => {
    // valid.md has a fenced block containing [broken but inside a code block](this-does-not-exist.md)
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    assert.equal(errors.length, 0);
  });

  it('does not flag links inside inline code spans', () => {
    // valid.md has `[broken inline](nope.md)` in an inline code span
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    assert.equal(errors.length, 0);
  });

  it('resolves percent-encoded links correctly', () => {
    // valid.md contains [the other doc](another%2emd) which decodes to another.md
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'valid.md')],
      FIXTURES_DIR,
    );
    assert.equal(errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// checkBrokenLinks — broken fixture
// ---------------------------------------------------------------------------

describe('checkBrokenLinks — broken fixture', () => {
  it('reports errors for missing targets', () => {
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'broken.md')],
      FIXTURES_DIR,
    );
    assert.ok(
      errors.length >= 1,
      `Expected at least 1 error but got ${errors.length}`,
    );
  });

  it('includes the source file path in each error', () => {
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'broken.md')],
      FIXTURES_DIR,
    );
    for (const e of errors) {
      assert.ok(
        e.file.endsWith('broken.md'),
        `Expected error.file to end with broken.md, got ${e.file}`,
      );
    }
  });

  it('includes the missing target name in each error message', () => {
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'broken.md')],
      FIXTURES_DIR,
    );
    const targets = errors.map((e) => e.target);
    assert.ok(
      targets.includes('does-not-exist.md'),
      `Expected "does-not-exist.md" in targets, got ${JSON.stringify(targets)}`,
    );
  });

  it('includes a line number in each error', () => {
    const errors = checkBrokenLinks(
      [path.join(FIXTURES_DIR, 'broken.md')],
      FIXTURES_DIR,
    );
    for (const e of errors) {
      assert.ok(
        typeof e.line === 'number' && e.line >= 1,
        `Expected positive line number, got ${e.line}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// collectMarkdownFiles
// ---------------------------------------------------------------------------

describe('collectMarkdownFiles', () => {
  it('discovers all *.md files in the fixture directory', () => {
    const files = collectMarkdownFiles(FIXTURES_DIR, FIXTURES_DIR);
    const basenames = files.map((f) => path.relative(FIXTURES_DIR, f));
    assert.ok(
      basenames.includes('valid.md'),
      `Expected valid.md, got ${JSON.stringify(basenames)}`,
    );
    assert.ok(
      basenames.includes('another.md'),
      `Expected another.md, got ${JSON.stringify(basenames)}`,
    );
    assert.ok(
      basenames.some((b) => b.endsWith(path.join('subdir', 'nested.md'))),
      `Expected subdir/nested.md, got ${JSON.stringify(basenames)}`,
    );
  });

  it('does not include non-md files', () => {
    const files = collectMarkdownFiles(FIXTURES_DIR, FIXTURES_DIR);
    for (const f of files) {
      assert.ok(f.endsWith('.md'), `Non-.md file found: ${f}`);
    }
  });
});
