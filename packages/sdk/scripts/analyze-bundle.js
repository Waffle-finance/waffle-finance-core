#!/usr/bin/env node

/**
 * Verify the SDK's package boundaries against its own build output (#731).
 *
 * What it checks
 * ──────────────
 * 1. Every subpath in the hand-maintained `exports` map resolves to a real
 *    emitted file, for BOTH the `types` and `import` conditions. A dangling
 *    entry is a hard failure for any consumer on Node's ESM resolver — it is
 *    the failure mode that only shows up after `npm publish`.
 * 2. Every emitted module is reachable from at least one subpath. A module
 *    nobody can import is either a missing subpath (dead code a consumer has
 *    to deep-import `dist/` for) or genuinely internal.
 * 3. `sideEffects: false` and `"type": "module"` are still set — without them
 *    the subpath layout buys nothing, because bundlers may not drop anything.
 * 4. Every subpath ships a `.d.ts` next to its `.js`, so TypeScript consumers
 *    get types without a separate `@types` install.
 *
 * This used to check a hardcoded list of eight files that had drifted out of
 * sync with `package.json` — it could not detect a dangling subpath or an
 * unreachable module, which is exactly the class of bug #731 is about. It now
 * derives everything from the `exports` map itself.
 *
 * For per-entry *cost* (how many modules a subpath drags in, which chain SDKs
 * it reaches, and real bundle bytes) see `scripts/measure-entry-cost.mjs`.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(__dirname, "..");
const distDir = path.join(pkgDir, "dist");
const pkgPath = path.join(pkgDir, "package.json");

/** Conditions a consumer's resolver may pick, in the order we declare them. */
const CONDITIONS = ["types", "import"];

function fail(msg) {
  console.error(`❌ ${msg}`);
  return false;
}

function pass(msg) {
  console.log(`✅ ${msg}`);
  return true;
}

/** Every `.js` file under `dist/`, as posix-relative paths. */
function emittedFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) emittedFiles(full, acc);
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.js")) {
      acc.push(path.relative(distDir, full).split(path.sep).join("/"));
    }
  }
  return acc;
}

/** Bare + relative specifiers a file references, per measure-entry-cost.mjs. */
function specifiersOf(source) {
  const specs = new Set();
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/** Transitive closure of the SDK's own modules from one entry file. */
function reachableFrom(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      queue.push(resolved.endsWith(".js") ? resolved : path.join(resolved, "index.js"));
    }
  }
  return seen;
}

function analyze() {
  console.log("\n📦 SDK package-boundary analysis (#731)\n");

  if (!fs.existsSync(distDir)) {
    console.error("❌ dist/ directory not found. Run: pnpm build");
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let ok = true;

  // ── 1. Every declared subpath resolves, for every condition ──────────────
  console.log("Subpath resolution:");
  const entries = [];
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    const conditions = typeof target === "string" ? { import: target } : target;
    let resolved = true;
    for (const condition of CONDITIONS) {
      const rel = conditions[condition];
      if (!rel) {
        // `./package.json` and friends are plain string targets with no
        // separate type condition; nothing to verify for `types`.
        continue;
      }
      if (!fs.existsSync(path.join(pkgDir, rel))) {
        resolved = fail(`${subpath} → "${condition}": ${rel} does not exist in the build output`);
      }
    }
    if (resolved) {
      const size = fs.statSync(path.join(pkgDir, conditions.import)).size;
      pass(`${subpath} → ${conditions.import} (${size} bytes)`);
      entries.push({ subpath, file: path.join(pkgDir, conditions.import) });
    } else {
      ok = false;
    }
  }

  // ── 2. Nothing is emitted that no subpath can reach ──────────────────────
  console.log("\nModule reachability:");
  const reachable = new Set();
  for (const { file } of entries) {
    for (const m of reachableFrom(file)) {
      reachable.add(path.relative(distDir, m).split(path.sep).join("/"));
    }
  }
  const orphans = emittedFiles(distDir).filter((f) => !reachable.has(f));
  if (orphans.length === 0) {
    pass("every emitted module is reachable from at least one subpath");
  } else {
    ok = fail(
      `emitted but unreachable from any subpath (add a subpath or stop emitting):\n` +
        orphans.map((o) => `     - ${o}`).join("\n"),
    );
  }

  // ── 3. Tree-shaking preconditions ────────────────────────────────────────
  console.log("\nConfiguration:");
  if (pkg.sideEffects === false) pass('sideEffects: false (tree-shaking enabled)');
  else ok = fail("sideEffects must be false for the subpath layout to pay off");

  if (pkg.type === "module") pass('type: "module" (ESM format)');
  else ok = fail('type must be "module" — the exports map declares import-only conditions');

  if (pkg.exports && typeof pkg.exports === "object") {
    pass(`exports map configured (${Object.keys(pkg.exports).length} subpaths)`);
  } else {
    ok = fail("exports map missing — subpath imports would not resolve");
  }

  // ── 4. Types ship with runtime code ──────────────────────────────────────
  const missingTypes = entries
    .filter(({ subpath }) => subpath !== "./package.json")
    .filter(({ file }) => !fs.existsSync(file.replace(/\.js$/, ".d.ts")))
    .map(({ subpath }) => subpath);
  if (missingTypes.length === 0) pass("every subpath ships a colocated .d.ts");
  else ok = fail(`subpaths missing a .d.ts: ${missingTypes.join(", ")}`);

  console.log("");
  if (ok) {
    console.log("✨ All package boundaries resolve. Consumers can import any subpath above directly.");
    console.log(
      "\nPer-entry import cost (modules reached, chain SDKs, real bundle bytes):\n" +
        "  pnpm analyze:cost\n",
    );
  } else {
    console.error("✗ package-boundary analysis failed");
  }
  return ok;
}

process.exit(analyze() ? 0 : 1);
