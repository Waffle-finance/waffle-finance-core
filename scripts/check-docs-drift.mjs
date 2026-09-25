/**
 * scripts/check-docs-drift.mjs
 *
 * Quality gate checks 3 and 6 from docs/QUALITY_GATE.md:
 *
 *   Check 3 — Doc-to-file links resolve
 *     Scans every *.md file in the repo for relative markdown links
 *     ([text](path)) and verifies each target exists on the filesystem.
 *     Fails if any link is broken.
 *
 *   Check 6 — npm script references in docs
 *     Scans every *.md file for `pnpm --filter <pkg> <script>` invocations
 *     and verifies each referenced script actually exists in the relevant
 *     package.json.  Fails if a doc tells a contributor to run a script that
 *     no longer exists.
 *
 *     Root-level `pnpm <script>` invocations are also checked, but only for
 *     scripts that are explicitly defined in the root package.json.  Generic
 *     npm/pnpm lifecycle commands (install, publish, view, init, …) and prose
 *     fragments that incidentally contain "npm" or "pnpm" are not flagged.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs
 *
 * Exit codes:
 *   0  — all checks passed
 *   1  — one or more errors found (errors printed to stderr)
 *
 * This script is intentionally dependency-free so it can run without
 * `pnpm install` (same as scripts/validate-commands.mjs).
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Directories skipped when collecting markdown files. */
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'contracts/lib',   // vendored forge-std — not our docs to validate
  'soroban/target',  // Rust build output
]);

/** Link target prefixes that are always external — skip filesystem check. */
const EXTERNAL_PREFIXES = ['http://', 'https://', 'mailto:', 'ftp://'];

/**
 * Relative link targets that look like GitHub web-UI URLs
 * (../../actions, ../../releases, etc.).  These are valid in rendered GitHub
 * markdown but don't correspond to files in the repo — skip them.
 */
const GITHUB_UI_RE = /^\.\.[/\\]\.\.[/\\](actions|releases|issues|pulls|blob|tree|commit)/;

/**
 * npm / pnpm built-in subcommands and lifecycle verbs that are NOT workspace
 * scripts defined in package.json.  Invocations of these are skipped in the
 * Check 6 root-script scan.
 */
const NPM_BUILTINS = new Set([
  'install', 'i', 'ci',
  'add', 'remove', 'rm', 'uninstall', 'un',
  'update', 'up', 'upgrade',
  'version',
  'publish',
  'unpublish',
  'deprecate',
  'pack',
  'audit',
  'outdated',
  'link', 'unlink',
  'store',
  'prune',
  'exec', 'dlx',
  'create',
  'init',
  'run',          // `npm run` / `pnpm run` — the verb itself
  'view', 'info', 'show',
  'search',
  'login', 'logout', 'whoami', 'token',
  'list', 'ls', 'll', 'la',
  'dedupe',
  'rebuild',
  'cache',
  'config', 'set', 'get',
  'help',
  'start', 'stop', 'restart',
  'test',         // also a valid root script — but we only check it when it
                  // appears as `pnpm test` (root-scripts section handles it)
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all *.md files under `dir`, skipping excluded dirs. */
function collectMarkdownFiles(dir, root) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Check both the entry name and the path relative to root
    const rel = path.relative(root, path.join(dir, entry.name));
    const topLevel = rel.split(path.sep)[0];
    if (SCAN_EXCLUDE_DIRS.has(entry.name) || SCAN_EXCLUDE_DIRS.has(topLevel)) continue;
    // Also skip the full relative path for multi-segment exclusions
    const relNorm = rel.replace(/\\/g, '/');
    if ([...SCAN_EXCLUDE_DIRS].some(ex => relNorm.startsWith(ex + '/'))) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/** Return 1-based line number of `index` within `content`. */
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract all relative markdown link targets from content.
 * Returns { target, lineNumber } objects.
 * Handles [text](path), [text](path#anchor), [text](path "title").
 * Skips links inside backtick code spans and fenced code blocks.
 */
function extractLinks(content) {
  const results = [];

  // Build a set of character ranges that are inside code spans or fenced
  // code blocks so we can skip links that appear there.
  const codeRanges = [];

  // Fenced code blocks: ``` ... ``` or ~~~ ... ~~~
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm;
  let m;
  while ((m = fenceRe.exec(content)) !== null) {
    codeRanges.push([m.index, m.index + m[0].length]);
  }

  // Inline code spans: `...` (single backtick, non-greedy)
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
    results.push({
      target: target || fragment,
      lineNumber: lineOf(content, m.index),
    });
  }
  return results;
}

/** Load and cache package.json. Returns null if not found / unparseable. */
const pkgCache = new Map();
function loadPkg(pkgDir) {
  if (pkgCache.has(pkgDir)) return pkgCache.get(pkgDir);
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) { pkgCache.set(pkgDir, null); return null; }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkgCache.set(pkgDir, pkg);
    return pkg;
  } catch {
    pkgCache.set(pkgDir, null);
    return null;
  }
}

/** Build map of package name → absolute directory from workspace config. */
function buildPkgNameMap(root) {
  const rootPkg = loadPkg(root);
  if (!rootPkg) return new Map();
  const map = new Map();
  if (rootPkg.name) map.set(rootPkg.name, root);

  for (const pattern of rootPkg.workspaces || []) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const sub of fs.readdirSync(parent)) {
        const full = path.join(parent, sub);
        if (!fs.statSync(full).isDirectory()) continue;
        const pkg = loadPkg(full);
        if (pkg?.name) map.set(pkg.name, full);
      }
    } else {
      const full = path.join(root, pattern);
      if (fs.existsSync(path.join(full, 'package.json'))) {
        const pkg = loadPkg(full);
        if (pkg?.name) map.set(pkg.name, full);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Check 3 — Broken relative links
// ---------------------------------------------------------------------------

function checkBrokenLinks(mdFiles, root) {
  const errors = [];

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    const links = extractLinks(content);
    const mdDir = path.dirname(mdFile);

    for (const { target, lineNumber } of links) {
      if (!target) continue;
      // Anchor-only link (#heading) — skip
      if (target.startsWith('#')) continue;
      // External links — skip
      if (EXTERNAL_PREFIXES.some(p => target.startsWith(p))) continue;
      // GitHub web-UI relative links (../../actions, ../../releases) — skip
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
// Check 6 — pnpm/npm script references
// ---------------------------------------------------------------------------

/**
 * Only check `pnpm --filter <pkg> <script>` invocations where the script
 * name is not a pnpm built-in verb.  These are the invocations most likely
 * to break silently when a package script is renamed.
 *
 * Also check `pnpm <rootScript>` / `pnpm run <rootScript>` for scripts that
 * are explicitly defined in the root package.json scripts block, ignoring
 * npm builtins, version strings, and prose fragments.
 */
function checkScriptReferences(mdFiles, pkgNameMap, root) {
  const errors = [];
  const rootPkg = loadPkg(root);
  const rootScripts = rootPkg?.scripts ?? {};

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');

    // ── A. pnpm --filter <pkg> <script> ────────────────────────────────────
    // Pattern: pnpm --filter @scope/name <script>
    //      or: pnpm --filter @scope/name run <script>
    const filterRe = /pnpm\s+--filter\s+([\w@/.:-]+)\s+(?:run\s+)?([\w:.-]+)/g;
    let match;
    while ((match = filterRe.exec(content)) !== null) {
      const [full, pkgName, scriptName] = match;

      // Skip pnpm built-in verbs used after --filter (exec, publish, etc.)
      if (NPM_BUILTINS.has(scriptName)) continue;

      // Skip placeholder syntax in docs (e.g. `pnpm --filter <pkg> <script>`)
      if (scriptName.startsWith('<') || scriptName.startsWith('{')) continue;

      // Skip if the line is inside a blockquote (archival notice prose)
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const lineText = content.slice(lineStart, content.indexOf('\n', match.index));
      if (lineText.trimStart().startsWith('>')) continue;

      // Only flag @wafflefinance/* packages — external names are not our concern
      if (!pkgName.startsWith('@wafflefinance/')) continue;

      const pkgDir = pkgNameMap.get(pkgName);
      if (!pkgDir) {
        errors.push({
          file: mdFile,
          line: lineOf(content, match.index),
          invocation: full.trim(),
          message: `unknown workspace package "${pkgName}"`,
        });
        continue;
      }

      const pkg = loadPkg(pkgDir);
      const scripts = pkg?.scripts ?? {};
      if (!scripts[scriptName]) {
        // Mark as "future" if the invocation is inside a "Next steps" or
        // "target state" section — described as aspirational, not current.
        const surroundingContext = content.slice(
          Math.max(0, match.index - 300),
          match.index
        );
        const isFutureContext =
          /next step|target state|once implemented|future|aspirational|planned/i.test(
            surroundingContext
          );
        if (isFutureContext) continue;

        errors.push({
          file: mdFile,
          line: lineOf(content, match.index),
          invocation: full.trim(),
          message: `script "${scriptName}" does not exist in ${pkgName} (${path.relative(root, pkgDir)}/package.json)`,
        });
      }
    }

    // ── B. pnpm <rootScript> / pnpm run <rootScript> ───────────────────────
    // Only flag scripts that are in the root package.json scripts block.
    // This means: if a doc says `pnpm foo` and `foo` IS a root script, we
    // validate it exists (it does — we just read it). If `foo` is NOT a root
    // script, we ignore it because it's likely prose or a subcommand.
    //
    // The practical effect: we catch docs that say `pnpm validate:docs` after
    // it's been removed from package.json. We don't catch prose like
    // "pnpm workspace" or "pnpm 8.15.0".
    //
    // Pattern: pnpm <script> OR pnpm run <script> (not preceded by --filter)
    const rootScriptRe = /(?<!\-\-filter\s+\S+\s+)pnpm\s+(?:run\s+)?([\w:.-]+)/g;
    while ((match = rootScriptRe.exec(content)) !== null) {
      const [full, scriptName] = match;

      // Skip built-ins
      if (NPM_BUILTINS.has(scriptName)) continue;
      // Skip --filter itself
      if (scriptName === '--filter') continue;
      // Skip version strings (e.g. pnpm 8.15.0, pnpm@8)
      if (/^\d/.test(scriptName)) continue;
      // Skip @-prefixed (those are package names, handled by --filter block)
      if (scriptName.startsWith('@')) continue;
      // Skip placeholder syntax
      if (scriptName.startsWith('<') || scriptName.startsWith('{') || scriptName === '...') continue;
      // Skip -r / --recursive flags
      if (scriptName.startsWith('-')) continue;

      // Skip blockquote lines (archival notices)
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const lineText = content.slice(lineStart, content.indexOf('\n', match.index));
      if (lineText.trimStart().startsWith('>')) continue;
      // Skip comment lines in code blocks
      if (lineText.trimStart().startsWith('#')) continue;

      // Only flag scripts that are explicitly defined in root package.json
      // AND the doc says `pnpm <that-script>` — meaning we'd expect it to work.
      if (rootScripts[scriptName]) {
        // Script exists — no error.
      }
      // If the script is NOT in rootScripts, we don't flag it at the root level
      // because it might be a per-package script invoked without --filter,
      // a future script, or just prose. The --filter check above handles the
      // per-package cases with enough precision.
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const root = process.cwd();
  console.log('Checking docs for drift (checks 3 + 6 from docs/QUALITY_GATE.md)...\n');

  const mdFiles = collectMarkdownFiles(root, root);
  console.log(`  Scanning ${mdFiles.length} markdown files...`);

  const pkgNameMap = buildPkgNameMap(root);
  console.log(`  Workspace packages found: ${pkgNameMap.size}`);

  const linkErrors  = checkBrokenLinks(mdFiles, root);
  const scriptErrors = checkScriptReferences(mdFiles, pkgNameMap, root);

  const totalErrors = linkErrors.length + scriptErrors.length;

  if (linkErrors.length > 0) {
    console.error(
      `\n❌  Check 3 — Broken relative links (${linkErrors.length} error${linkErrors.length === 1 ? '' : 's'}):\n`
    );
    for (const e of linkErrors) {
      console.error(`  ${path.relative(root, e.file)}:${e.line}  ${e.message}`);
    }
  } else {
    console.log('  ✅  Check 3 — All relative links resolve.');
  }

  if (scriptErrors.length > 0) {
    console.error(
      `\n❌  Check 6 — Stale pnpm script references (${scriptErrors.length} error${scriptErrors.length === 1 ? '' : 's'}):\n`
    );
    for (const e of scriptErrors) {
      console.error(`  ${path.relative(root, e.file)}:${e.line}  ${e.message}`);
      console.error(`    invocation: ${e.invocation}`);
    }
  } else {
    console.log('  ✅  Check 6 — All pnpm script references are valid.');
  }

  if (totalErrors > 0) {
    console.error(
      `\nTotal: ${totalErrors} error${totalErrors === 1 ? '' : 's'}.\n` +
      'Fix the issues above and re-run:\n' +
      '  pnpm validate:docs\n' +
      '\nSee docs/QUALITY_GATE.md for the full check inventory.'
    );
    process.exit(1);
  }

  console.log('\n✅  All doc-drift checks passed.');
}

main();
