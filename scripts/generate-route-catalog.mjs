/**
 * scripts/generate-route-catalog.mjs
 *
 * Generates docs/ROUTE_CATALOG.md from the explicit metadata in
 * scripts/route-catalog-meta.mjs and optionally validates that the
 * metadata is internally consistent (drift-check mode).
 *
 * Usage:
 *   node scripts/generate-route-catalog.mjs          # generate + write
 *   node scripts/generate-route-catalog.mjs --check  # validate only, no write
 *
 * Exit codes:
 *   0  — success (no violations / catalog written)
 *   1  — validation failed (details printed to stderr)
 *
 * HOW DRIFT IS DETECTED
 *   In --check mode this script validates the metadata catalogue itself:
 *
 *   1. Every entry has all required fields (service, method, path, auth,
 *      health, summary, sourceRef).
 *   2. All field values are drawn from the declared enum sets.
 *   3. No two entries share the same (service, method, path) triple — a
 *      duplicate indicates a copy-paste error.
 *   4. The sourceRef file exists on disk — catches stale references to
 *      renamed or deleted route files.
 *
 *   Because the contributing rule is "add route → add metadata entry", a
 *   route that exists in code but not in this catalog will cause CI to fail
 *   once the developer runs `pnpm validate:routes` or the CI drift job runs.
 *
 * This script is intentionally dependency-free so it can run without
 * `pnpm install`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, AUTH_CLASSES, HEALTH_SEMANTICS } from './route-catalog-meta.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'ROUTE_CATALOG.md');

const CHECK_MODE = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = ['service', 'method', 'path', 'auth', 'health', 'summary', 'sourceRef'];
const VALID_SERVICES = new Set(['coordinator', 'relayer', 'resolver']);
const VALID_AUTH = new Set(AUTH_CLASSES);
const VALID_HEALTH = new Set(HEALTH_SEMANTICS);
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function validate(routes) {
  const errors = [];
  const seen = new Set();

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const label = `routes[${i}] ${r.method ?? '?'} ${r.path ?? '?'}`;

    // Required fields
    for (const field of REQUIRED_FIELDS) {
      if (!r[field] || typeof r[field] !== 'string' || r[field].trim() === '') {
        errors.push(`${label}: missing or empty required field "${field}"`);
      }
    }

    // Enum validation
    if (r.service && !VALID_SERVICES.has(r.service)) {
      errors.push(`${label}: unknown service "${r.service}" (expected one of: ${[...VALID_SERVICES].join(', ')})`);
    }
    if (r.method && !VALID_METHODS.has(r.method)) {
      errors.push(`${label}: unknown HTTP method "${r.method}"`);
    }
    if (r.auth && !VALID_AUTH.has(r.auth)) {
      errors.push(`${label}: unknown auth class "${r.auth}" (expected one of: ${AUTH_CLASSES.join(', ')})`);
    }
    if (r.health && !VALID_HEALTH.has(r.health)) {
      errors.push(`${label}: unknown health semantics "${r.health}" (expected one of: ${HEALTH_SEMANTICS.join(', ')})`);
    }

    // Duplicate detection
    const key = `${r.service}|${r.method}|${r.path}`;
    if (seen.has(key)) {
      errors.push(`${label}: duplicate route — (service=${r.service}, method=${r.method}, path=${r.path}) already defined`);
    }
    seen.add(key);

    // sourceRef file existence
    if (r.sourceRef) {
      const absRef = path.join(ROOT, r.sourceRef);
      if (!fs.existsSync(absRef)) {
        errors.push(`${label}: sourceRef "${r.sourceRef}" does not exist on disk — was the file renamed or deleted?`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

/** Escape pipe characters in Markdown table cells. */
function esc(str) {
  return str.replace(/\|/g, '\\|');
}

/** Map auth class → human-readable badge text. */
const AUTH_LABEL = {
  public: 'Public',
  operator: 'Operator token',
  'rate-limited': 'Rate-limited',
  internal: 'Internal',
};

/** Map health semantics → human-readable badge text. */
const HEALTH_LABEL = {
  liveness: 'Liveness',
  readiness: 'Readiness',
  metrics: 'Metrics',
  none: '—',
};

function generateMarkdown(routes) {
  const generatedAt = new Date().toISOString();

  const lines = [
    '# Route Catalog',
    '',
    '> **This file is generated.** Do not edit it directly.',
    '> To update it, edit `scripts/route-catalog-meta.mjs` and run:',
    '> ```bash',
    '> node scripts/generate-route-catalog.mjs',
    '> ```',
    '> To validate without writing, run:',
    '> ```bash',
    '> node scripts/generate-route-catalog.mjs --check',
    '> ```',
    '> Adding a route without an entry in `route-catalog-meta.mjs` will cause',
    '> `pnpm validate:routes` to fail.',
    '',
    `_Generated at ${generatedAt}_`,
    '',
    '---',
    '',
    '## Table of contents',
    '',
    '- [Authorization classes](#authorization-classes)',
    '- [Health semantics](#health-semantics)',
  ];

  // Per-service TOC entries
  const services = [...new Set(routes.map((r) => r.service))];
  for (const svc of services) {
    const anchor = svc.toLowerCase().replace(/\s+/g, '-');
    const capitalized = svc.charAt(0).toUpperCase() + svc.slice(1);
    lines.push(`- [${capitalized}](#${anchor})`);
  }

  lines.push(
    '',
    '---',
    '',
    '## Authorization classes',
    '',
    '| Class | Meaning |',
    '|---|---|',
    '| `public` | No authentication required; accessible to any caller. |',
    '| `operator` | Requires a valid operator bearer token (`COORDINATOR_OPERATOR_KEYS` or `RELAYER_ADMIN_KEY`). |',
    '| `rate-limited` | No token required, but subject to per-IP rate limiting. Resolvers with API keys bypass the limit. |',
    '| `internal` | Intended for service-to-service calls; not exposed to end users. No token but should be firewalled. |',
    '',
    '---',
    '',
    '## Health semantics',
    '',
    '| Value | Meaning |',
    '|---|---|',
    '| `liveness` | Container-orchestrator liveness probe; always returns 200 when the process is alive. |',
    '| `readiness` | Readiness probe; returns 503 when any configured dependency is not ready. |',
    '| `metrics` | Prometheus scrape endpoint. |',
    '| `none` | Not a health endpoint. |',
    '',
    '---',
    '',
  );

  // Per-service sections
  for (const svc of services) {
    const svcRoutes = routes.filter((r) => r.service === svc);
    const capitalized = svc.charAt(0).toUpperCase() + svc.slice(1);

    lines.push(
      `## ${capitalized}`,
      '',
      `| Method | Path | Auth | Health | Summary |`,
      `|---|---|---|---|---|`,
    );

    for (const r of svcRoutes) {
      const method = `\`${r.method}\``;
      const routePath = `\`${esc(r.path)}\``;
      const auth = AUTH_LABEL[r.auth] ?? r.auth;
      const health = HEALTH_LABEL[r.health] ?? r.health;
      const summary = esc(r.summary);
      lines.push(`| ${method} | ${routePath} | ${auth} | ${health} | ${summary} |`);
    }

    lines.push('', `_Source: see \`${svc}/src/\` routes directory_`, '', '---', '');
  }

  // Footer
  lines.push(
    '## Related documentation',
    '',
    '- [API Versioning Guide](../coordinator/docs/API_VERSIONING.md) — Accept-header versioning strategy and v1/v2 migration guide',
    '- [Integration Guide](../coordinator/docs/INTEGRATION_GUIDE.md) — Full request/response schemas and typical integration flow',
    '- [Operations Guide](OPERATIONS.md) — Deployment, runbooks, and incident response',
    '',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Route-registration scanner
// ---------------------------------------------------------------------------

/**
 * Scan a TypeScript route file for Express route-registration calls and
 * extract (method, path) pairs.
 *
 * Matches patterns like:
 *   router.get("/path", ...)
 *   router.post("/path", ...)
 *   app.get("/path", ...)
 *
 * Template-literal, single-quote, and double-quote string literals are all
 * supported.  Multi-line registrations where the path is on the same line as
 * the method call are handled.
 *
 * @param {string} filePath - Absolute path to the .ts route file.
 * @returns {{ method: string, path: string }[]}
 */
function scanRouteRegistrations(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const results = [];

  // Match: router.<method>("<path>" or '<path>' or `path`)
  // Also match: app.<method>("<path>")
  const routeRe = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\2/gi;
  let m;
  while ((m = routeRe.exec(content)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[3];
    // Skip non-route uses of .get/.post (e.g. obj.get("key"))
    // by requiring the path to start with / or :
    if (!path.startsWith('/') && !path.startsWith(':')) continue;
    results.push({ method, path });
  }

  return results;
}

/**
 * Compare route registrations found in source files against the metadata
 * catalog.  Returns an array of error strings for routes registered in code
 * but missing from the metadata.
 *
 * Mount prefixes (e.g. /api) are handled by suffix-matching: a metadata path
 * `/api/orders/announce` matches a code path `/orders/announce`.
 */
function checkCodeAgainstMetadata(routes, root) {
  const errors = [];

  // Group metadata entries by sourceRef
  const bySource = new Map();
  for (const r of routes) {
    if (!r.sourceRef) continue;
    if (!bySource.has(r.sourceRef)) bySource.set(r.sourceRef, []);
    bySource.get(r.sourceRef).push(r);
  }

  for (const [sourceRef, metaEntries] of bySource) {
    const absPath = path.join(root, sourceRef);
    if (!fs.existsSync(absPath)) continue; // already reported by sourceRef check

    const scanned = scanRouteRegistrations(absPath);
    if (scanned.length === 0) continue;

    for (const { method, path: codePath } of scanned) {
      // Check if any metadata entry for this file matches.
      // Match by method + suffix (handles mount prefixes).
      const found = metaEntries.some(
        (meta) =>
          meta.method === method &&
          (meta.path === codePath || meta.path.endsWith(codePath)),
      );
      if (!found) {
        errors.push(
          `route registered in ${sourceRef} but missing from metadata: ` +
          `${method} ${codePath} — add an entry to scripts/route-catalog-meta.mjs`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log(`Route catalog — ${CHECK_MODE ? 'checking metadata' : 'generating docs/ROUTE_CATALOG.md'}...\n`);
  console.log(`  Routes defined: ${ROUTES.length}`);

  const errors = validate(ROUTES);

  // Drift check: scan source files for route registrations not in metadata.
  // This catches the "added a route without metadata" case.
  const driftErrors = checkCodeAgainstMetadata(ROUTES, ROOT);
  errors.push(...driftErrors);

  if (errors.length > 0) {
    console.error(`\n❌  Route catalog validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(
      '\nFix the issues in scripts/route-catalog-meta.mjs and re-run:\n' +
      '  node scripts/generate-route-catalog.mjs --check\n' +
      '\nSee docs/ROUTE_CATALOG.md for the generated output.',
    );
    process.exit(1);
  }

  if (CHECK_MODE) {
    console.log('  ✅  Route catalog metadata is valid.');
    console.log(`\n  ${ROUTES.length} routes across ${new Set(ROUTES.map((r) => r.service)).size} services — no violations found.`);
    return;
  }

  const markdown = generateMarkdown(ROUTES);
  fs.writeFileSync(OUTPUT_PATH, markdown, 'utf8');

  const services = [...new Set(ROUTES.map((r) => r.service))];
  for (const svc of services) {
    const count = ROUTES.filter((r) => r.service === svc).length;
    console.log(`  ${svc}: ${count} route${count === 1 ? '' : 's'}`);
  }

  console.log(`\n✅  Written to docs/ROUTE_CATALOG.md (${markdown.length} bytes).`);
  console.log('\nTo validate without regenerating:');
  console.log('  node scripts/generate-route-catalog.mjs --check');
}

main();
