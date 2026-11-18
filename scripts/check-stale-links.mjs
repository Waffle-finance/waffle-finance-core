/**
 * scripts/check-stale-links.mjs
 *
 * Lightweight stale-link checker for local Markdown references.
 *
 * Resolves every relative link in every *.md file and reports targets that do
 * not exist on the filesystem.  External URLs (http/https/mailto/ftp), bare
 * fragment-only links (#heading), and links appearing inside fenced code
 * blocks or inline code spans are deliberately ignored.
 *
 * This module is designed to be both runnable as a standalone script and
 * importable by the test suite (scripts/test/check-stale-links.test.mjs).
 *
 * The check is also incorporated into the existing docs-drift runner
 * (scripts/check-docs-drift.mjs) as Check 3, so existing callers are
 * unaffected.  This module provides the same logic as a named export so it
 * can be unit-tested against fixture files.
 *
 * Usage (standalone):
 *   node scripts/check-stale-links.mjs
 *
 * Exit codes:
 *   0  — all relative links resolve
 *   1  — one or more broken links found (details printed to stderr)
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Top-level directory names that are always excluded from the scan. */
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'contracts/lib',
  'soroban/target',
]);

/** URL schemes that identify an external link — no filesystem check needed. */
const EXTERNAL_PREFIXES = ['http://', 'https://', 'mailto:', 'ftp://'];

/**
 * Pattern matching GitHub web-UI relative URLs that are valid in rendered
 * markdown but do not correspond to repo files (e.g. ../../actions).
 */
const GITHUB_UI_RE = /^\.\.[/\\]\.\.[/\\](actions|releases|issues|pulls|blob|tree|commit)/;

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all *.md files under `dir`, skipping excluded dirs.
 *
 * @param {string} dir   - Directory to scan.
 * @param {string} root  - Repository root (used to compute relative paths for
 *                         the exclude-list check).
 * @returns {string[]}   - Absolute paths to every discovered *.md file.
 */
export function collectMarkdownFiles(dir, root) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(root, path.join(dir, entry.name));
    const topLevel = rel.split(path.sep)[0];
    if (SCAN_EXCLUDE_DIRS.has(entry.name) || SCAN_EXCLUDE_DIRS.has(topLevel)) continue;
    const relNorm = rel.replace(/\\/g, '/');
    if ([...SCAN_EXCLUDE_DIRS].some((ex) => relNorm.startsWith(ex + '/'))) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/** Return the 1-based line number of `index` within `content`. */
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract all local Markdown link targets from `content`.
 *
 * Handles:
 *   - `[text](path)` and `[text](path#anchor)` and `[text](path "title")`
 *   - Percent-encoded targets (decoded before filesystem resolution)
 *   - Links inside fenced code blocks and inline code spans are skipped
 *
 * @param {string} content - Raw Markdown source.
 * @returns {{ target: string, lineNumber: number }[]}
 */
export function extractLinks(content) {
  const results = [];

  // Build ranges covering fenced code blocks and inline code spans so we can
  // skip links that appear inside them.
  const codeRanges = [];

  // Fenced code blocks: ``` ... ``` or ~~~ ... ~~~
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm;
  let m;
  while ((m = fenceRe.exec(content)) !== null) {
    codeRanges.push([m.index, m.index + m[0].length]);
  }

  // Inline code spans: `...` (single backtick, non-greedy, no newline)
  const inlineCodeRe = /`[^`\n]+`/g;
  while ((m = inlineCodeRe.exec(content)) !== null) {
    codeRanges.push([m.index, m.index + m[0].length]);
  }

  function isInsideCode(index) {
    for (const [start, end] of codeRanges) {
      if (index >= start && index < end) return true;
    }
    return false;
  }

  const linkRe = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
  while ((m = linkRe.exec(content)) !== null) {
    if (isInsideCode(m.index)) continue;

    let raw = m[1].trim();
    // Strip optional trailing title: path "title" or path 'title'
    raw = raw.replace(/\s+["'][^"']*["']\s*$/, '').trim();
    // Split off anchor fragment
    const hashIdx = raw.indexOf('#');
    const target = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? '' : raw.slice(hashIdx);

    // Decode percent-encoding so filesystem resolution handles spaces, etc.
    let decoded = target || fragment;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Malformed percent-encoding — keep raw value; filesystem check will
      // report the missing file naturally.
    }

    results.push({
      target: decoded,
      lineNumber: lineOf(content, m.index),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Broken-link check
// ---------------------------------------------------------------------------

/**
 * Check all relative Markdown links in `mdFiles` and return an array of
 * error objects for links whose targets do not exist on the filesystem.
 *
 * @param {string[]} mdFiles - Absolute paths to Markdown files to check.
 * @param {string}   root    - Repository root (used in error messages).
 * @returns {{ file: string, line: number, target: string, message: string }[]}
 */
export function checkBrokenLinks(mdFiles, root) {
  const errors = [];

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    const links = extractLinks(content);
    const mdDir = path.dirname(mdFile);

    for (const { target, lineNumber } of links) {
      if (!target) continue;
      // Fragment-only link (#heading) — no file to resolve
      if (target.startsWith('#')) continue;
      // External URL — no filesystem check
      if (EXTERNAL_PREFIXES.some((p) => target.startsWith(p))) continue;
      // GitHub web-UI relative URL (../../actions, etc.) — skip
      if (GITHUB_UI_RE.test(target)) continue;

      const resolved = path.resolve(mdDir, target);
      if (!fs.existsSync(resolved)) {
        errors.push({
          file: mdFile,
          line: lineNumber,
          target,
          message: `broken link → target does not exist: ${path.relative(root, resolved)}`,
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

/**
 * Run the stale-link check over the entire repository from `cwd` and exit
 * with code 1 if any broken links are found.
 *
 * @param {string} [root] - Repository root.  Defaults to `process.cwd()`.
 */
export function run(root = process.cwd()) {
  console.log('Checking Markdown files for broken local links...\n');

  const mdFiles = collectMarkdownFiles(root, root);
  console.log(`  Scanning ${mdFiles.length} Markdown files...`);

  const errors = checkBrokenLinks(mdFiles, root);

  if (errors.length === 0) {
    console.log('  ✅  All relative links resolve.\n');
    return;
  }

  console.error(`\n❌  Broken links found (${errors.length}):\n`);
  for (const e of errors) {
    const rel = path.relative(root, e.file);
    console.error(`  ${rel}:${e.line}  ${e.message}`);
  }
  console.error(
    `\nTotal: ${errors.length} broken link${errors.length === 1 ? '' : 's'}.\n` +
      'Fix the links above and re-run:\n' +
      '  pnpm validate:docs\n',
  );
  process.exit(1);
}

// Run when executed directly (node scripts/check-stale-links.mjs)
// Use a URL comparison rather than a __filename check to stay ESM-compatible.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  run();
}
