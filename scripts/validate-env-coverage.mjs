#!/usr/bin/env node
/**
 * validate-env-coverage.mjs
 *
 * Static validator that finds environment-variable references across the
 * coordinator, relayer, resolver, SDK, config package, and frontend, then
 * compares them with the relevant example env files and documented variable
 * lists. Reports missing and stale keys with file:line locations. Values are
 * never printed.
 *
 * Usage:
 *   node scripts/validate-env-coverage.mjs [--json] [--root <dir>]
 *
 * Exit codes:
 *   0 - coverage is consistent
 *   1 - missing and/or stale keys detected
 *   2 - internal error (bad arguments, unreadable files)
 *
 * How to resolve failures:
 *   - "Missing" keys are referenced in source but absent from the example env
 *     file / documentation. Add them (with a safe placeholder value) to the
 *     relevant example file and document them.
 *   - "Stale" keys appear in the example env file / documentation but are no
 *     longer referenced anywhere. Remove them, or add them to the exemption
 *     list below if they are intentionally retained (e.g. consumed by an
 *     external tool).
 *   - Intentionally exempt keys live in EXEMPT_KEYS. Keep that list small and
 *     add a comment explaining why each entry exists.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Source roots that are scanned for environment-variable references.
 * Paths are relative to the repository root.
 */
const SOURCE_ROOTS = [
  'coordinator',
  'relayer',
  'resolver',
  'packages/sdk',
  'packages/config',
  'frontend',
];

/**
 * File extensions that are scanned.
 */
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
]);

/**
 * Directories that are always skipped while walking source trees.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
]);

/**
 * Example env files that describe the runtime surface, grouped by the source
 * roots they cover. Each entry may list multiple candidate filenames; the
 * first existing file is used.
 */
const EXAMPLE_ENV_FILES = [
  {
    label: 'root',
    candidates: ['.env.example', '.env.sample', '.env.template'],
    covers: ['coordinator', 'relayer', 'resolver', 'packages/config'],
  },
  {
    label: 'sdk',
    candidates: ['packages/sdk/.env.example', 'packages/sdk/.env.sample'],
    covers: ['packages/sdk'],
  },
  {
    label: 'frontend',
    candidates: ['frontend/.env.example', 'frontend/.env.sample'],
    covers: ['frontend'],
  },
];

/**
 * Markdown documentation files that may list environment variables in
 * backticked code spans or fenced blocks. Variables are extracted from lines
 * that look like `KEY=...` or `KEY - description` or `| KEY | ... |`.
 */
const DOC_FILES = [
  'README.md',
  'packages/sdk/README.md',
  'frontend/README.md',
  'docs/configuration.md',
];

/**
 * Keys that are intentionally exempt from coverage checks. Keep this list
 * small and document each entry.
 */
const EXEMPT_KEYS = new Set([
  // Consumed by the Node.js runtime / test harness, not by our code.
  'NODE_ENV',
  'CI',
  'DEBUG',
  // Injected by the hosting platform at build time.
  'VERCEL_URL',
  'VERCEL_ENV',
  // Used only by local developer tooling.
  'PORT',
]);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, root: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--root requires a directory argument');
      }
      opts.root = resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'validate-env-coverage',
      '',
      'Statically validates that environment variables referenced in source',
      'match the example env files and documentation.',
      '',
      'Usage:',
      '  node scripts/validate-env-coverage.mjs [--json] [--root <dir>]',
      '',
      'Options:',
      '  --json         Emit machine-readable JSON instead of text.',
      '  --root <dir>   Repository root to validate (default: repo root).',
      '  -h, --help     Show this help.',
      '',
      'Resolving failures:',
      '  Missing keys  - referenced in source but not documented. Add them to',
      '                  the relevant example env file and documentation.',
      '  Stale keys    - documented but no longer referenced. Remove them, or',
      '                  add them to EXEMPT_KEYS in this script with a comment.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  }
}

function collectSourceFiles(root) {
  const files = [];
  for (const rel of SOURCE_ROOTS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(abs, files);
    } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(abs))) {
      files.push(abs);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

/**
 * Patterns that identify environment-variable references. Each pattern must
 * capture the variable name in group 1. Patterns are intentionally anchored on
 * the accessor so that ordinary property names (e.g. `config.env`) are not
 * mistaken for variables.
 */
const REFERENCE_PATTERNS = [
  // process.env.NAME
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // process.env['NAME'] / process.env["NAME"]
  /\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  // import.meta.env.NAME
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // import.meta.env['NAME'] / import.meta.env["NAME"]
  /\bimport\.meta\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  // config-package accessors: rawEnv.NAME / env.NAME
  // Anchored on a word boundary and preceded by a non-identifier char so that
  // `someConfig.env.NAME` is not matched, but `rawEnv.NAME` and `env.NAME` are.
  /(?<![\w.])rawEnv\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /(?<![\w.])env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // config-package accessors with bracket notation: rawEnv['NAME'] / env['NAME']
  /(?<![\w.])rawEnv\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /(?<![\w.])env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
];

/**
 * Accessor names that are too generic to treat as environment accessors when
 * used with dot notation. These are filtered out after matching to avoid
 * false positives from ordinary objects named `env`.
 */
const GENERIC_ACCESSORS = new Set(['env']);

/**
 * Extract references from a single source file. Returns an array of
 * { key, file, line } records.
 */
function extractReferences(file, content) {
  const refs = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const key = match[1];
        if (!key) continue;
        // Filter generic accessors: only accept `env.NAME` when it looks like
        // an environment accessor. We accept it when the surrounding text
        // contains `process`, `import.meta`, or when the file lives in the
        // config package (where `env` is the canonical accessor).
        const accessor = match[0].slice(0, match[0].indexOf(key)).replace(/[.[\]'"\s]/g, '');
        if (GENERIC_ACCESSORS.has(accessor)) {
          const isConfigPackage = file.includes(`${'packages/config'}`);
          const looksLikeEnv =
            isConfigPackage ||
            /\bprocess\b/.test(line) ||
            /\bimport\.meta\b/.test(line) ||
            /\brawEnv\b/.test(line);
          if (!looksLikeEnv) continue;
        }
        refs.push({ key, file, line: i + 1 });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Documented key extraction
// ---------------------------------------------------------------------------

/**
 * Parse an example env file. Returns a map of key -> line number.
 */
function parseEnvFile(file) {
  const keys = new Map();
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return keys;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) {
      keys.set(match[1], i + 1);
    }
  }
  return keys;
}

/**
 * Parse a documentation file for environment-variable mentions. Returns a map
 * of key -> line number.
 */
function parseDocFile(file) {
  const keys = new Map();
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return keys;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Backticked KEY=value or `KEY` mentions.
    const backtick = /`([A-Z][A-Z0-9_]{2,})\s*(?:=|`)/g;
    let match;
    while ((match = backtick.exec(line)) !== null) {
      keys.set(match[1], i + 1);
    }
    // Markdown table rows: | KEY | ... |
    const table = /^\s*\|\s*`?([A-Z][A-Z0-9_]{2,})`?\s*\|/.exec(line);
    if (table) {
      keys.set(table[1], i + 1);
    }
    // Fenced block lines: KEY=value
    const fenced = /^\s*([A-Z][A-Z0-9_]{2,})\s*=/.exec(line);
    if (fenced) {
      keys.set(fenced[1], i + 1);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(root) {
  const sourceFiles = collectSourceFiles(root);

  // Collect references grouped by source root.
  const references = [];
  for (const file of sourceFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const refs = extractReferences(file, content);
    for (const ref of refs) {
      references.push(ref);
    }
  }

  // Determine which source root each reference belongs to.
  const rootForFile = (file) => {
    const rel = relative(root, file).split('\\').join('/');
    for (const sourceRoot of SOURCE_ROOTS) {
      if (rel === sourceRoot || rel.startsWith(`${sourceRoot}/`)) {
        return sourceRoot;
      }
    }
    return null;
  };

  // Build documented key sets per example file.
  const documented = new Map(); // label -> Map(key -> { file, line })
  for (const entry of EXAMPLE_ENV_FILES) {
    const found = new Map();
    for (const candidate of entry.candidates) {
      const abs = join(root, candidate);
      if (!existsSync(abs)) continue;
      const keys = parseEnvFile(abs);
      for (const [key, line] of keys) {
        if (!found.has(key)) {
          found.set(key, { file: abs, line });
        }
      }
    }
    documented.set(entry.label, found);
  }

  // Build documented key set from markdown docs.
  const docKeys = new Map();
  for (const docRel of DOC_FILES) {
    const abs = join(root, docRel);
    if (!existsSync(abs)) continue;
    const keys = parseDocFile(abs);
    for (const [key, line] of keys) {
      if (!docKeys.has(key)) {
        docKeys.set(key, { file: abs, line });
      }
    }
  }

  // Union of all documented keys (env files + docs).
  const allDocumented = new Map();
  for (const [, map] of documented) {
    for (const [key, loc] of map) {
      if (!allDocumented.has(key)) allDocumented.set(key, loc);
    }
  }
  for (const [key, loc] of docKeys) {
    if (!allDocumented.has(key)) allDocumented.set(key, loc);
  }

  // Referenced keys (deduplicated, keeping first location).
  const referenced = new Map();
  for (const ref of references) {
    if (!referenced.has(ref.key)) {
      referenced.set(ref.key, ref);
    }
  }

  // Missing: referenced but not documented and not exempt.
  const missing = [];
  for (const [key, ref] of referenced) {
    if (EXEMPT_KEYS.has(key)) continue;
    if (!allDocumented.has(key)) {
      missing.push({
        key,
        file: relative(root, ref.file).split('\\').join('/'),
        line: ref.line,
      });
    }
  }

  // Stale: documented but not referenced and not exempt.
  const stale = [];
  for (const [key, loc] of allDocumented) {
    if (EXEMPT_KEYS.has(key)) continue;
    if (!referenced.has(key)) {
      stale.push({
        key,
        file: relative(root, loc.file).split('\\').join('/'),
        line: loc.line,
      });
    }
  }

  // Sort for deterministic output.
  missing.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file));
  stale.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file));

  return {
    missing,
    stale,
    referencedCount: referenced.size,
    documentedCount: allDocumented.size,
    exemptCount: EXEMPT_KEYS.size,
    sourceFileCount: sourceFiles.length,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportText(result) {
  const lines = [];
  lines.push('Environment variable coverage');
  lines.push(`  source files scanned: ${result.sourceFileCount}`);
  lines.push(`  referenced keys:      ${result.referencedCount}`);
  lines.push(`  documented keys:      ${result.documentedCount}`);
  lines.push(`  exempt keys:          ${result.exemptCount}`);
  lines.push('');

  if (result.missing.length === 0 && result.stale.length === 0) {
    lines.push('OK: all referenced environment variables are documented.');
    return lines.join('\n');
  }

  if (result.missing.length > 0) {
    lines.push(`Missing keys (${result.missing.length}):`);
    for (const item of result.missing) {
      lines.push(`  ${item.key}  (referenced at ${item.file}:${item.line})`);
    }
    lines.push('');
    lines.push('  Resolve by adding these keys to the relevant example env file');
    lines.push('  and documenting them, or add them to EXEMPT_KEYS.');
    lines.push('');
  }

  if (result.stale.length > 0) {
    lines.push(`Stale keys (${result.stale.length}):`);
    for (const item of result.stale) {
      lines.push(`  ${item.key}  (documented at ${item.file}:${item.line})`);
    }
    lines.push('');
    lines.push('  Resolve by removing these keys from the example env file and');
    lines.push('  documentation, or add them to EXEMPT_KEYS if intentionally');
    lines.push('  retained.');
    lines.push('');
  }

  return lines.join('\n');
}

function reportJson(result) {
  return JSON.stringify(
    {
      ok: result.missing.length === 0 && result.stale.length === 0,
      missing: result.missing,
      stale: result.stale,
      stats: {
        sourceFileCount: result.sourceFileCount,
        referencedCount: result.referencedCount,
        documentedCount: result.documentedCount,
        exemptCount: result.exemptCount,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.stderr.write('Run with --help for usage.\n');
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let result;
  try {
    result = validate(opts.root);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const output = opts.json ? reportJson(result) : reportText(result);
  process.stdout.write(`${output}\n`);

  if (result.missing.length > 0 || result.stale.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();