#!/usr/bin/env node
/**
 * scripts/check-debt-register.mjs
 *
 * Debt register format check and stale-review report.
 *
 * Validates every entry in docs/TECHNICAL_DEBT.md against the required
 * machine-readable schema, then reports items that are missing metadata,
 * have stale review dates, or lack an owner/next-action.
 *
 * Rules enforced (all from docs/TECHNICAL_DEBT_MAINTENANCE.md):
 *
 *   F1  Every entry heading must follow the pattern:
 *           ### TD-NNN · <title> <status-tag>
 *       where <status-tag> is one of:
 *           🔴  🟡  🟢  ✅
 *
 *   F2  Open entries (🔴 🟡 🟢) must have a "Discovered:" field.
 *
 *   F3  Open entries must have a "Location:" field with at least one file path.
 *
 *   F4  Open entries must have a "Next steps:" section with at least one
 *       numbered action item.
 *
 *   F5  Resolved entries (✅) must have a "Resolved:" field that includes a date
 *       in ISO-8601 format (YYYY-MM-DD).
 *
 *   F6  IDs must be unique across the register.
 *
 *   F7  IDs must be numeric (TD-000 to TD-999).
 *
 * Stale-review report (non-blocking warnings):
 *
 *   S1  Open 🔴 HIGH items whose "Discovered:" date is older than 90 days.
 *       Per the maintenance strategy, HIGH items should not go unowned for
 *       more than 90 days.
 *
 *   S2  Open 🟡 MED items whose "Discovered:" date is older than 180 days
 *       (roughly three release cycles).
 *
 *   S3  Resolved entries that have no PR/commit reference in their "Resolved:"
 *       line (no link to the implementation change).
 *
 * Exit codes:
 *   0  All format checks pass (warnings may still be printed).
 *   1  At least one format violation found.
 *
 * Usage:
 *   node scripts/check-debt-register.mjs
 *   pnpm validate:debt
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGISTER_PATH = path.join(ROOT, 'docs', 'TECHNICAL_DEBT.md');

// ─── Constants ───────────────────────────────────────────────────────────────

/** All recognised severity / status emoji tags. */
const OPEN_TAGS   = ['🔴', '🟡', '🟢'];
const CLOSED_TAG  = '✅';
const ALL_TAGS    = [...OPEN_TAGS, CLOSED_TAG];

/** Days before an open item is considered stale. */
const STALE_HIGH_DAYS = 90;
const STALE_MED_DAYS  = 180;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  return new Date();
}

function daysDiff(isoDate) {
  const then = new Date(isoDate);
  const now  = today();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

/** Extract YYYY-MM-DD from a string. Returns null if not found. */
function extractDate(text) {
  const m = text.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Returns true when a "Resolved:" line contains a PR/commit reference.
 * Accepts: GitHub PR URLs, #NNN PR numbers, commit hashes, Migration NNN.
 */
function hasResolutionLink(resolvedLine) {
  return (
    /https?:\/\//.test(resolvedLine) ||
    /#\d+/.test(resolvedLine) ||
    /\b[0-9a-f]{7,40}\b/i.test(resolvedLine) ||
    /migration\s+\d+/i.test(resolvedLine) ||
    /PR\s+\d+/i.test(resolvedLine) ||
    /commit\b/i.test(resolvedLine)
  );
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse docs/TECHNICAL_DEBT.md into a list of entry objects.
 *
 * We look for lines that match:
 *   ### TD-NNN · <title> <optional-tag>
 * and collect the block of text until the next such heading (or end of file).
 */
function parseEntries(content) {
  // A heading line: ### TD-NNN · …
  const HEADING_RE = /^### (TD-\d+)\s+·\s+(.+)$/;

  const lines   = content.split('\n');
  const entries = [];
  let   current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m    = line.match(HEADING_RE);

    if (m) {
      if (current) entries.push(current);

      const id    = m[1];
      const title = m[2].trim();

      // Detect the status tag from the title suffix
      let tag = null;
      for (const t of ALL_TAGS) {
        if (title.includes(t)) { tag = t; break; }
      }

      current = {
        id,
        title,
        tag,
        lineNumber: i + 1,
        body: '',
      };
    } else if (current) {
      current.body += line + '\n';
    }
  }

  if (current) entries.push(current);
  return entries;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

function checkFormat(entries) {
  const errors   = [];
  const warnings = [];
  const seenIds  = new Map(); // id → lineNumber

  for (const entry of entries) {
    const { id, title, tag, lineNumber, body } = entry;

    // F7 — ID must be numeric
    if (!/^TD-\d+$/.test(id)) {
      errors.push(`  [F7] Line ${lineNumber}: ID "${id}" is not in TD-NNN format.`);
    }

    // F6 — Unique IDs
    if (seenIds.has(id)) {
      errors.push(
        `  [F6] Line ${lineNumber}: Duplicate ID "${id}" ` +
        `(first seen at line ${seenIds.get(id)}).`
      );
    } else {
      seenIds.set(id, lineNumber);
    }

    // F1 — Must have a recognised status tag
    if (!tag) {
      errors.push(
        `  [F1] ${id} (line ${lineNumber}): heading has no recognised status tag ` +
        `(expected one of 🔴 🟡 🟢 ✅).`
      );
      continue; // further checks assume tag is known
    }

    // ── Resolved entries ──────────────────────────────────────────────────
    if (tag === CLOSED_TAG) {
      // F5 — Resolved date required
      const resolvedMatch = body.match(/\*\*Resolved:\*\*\s*(.+)/);
      if (!resolvedMatch) {
        errors.push(
          `  [F5] ${id} (line ${lineNumber}): resolved entry has no "Resolved:" field.`
        );
      } else {
        const resolvedLine = resolvedMatch[1];
        const date = extractDate(resolvedLine);
        if (!date) {
          errors.push(
            `  [F5] ${id} (line ${lineNumber}): "Resolved:" field has no ISO-8601 date ` +
            `(e.g. 2026-07-30).`
          );
        }
        // S3 — Resolved entries should link to their implementation change
        if (!hasResolutionLink(resolvedLine) && !hasResolutionLink(body)) {
          warnings.push(
            `  [S3] ${id} (line ${lineNumber}): resolved entry has no PR/commit reference ` +
            `in "Resolved:" or body — add a link so the implementation change is traceable.`
          );
        }
      }
      continue; // skip open-only checks for resolved entries
    }

    // ── Open entries (🔴 🟡 🟢) ───────────────────────────────────────────

    // F2 — Discovered date required
    const discoveredMatch = body.match(/\*\*Discovered:\*\*\s*(.+)/);
    if (!discoveredMatch) {
      errors.push(
        `  [F2] ${id} (line ${lineNumber}): open entry has no "Discovered:" field.`
      );
    }

    // F3 — Location required (must reference at least one file path)
    const locationMatch = body.match(/\*\*Location:\*\*\s*(.+)/);
    if (!locationMatch) {
      errors.push(
        `  [F3] ${id} (line ${lineNumber}): open entry has no "Location:" field.`
      );
    } else {
      // A valid location contains a file path hint (backtick path, slash path,
      // or an extension like .ts .sol .rs .sh .md)
      const loc = locationMatch[1];
      const hasPath = /`[^`]+`/.test(loc) || /\.[a-z]{1,4}\b/.test(loc) || /\//.test(loc);
      if (!hasPath) {
        errors.push(
          `  [F3] ${id} (line ${lineNumber}): "Location:" value "${loc.trim()}" ` +
          `does not appear to reference a file path.`
        );
      }
    }

    // F4 — Next steps required with at least one numbered action
    const hasNextSteps = /\*\*Next steps:\*\*/i.test(body);
    if (!hasNextSteps) {
      errors.push(
        `  [F4] ${id} (line ${lineNumber}): open entry has no "Next steps:" section.`
      );
    } else {
      // Must have at least one numbered item (1. or 1.)
      const hasNumberedItem = /^\s*\d+\.\s+\S/.test(body.split('**Next steps:**')[1] ?? '');
      if (!hasNumberedItem) {
        errors.push(
          `  [F4] ${id} (line ${lineNumber}): "Next steps:" section has no numbered ` +
          `action items — add at least one "1. …" item.`
        );
      }
    }

    // ── Stale review warnings ─────────────────────────────────────────────
    if (discoveredMatch) {
      const dateStr = extractDate(discoveredMatch[1]);
      if (dateStr) {
        const age = daysDiff(dateStr);
        if (tag === '🔴' && age > STALE_HIGH_DAYS) {
          warnings.push(
            `  [S1] ${id} (line ${lineNumber}): 🔴 HIGH item discovered ${dateStr} ` +
            `(${age} days ago) — per maintenance policy, HIGH items should be ` +
            `assigned and in progress within ${STALE_HIGH_DAYS} days.`
          );
        } else if (tag === '🟡' && age > STALE_MED_DAYS) {
          warnings.push(
            `  [S2] ${id} (line ${lineNumber}): 🟡 MED item discovered ${dateStr} ` +
            `(${age} days ago) — consider pulling this into an upcoming sprint ` +
            `(policy target: within ${STALE_MED_DAYS} days / ~3 release cycles).`
          );
        }
      }
    }
  }

  return { errors, warnings, seenIds };
}

// ─── Summary report ──────────────────────────────────────────────────────────

function printSummary(entries) {
  const open     = entries.filter(e => OPEN_TAGS.includes(e.tag));
  const resolved = entries.filter(e => e.tag === CLOSED_TAG);
  const byTag    = {};
  for (const t of OPEN_TAGS) byTag[t] = open.filter(e => e.tag === t).length;

  console.log('Register summary:');
  console.log(`  Total entries : ${entries.length}`);
  console.log(`  Open          : ${open.length}  ` +
    `(🔴 ${byTag['🔴']}  🟡 ${byTag['🟡']}  🟢 ${byTag['🟢']})`);
  console.log(`  Resolved (✅) : ${resolved.length}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WaffleFinance — Technical Debt Register Format Check        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Register: ${path.relative(ROOT, REGISTER_PATH)}`);
  console.log('Policy  : docs/TECHNICAL_DEBT_MAINTENANCE.md');
  console.log('');

  if (!fs.existsSync(REGISTER_PATH)) {
    console.error(`❌  Register not found: ${REGISTER_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(REGISTER_PATH, 'utf8');
  const entries = parseEntries(content);

  if (entries.length === 0) {
    console.error('❌  No TD-NNN entries found — is the file path correct?');
    process.exit(1);
  }

  printSummary(entries);

  const { errors, warnings } = checkFormat(entries);

  // Print results
  if (errors.length === 0) {
    console.log('✅  Format checks — all entries pass.');
  } else {
    console.error(`❌  Format violations (${errors.length}):`);
    for (const e of errors) console.error(e);
  }

  if (warnings.length > 0) {
    console.log('');
    console.log(`⚠️   Stale-review / traceability warnings (${warnings.length}):`);
    for (const w of warnings) console.log(w);
    console.log('');
    console.log(
      '  These warnings do not block CI — they flag items that may need attention\n' +
      '  at the next monthly debt review (see docs/TECHNICAL_DEBT_MAINTENANCE.md §M-02).'
    );
  } else {
    console.log('');
    console.log('✅  Stale-review report — no items flagged.');
  }

  if (errors.length > 0) {
    console.log('');
    console.log('Fix the format violations above and re-run:  pnpm validate:debt');
    console.log('Format spec: docs/TECHNICAL_DEBT_MAINTENANCE.md §"Process for adding new items"');
    process.exit(1);
  }

  console.log('');
  console.log('✅  Debt register format check passed.');
}

main();
