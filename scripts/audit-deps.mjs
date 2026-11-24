#!/usr/bin/env node
/**
 * audit-deps.mjs
 *
 * Runs `pnpm audit --json` across the workspace, filters the report to the
 * configured severity threshold, separates production from dev-only advisories,
 * and writes a machine-readable triage output to stdout (and optionally to a
 * file).
 *
 * Exit codes:
 *   0 — no unresolved advisories at or above the threshold in production deps
 *   1 — one or more unresolved high-severity production advisories found
 *   2 — audit command itself failed (pnpm not installed, network error, etc.)
 *
 * Usage:
 *   node scripts/audit-deps.mjs                  # threshold=high (default)
 *   node scripts/audit-deps.mjs --level moderate  # lower threshold
 *   node scripts/audit-deps.mjs --output audit-report.json
 *   node scripts/audit-deps.mjs --dev-only        # include dev deps in gate
 *
 * Suppression file:
 *   .audit-suppressions.json  — see docs/DEPENDENCY_AUDIT.md for format.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
const thresholdArg = getArg("--level") ?? "high";
const outputFile   = getArg("--output");
const includeDevDeps = args.includes("--dev-only");

if (!SEVERITY_ORDER.includes(thresholdArg)) {
  console.error(`[audit-deps] Unknown severity level: "${thresholdArg}". Use: ${SEVERITY_ORDER.join(", ")}`);
  process.exit(2);
}

const thresholdIndex = SEVERITY_ORDER.indexOf(thresholdArg);

// ── Load suppressions ─────────────────────────────────────────────────────────

const SUPPRESSIONS_FILE = resolve(ROOT, ".audit-suppressions.json");

/** @type {Array<{ghsa: string, owner: string, rationale: string, expires: string}>} */
let suppressions = [];

if (existsSync(SUPPRESSIONS_FILE)) {
  try {
    suppressions = JSON.parse(readFileSync(SUPPRESSIONS_FILE, "utf8"));
  } catch (e) {
    console.error(`[audit-deps] Failed to parse ${SUPPRESSIONS_FILE}: ${e.message}`);
    process.exit(2);
  }
}

function isSuppressed(ghsaId) {
  const entry = suppressions.find((s) => s.ghsa === ghsaId);
  if (!entry) return false;
  if (entry.expires === "permanent") return true;
  const expDate = new Date(entry.expires);
  if (isNaN(expDate.getTime())) {
    console.warn(`[audit-deps] Suppression for ${ghsaId} has invalid expiry "${entry.expires}" — treating as not suppressed.`);
    return false;
  }
  return Date.now() < expDate.getTime();
}

// ── Run pnpm audit ────────────────────────────────────────────────────────────

let rawOutput;
try {
  rawOutput = execSync("pnpm audit --json --audit-level=info", {
    cwd: ROOT,
    encoding: "utf8",
    // pnpm audit exits non-zero when vulnerabilities are found; we handle
    // that ourselves so we capture output regardless.
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (err) {
  // pnpm audit exits with a non-zero code when it finds advisories —
  // that is expected.  We only treat it as a hard failure when stdout
  // is empty (tool not installed, network failure, etc.).
  rawOutput = err.stdout ?? "";
  if (!rawOutput.trim()) {
    console.error("[audit-deps] pnpm audit produced no output. Is pnpm installed?");
    console.error(err.stderr ?? "");
    process.exit(2);
  }
}

// ── Parse audit report ────────────────────────────────────────────────────────

let auditData;
try {
  auditData = JSON.parse(rawOutput);
} catch {
  console.error("[audit-deps] Could not parse pnpm audit JSON output.");
  console.error(rawOutput.slice(0, 500));
  process.exit(2);
}

// pnpm audit --json structure:
// { advisories: { [id]: { id, ghsaId, severity, title, url, findings: [...] } }, metadata: {...} }
const advisories = auditData.advisories ?? {};

// ── Build triage records ──────────────────────────────────────────────────────

/**
 * @typedef {{
 *   ghsa: string,
 *   id: string | number,
 *   title: string,
 *   severity: string,
 *   url: string,
 *   affectedPackages: string[],
 *   installedVersions: string[],
 *   paths: string[],
 *   isDevOnly: boolean,
 *   suppressed: boolean,
 *   suppressionEntry: object | null,
 * }} TriageRecord
 */

/** @type {TriageRecord[]} */
const triageRecords = [];

for (const advisory of Object.values(advisories)) {
  const ghsaId = advisory.ghsaId ?? advisory.cves?.[0] ?? String(advisory.id);
  const severity = advisory.severity ?? "unknown";
  const severityIndex = SEVERITY_ORDER.indexOf(severity);

  // Skip advisories below the threshold entirely from the report.
  if (severityIndex < thresholdIndex) continue;

  const findings = advisory.findings ?? [];
  const affectedPackages = [...new Set(findings.map((f) => f.id ?? f.name ?? "unknown"))];
  const installedVersions = [...new Set(findings.map((f) => f.version ?? "unknown"))];
  const paths = findings.flatMap((f) => f.paths ?? []);

  // A finding is dev-only when every path that leads to it goes through a
  // devDependency root.  pnpm includes "dev" in the finding object when
  // the entire dependency chain is dev.
  const isDevOnly = findings.length > 0 && findings.every((f) => f.dev === true);

  const suppressed = isSuppressed(ghsaId);
  const suppressionEntry = suppressions.find((s) => s.ghsa === ghsaId) ?? null;

  triageRecords.push({
    ghsa: ghsaId,
    id: advisory.id,
    title: advisory.title ?? "(untitled)",
    severity,
    url: advisory.url ?? `https://github.com/advisories/${ghsaId}`,
    affectedPackages,
    installedVersions,
    paths: paths.slice(0, 10), // cap path list to keep output readable
    isDevOnly,
    suppressed,
    suppressionEntry,
  });
}

// Sort: unsuppressed first, then by severity (critical → low).
triageRecords.sort((a, b) => {
  if (a.suppressed !== b.suppressed) return a.suppressed ? 1 : -1;
  return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
});

// ── Build output document ────────────────────────────────────────────────────

const report = {
  _meta: {
    generatedAt: new Date().toISOString(),
    threshold: thresholdArg,
    suppressionsFile: existsSync(SUPPRESSIONS_FILE) ? SUPPRESSIONS_FILE : null,
    totalAdvisories: triageRecords.length,
    unsuppressed: triageRecords.filter((r) => !r.suppressed).length,
    productionUnsuppressed: triageRecords.filter((r) => !r.suppressed && !r.isDevOnly).length,
    devOnlyUnsuppressed: triageRecords.filter((r) => !r.suppressed && r.isDevOnly).length,
  },
  advisories: triageRecords,
};

const reportJson = JSON.stringify(report, null, 2);

if (outputFile) {
  writeFileSync(resolve(ROOT, outputFile), reportJson, "utf8");
  console.error(`[audit-deps] Report written to ${outputFile}`);
}

// ── Print human summary ───────────────────────────────────────────────────────

const { _meta: m } = report;

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║         WaffleFinance — Dependency Audit Report       ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`  Threshold    : ${thresholdArg}`);
console.log(`  Generated at : ${m.generatedAt}`);
console.log(`  Total at/above threshold : ${m.totalAdvisories}`);
console.log(`  Unsuppressed (production): ${m.productionUnsuppressed}`);
console.log(`  Unsuppressed (dev-only)  : ${m.devOnlyUnsuppressed}`);
console.log(`  Suppressed               : ${m.totalAdvisories - m.unsuppressed}`);

if (triageRecords.length === 0) {
  console.log(`\n  ✅ No advisories at or above "${thresholdArg}" severity found.\n`);
} else {
  console.log(`\n  Advisory list (${thresholdArg}+):\n`);
  for (const r of triageRecords) {
    const tag = r.suppressed
      ? "[SUPPRESSED]"
      : r.isDevOnly
        ? "[DEV-ONLY] "
        : "[PRODUCTION]";
    const sev = r.severity.toUpperCase().padEnd(8);
    console.log(`  ${tag} ${sev} ${r.ghsa} — ${r.title}`);
    console.log(`             Packages : ${r.affectedPackages.slice(0, 3).join(", ")}${r.affectedPackages.length > 3 ? ` (+${r.affectedPackages.length - 3} more)` : ""}`);
    console.log(`             Versions : ${r.installedVersions.join(", ")}`);
    console.log(`             Detail   : ${r.url}`);
    if (r.suppressed && r.suppressionEntry) {
      console.log(`             Owner    : ${r.suppressionEntry.owner}`);
      console.log(`             Rationale: ${r.suppressionEntry.rationale}`);
      console.log(`             Expires  : ${r.suppressionEntry.expires}`);
    }
    console.log();
  }
}

// ── Gate ──────────────────────────────────────────────────────────────────────

const gatedRecords = includeDevDeps
  ? triageRecords.filter((r) => !r.suppressed)
  : triageRecords.filter((r) => !r.suppressed && !r.isDevOnly);

if (gatedRecords.length > 0) {
  console.error(
    `[audit-deps] ❌ ${gatedRecords.length} unresolved ${includeDevDeps ? "" : "production "}advisory/advisories at "${thresholdArg}" or above.`,
  );
  console.error(
    `[audit-deps]    To suppress a reviewed finding add an entry to .audit-suppressions.json`,
  );
  console.error(
    `[audit-deps]    (see docs/DEPENDENCY_AUDIT.md for required fields: ghsa, owner, rationale, expires).`,
  );
  process.exit(1);
}

console.log(`[audit-deps] ✅ No unresolved ${includeDevDeps ? "" : "production "}advisories at "${thresholdArg}" or above.\n`);
process.exit(0);
