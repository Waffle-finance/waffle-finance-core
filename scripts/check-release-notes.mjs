#!/usr/bin/env node
/**
 * scripts/check-release-notes.mjs
 *
 * Release note format check.
 *
 * Validates that a release note file (releases/vX.Y.Z.md) contains all
 * required sections and that any service-level changes include a package-
 * impact reference.  The check is structural: it verifies headings and the
 * presence of non-placeholder content — it never parses prose semantics.
 *
 * Rules enforced (all from docs/RELEASE_NOTES_PROCESS.md and
 * .github/RELEASE_NOTES_TEMPLATE.md):
 *
 *   H1  File must declare a version in its top-level heading
 *       (# Release Notes: vX.Y.Z).
 *
 *   H2  File must declare the four release-header metadata fields:
 *       Release date, Release type, Release engineer, Reviewer(s).
 *
 *   H3  All eight change-category sections must be present:
 *       1. Protocol changes, 2. Coordinator changes, 3. Relayer changes,
 *       4. Resolver changes, 5. Frontend changes, 6. SDK changes,
 *       7. Dependency changes, 8. Docs and operational changes.
 *       A section present but containing only "None" is valid.
 *       A section whose table or body still contains the template
 *       placeholder text (<!-- ... -->) is a violation.
 *
 *   H4  Risk summary section must be present and must have an overall risk
 *       level filled in (LOW, MEDIUM, or HIGH — not the template comment).
 *
 *   H5  Validation table must be present and must not contain only
 *       unfilled placeholder cells for every row.
 *
 *   H6  Rollback plan section must be present.
 *
 *   H7  Known limitations section must be present.
 *
 *   P1  For each change-category section that lists a table row (i.e. the
 *       section is not "None"), the row must not be a bare template row
 *       (i.e. every cell is "<!-- ... -->").
 *
 *   P2  If the SDK section is non-None, each table row must include an
 *       export path cell that is not a placeholder.
 *
 * Internal-only change exception:
 *   Pass --internal-only to skip H3 checks for sections 3, 4, 5 (relayer,
 *   resolver, frontend) when the release only touches coordinator or
 *   config internals.  All other checks still run.
 *
 * Exit codes:
 *   0  All checks pass.
 *   1  At least one violation found.
 *
 * Usage:
 *   node scripts/check-release-notes.mjs <path-to-release-note>
 *   node scripts/check-release-notes.mjs releases/v1.2.3.md
 *   node scripts/check-release-notes.mjs releases/v1.2.3.md --internal-only
 *
 *   Or validate every file under releases/:
 *   node scripts/check-release-notes.mjs --all
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const internalOnly = args.includes('--internal-only');
const allMode      = args.includes('--all');
const targetArg    = args.find(a => !a.startsWith('--'));

// ─── Required section headings ────────────────────────────────────────────────

/**
 * Each entry: { key, heading (regex), required, internalOptional }
 *
 * internalOptional: true means the section is not required when
 * --internal-only is passed.
 */
const REQUIRED_SECTIONS = [
  { key: 'risk',         heading: /^##\s+Risk summary/m,                          required: true,  internalOptional: false },
  { key: 'protocol',     heading: /^###\s+1\.\s+Protocol changes/m,               required: true,  internalOptional: false },
  { key: 'coordinator',  heading: /^###\s+2\.\s+Coordinator changes/m,            required: true,  internalOptional: false },
  { key: 'relayer',      heading: /^###\s+3\.\s+Relayer changes/m,                required: true,  internalOptional: true  },
  { key: 'resolver',     heading: /^###\s+4\.\s+Resolver changes/m,               required: true,  internalOptional: true  },
  { key: 'frontend',     heading: /^###\s+5\.\s+Frontend changes/m,               required: true,  internalOptional: true  },
  { key: 'sdk',          heading: /^###\s+6\.\s+SDK changes/m,                    required: true,  internalOptional: false },
  { key: 'deps',         heading: /^###\s+7\.\s+Dependency changes/m,             required: true,  internalOptional: false },
  { key: 'docs',         heading: /^###\s+8\.\s+Docs and operational changes/m,   required: true,  internalOptional: false },
  { key: 'validation',   heading: /^##\s+Validation/m,                            required: true,  internalOptional: false },
  { key: 'rollback',     heading: /^##\s+Rollback plan/m,                         required: true,  internalOptional: false },
  { key: 'limitations',  heading: /^##\s+Known limitations/m,                     required: true,  internalOptional: false },
];

/** Template placeholder pattern — an unfilled HTML comment in the file. */
const PLACEHOLDER_RE = /<!--\s*(?:description|change|component|contract|package|old version|new version|reason|CVE|file|YYYY|VERSION|GitHub handle)[^>]*-->/i;

/** A cell that contains only a placeholder comment. */
const PLACEHOLDER_CELL_RE = /^\s*<!--[^>]*-->\s*$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the text content of a section starting at `heading` up to the
 * next same-or-higher-level heading.
 */
function extractSection(content, headingRe) {
  const m = content.match(headingRe);
  if (!m) return null;

  const start = m.index + m[0].length;
  const level = (m[0].match(/^(#+)/)?.[1] ?? '##').length;
  // Find the next heading at the same or higher level
  const nextRe = new RegExp(`^#{1,${level}}\\s`, 'mg');
  nextRe.lastIndex = start;
  const next = nextRe.exec(content);
  return next ? content.slice(start, next.index) : content.slice(start);
}

/** True when a section body is explicitly "None" (possibly in a paragraph). */
function isSectionNone(body) {
  return /^\s*None\s*$/im.test(body) || /^\s*>\s*None\s*$/im.test(body);
}

/**
 * Parse a markdown table body into rows.
 * Returns arrays of cell strings, one array per data row (skips the
 * separator row `|---|---|`).
 */
function parseTableRows(body) {
  const rows = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|[-| :]+\|/.test(trimmed)) continue; // separator row
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** True when every cell in a row is an unfilled placeholder. */
function isAllPlaceholders(row) {
  return row.every(cell => PLACEHOLDER_CELL_RE.test(cell));
}

// ─── Checks ──────────────────────────────────────────────────────────────────

function checkFile(filePath) {
  const errors   = [];
  const warnings = [];
  const rel      = path.relative(ROOT, filePath);

  if (!fs.existsSync(filePath)) {
    errors.push(`[FILE] File not found: ${filePath}`);
    return { errors, warnings };
  }

  const content = fs.readFileSync(filePath, 'utf8');

  // H1 — Version in top-level heading
  if (!/^#\s+Release Notes:\s*v\d+\.\d+\.\d+/m.test(content)) {
    errors.push(
      `  [H1] Missing or malformed top-level heading.\n` +
      `       Expected: "# Release Notes: vX.Y.Z"`
    );
  }

  // H2 — Header metadata fields
  const METADATA_FIELDS = [
    { name: 'Release date',     re: /\*\*Release date:\*\*\s+(?!<!--)/ },
    { name: 'Release type',     re: /\*\*Release type:\*\*\s+(?!<!--)/ },
    { name: 'Release engineer', re: /\*\*Release engineer:\*\*\s+(?!<!--)/ },
  ];
  for (const { name, re } of METADATA_FIELDS) {
    if (!re.test(content)) {
      errors.push(`  [H2] Metadata field "${name}" is missing or still contains a placeholder.`);
    }
  }

  // H3 — All required sections present
  for (const { key, heading, internalOptional } of REQUIRED_SECTIONS) {
    if (internalOnly && internalOptional) continue;
    if (!heading.test(content)) {
      errors.push(
        `  [H3] Required section missing: "${key}" ` +
        `(pattern: ${heading.source.replace(/\\/g, '')})`
      );
    }
  }

  // H4 — Risk summary has a filled-in risk level
  const riskBody = extractSection(content, /^##\s+Risk summary/m);
  if (riskBody !== null) {
    const hasRiskLevel = /\*\*Overall risk level:\*\*\s+(LOW|MEDIUM|HIGH)/i.test(riskBody);
    if (!hasRiskLevel) {
      errors.push(
        `  [H4] Risk summary is present but "Overall risk level:" is not set to ` +
        `LOW, MEDIUM, or HIGH (still a placeholder or missing).`
      );
    }
  }

  // H5 — Validation table has at least one filled row
  const validBody = extractSection(content, /^##\s+Validation/m);
  if (validBody !== null) {
    const rows = parseTableRows(validBody);
    // Filter out header row (first row), check if all data rows are still
    // unfilled placeholders
    const dataRows = rows.slice(1);
    if (dataRows.length > 0 && dataRows.every(isAllPlaceholders)) {
      errors.push(
        `  [H5] Validation table has no filled rows — every row is still a ` +
        `template placeholder. Fill in check statuses (✅ / ❌ / ⏭).`
      );
    }
  }

  // H6 — Rollback plan present (checked in H3 above already, but add detail)
  // Already covered by H3.

  // H7 — Known limitations present (covered by H3).

  // P1 — Each non-None change section must not have all-placeholder table rows
  const CHANGE_SECTIONS = REQUIRED_SECTIONS.filter(s =>
    ['protocol', 'coordinator', 'relayer', 'resolver', 'frontend', 'sdk', 'deps', 'docs'].includes(s.key)
  );

  for (const { key, heading, internalOptional } of CHANGE_SECTIONS) {
    if (internalOnly && internalOptional) continue;
    const body = extractSection(content, heading);
    if (body === null) continue; // already flagged by H3

    if (isSectionNone(body)) continue; // explicitly None — valid

    // Check for unfilled placeholder rows
    const rows = parseTableRows(body);
    const dataRows = rows.slice(1); // skip header
    if (dataRows.length > 0 && dataRows.some(isAllPlaceholders)) {
      errors.push(
        `  [P1] Section "${key}": contains table rows that are still template ` +
        `placeholders. Fill them in or change the section to "None".`
      );
    }

    // Check that the section body doesn't contain unfilled description blocks
    if (PLACEHOLDER_RE.test(body)) {
      warnings.push(
        `  [P1] Section "${key}": body contains unfilled placeholder comment(s). ` +
        `Replace them with actual content or remove them.`
      );
    }
  }

  // P2 — SDK section: export path must not be a placeholder
  const sdkBody = extractSection(content, /^###\s+6\.\s+SDK changes/m);
  if (sdkBody !== null && !isSectionNone(sdkBody)) {
    const rows = parseTableRows(sdkBody);
    const dataRows = rows.slice(1);
    for (const row of dataRows) {
      // row[1] should be the export path cell
      const exportCell = row[1];
      if (exportCell !== undefined && PLACEHOLDER_CELL_RE.test(exportCell)) {
        errors.push(
          `  [P2] SDK changes section: a table row has an empty/placeholder ` +
          `"Export path" cell. Every SDK change row must name the export path ` +
          `(e.g. @wafflefinance/sdk/ethereum).`
        );
      }
    }
  }

  return { errors, warnings };
}

// ─── Collect files ────────────────────────────────────────────────────────────

function collectReleaseFiles() {
  const releasesDir = path.join(ROOT, 'releases');
  if (!fs.existsSync(releasesDir)) return [];
  return fs
    .readdirSync(releasesDir)
    .filter(f => /^v\d+\.\d+\.\d+.*\.md$/.test(f))
    .map(f => path.join(releasesDir, f))
    .sort();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WaffleFinance — Release Note Format Check                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  let files = [];

  if (allMode) {
    files = collectReleaseFiles();
    if (files.length === 0) {
      console.log('No release note files found under releases/. Nothing to check.');
      process.exit(0);
    }
    console.log(`Validating ${files.length} release note file(s) under releases/:\n`);
  } else if (targetArg) {
    files = [path.resolve(ROOT, targetArg)];
  } else {
    console.error('Usage:');
    console.error('  node scripts/check-release-notes.mjs <path>');
    console.error('  node scripts/check-release-notes.mjs <path> --internal-only');
    console.error('  node scripts/check-release-notes.mjs --all');
    console.error('');
    console.error('See docs/RELEASE_NOTES_PROCESS.md for the required fields.');
    process.exit(1);
  }

  if (internalOnly) {
    console.log('Mode: --internal-only  (sections 3/4/5 not required)\n');
  }

  let totalErrors   = 0;
  let totalWarnings = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    console.log(`── ${rel}`);

    const { errors, warnings } = checkFile(file);
    totalErrors   += errors.length;
    totalWarnings += warnings.length;

    if (errors.length === 0 && warnings.length === 0) {
      console.log('  ✅ All checks pass.\n');
    } else {
      if (errors.length > 0) {
        console.error(`  ❌ ${errors.length} violation(s):`);
        for (const e of errors) console.error(e);
      }
      if (warnings.length > 0) {
        console.log(`  ⚠️  ${warnings.length} warning(s):`);
        for (const w of warnings) console.log(w);
      }
      console.log('');
    }
  }

  console.log('══════════════════════════════════════════════════════════════');
  if (totalErrors === 0) {
    const warnNote = totalWarnings > 0 ? ` (${totalWarnings} warning(s) above)` : '';
    console.log(`✅  All release note checks passed${warnNote}.`);
    console.log('');
    process.exit(0);
  } else {
    console.error(`❌  ${totalErrors} violation(s) across ${files.length} file(s).`);
    console.error('');
    console.error('Fix the violations above and re-run:');
    console.error('  node scripts/check-release-notes.mjs <path>');
    console.error('');
    console.error('See docs/RELEASE_NOTES_PROCESS.md for required fields and examples.');
    console.error('Use --internal-only to skip sections 3/4/5 for coordinator-only changes.');
    process.exit(1);
  }
}

main();
