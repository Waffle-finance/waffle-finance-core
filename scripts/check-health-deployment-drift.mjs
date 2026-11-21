#!/usr/bin/env node
// scripts/check-health-deployment-drift.mjs
//
// Dependency-free validator that compares health route definitions against
// deployment field references. It reports stale or missing references using
// the same file-and-key diagnostic style as scripts/check-docs-drift.mjs.
//
// Usage:
//   node scripts/check-health-deployment-drift.mjs [--root <dir>]
//
// Fixtures live under scripts/test/fixtures/health-deployment/ with both
// stale and valid cases. Exit code is non-zero when drift is detected.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: resolve(__dirname, "..") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      args.root = resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      args.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "check-health-deployment-drift",
      "",
      "Compares health route definitions against deployment field references.",
      "",
      "Options:",
      "  --root <dir>   Repository root to scan (default: repo root)",
      "  -h, --help     Show this help",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Diagnostic helpers (mirrors scripts/check-docs-drift.mjs output style)
// ---------------------------------------------------------------------------

const diagnostics = [];

function reportError(file, key, message) {
  diagnostics.push({ level: "error", file, key, message });
}

function reportWarning(file, key, message) {
  diagnostics.push({ level: "warning", file, key, message });
}

function formatDiagnostic(d) {
  const location = d.key ? `${d.file} [${d.key}]` : d.file;
  return `${d.level}: ${location}: ${d.message}`;
}

function printDiagnostics() {
  if (diagnostics.length === 0) {
    process.stdout.write("health-deployment drift: OK\n");
    return;
  }
  for (const d of diagnostics) {
    process.stdout.write(`${formatDiagnostic(d)}\n`);
  }
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const warnings = diagnostics.filter((d) => d.level === "warning").length;
  process.stdout.write(
    `\nhealth-deployment drift: ${errors} error(s), ${warnings} warning(s)\n`,
  );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function walk(dir, predicate, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, predicate, results);
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    reportError(file, null, `failed to parse JSON: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health route extraction
// ---------------------------------------------------------------------------

// Supported aliases for health route keys in a routes manifest.
const HEALTH_ROUTE_ALIASES = [
  "health",
  "healthz",
  "healthCheck",
  "health_check",
  "healthcheck",
  "liveness",
  "readiness",
  "live",
  "ready",
];

// Extract health route paths from a routes manifest object.
// Accepts shapes like:
//   { routes: { health: "/healthz" } }
//   { health: "/healthz" }
//   { routes: [{ name: "health", path: "/healthz" }] }
function extractHealthRoutes(manifest) {
  const routes = new Map(); // routePath -> key
  if (!manifest || typeof manifest !== "object") return routes;

  const collect = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (HEALTH_ROUTE_ALIASES.includes(key)) {
        if (typeof value === "string") {
          routes.set(value, key);
        } else if (value && typeof value === "object" && typeof value.path === "string") {
          routes.set(value.path, key);
        }
      }
    }
  };

  collect(manifest);
  if (manifest.routes) {
    if (Array.isArray(manifest.routes)) {
      for (const route of manifest.routes) {
        if (!route || typeof route !== "object") continue;
        const name = route.name || route.key;
        if (typeof name === "string" && HEALTH_ROUTE_ALIASES.includes(name)) {
          const path = route.path || route.route;
          if (typeof path === "string") routes.set(path, name);
        }
      }
    } else {
      collect(manifest.routes);
    }
  }
  return routes;
}

// Extract health route paths from source files via simple regex scanning.
const HEALTH_ROUTE_REGEX =
  /(?:app|router|server|fastify|hono)\s*\.\s*(?:get|all|route)\s*\(\s*["'`](\/[^"'`]*(?:health|healthz|live|ready)[^"'`]*)["'`]/gi;

function extractHealthRoutesFromSource(file) {
  const routes = new Map();
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return routes;
  }
  let match;
  while ((match = HEALTH_ROUTE_REGEX.exec(content)) !== null) {
    routes.set(match[1], "source");
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Deployment field extraction
// ---------------------------------------------------------------------------

// Extract referenced health-related fields from a deployment record.
// Returns a Map of fieldPath -> value.
function extractDeploymentFields(record) {
  const fields = new Map();
  if (!record || typeof record !== "object") return fields;

  const visit = (node, prefix) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, idx) => visit(item, `${prefix}[${idx}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const next = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === "object") {
          visit(value, next);
        } else {
          fields.set(next, value);
        }
      }
    }
  };

  visit(record, "");
  return fields;
}

// Determine whether a deployment field path refers to a health route.
function isHealthFieldPath(path) {
  const lower = path.toLowerCase();
  return (
    lower.includes("health") ||
    lower.includes("liveness") ||
    lower.includes("readiness") ||
    lower.includes("healthcheck")
  );
}

// Extract health-related env var references from an env example file.
// Returns a Map of envKey -> value.
function extractEnvHealthFields(file) {
  const fields = new Map();
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return fields;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (isHealthFieldPath(key)) {
      fields.set(key, value);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

// Normalize a route path for comparison (strip trailing slash, ensure leading /).
function normalizeRoute(path) {
  if (typeof path !== "string") return "";
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// Check that a deployment/env reference to a health route resolves to a
// known health route path.
function checkHealthReference(refPath, refValue, knownRoutes, sourceFile, sourceKey) {
  if (typeof refValue !== "string" || refValue.length === 0) return;
  // Only validate values that look like route paths.
  if (!refValue.startsWith("/")) return;
  const normalized = normalizeRoute(refValue);
  if (!knownRoutes.has(normalized)) {
    reportError(
      sourceFile,
      sourceKey,
      `references health route "${refValue}" (${refPath}) which is not defined in any routes manifest or source file`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;

  // 1. Collect known health routes from manifests and source files.
  const knownRoutes = new Map(); // normalizedPath -> { file, key }

  const manifestFiles = walk(
    root,
    (f) =>
      /(?:routes|health)[^/]*\.json$/i.test(f) &&
      !f.includes(`${join("scripts", "test", "fixtures")}`),
  );
  for (const file of manifestFiles) {
    const manifest = readJson(file);
    if (!manifest) continue;
    const routes = extractHealthRoutes(manifest);
    for (const [path, key] of routes) {
      knownRoutes.set(normalizeRoute(path), { file, key });
    }
  }

  const sourceFiles = walk(
    root,
    (f) =>
      /\.(?:mjs|cjs|js|ts|tsx|jsx)$/.test(f) &&
      !f.includes("node_modules") &&
      !f.includes(`${join("scripts", "test", "fixtures")}`) &&
      !f.startsWith(join(root, "scripts")),
  );
  for (const file of sourceFiles) {
    const routes = extractHealthRoutesFromSource(file);
    for (const [path] of routes) {
      const normalized = normalizeRoute(path);
      if (!knownRoutes.has(normalized)) {
        knownRoutes.set(normalized, { file, key: "source" });
      }
    }
  }

  // 2. Scan deployment records for health field references.
  const deploymentFiles = walk(root, (f) =>
    /(?:^|\/)deployments?\/.*\.json$/i.test(f) ||
    /(?:^|\/)deployments?\.[^/]*\.json$/i.test(f),
  );
  for (const file of deploymentFiles) {
    const record = readJson(file);
    if (!record) continue;
    const fields = extractDeploymentFields(record);
    for (const [fieldPath, value] of fields) {
      if (!isHealthFieldPath(fieldPath)) continue;
      checkHealthReference(fieldPath, value, knownRoutes, file, fieldPath);
    }
  }

  // 3. Scan env example files for health field references.
  const envFiles = walk(root, (f) => /(?:^|\/)\.env(?:\.example|\.sample|\.template)$/i.test(f));
  for (const file of envFiles) {
    const fields = extractEnvHealthFields(file);
    for (const [key, value] of fields) {
      checkHealthReference(key, value, knownRoutes, file, key);
    }
  }

  // 4. Report missing health routes referenced by deployment records.
  // If a deployment record declares a health check but no routes are known,
  // surface a warning so the drift is visible.
  if (deploymentFiles.length > 0 && knownRoutes.size === 0) {
    for (const file of deploymentFiles) {
      reportWarning(
        file,
        "health",
        "deployment record references health checks but no health routes were found in manifests or source",
      );
    }
  }

  printDiagnostics();
  const hasErrors = diagnostics.some((d) => d.level === "error");
  process.exit(hasErrors ? 1 : 0);
}

main();