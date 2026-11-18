import fs from 'fs';
import path from 'path';

// The repo-wide command contract. Keep in sync with docs/COMMANDS.md.
//
// For each workspace package, `required` maps a script name to a substring
// its command must contain, so a script can't be removed or silently stop
// invoking the tool the contract documents.
const CONTRACT = {
  '@wafflefinance/contracts': {
    build: 'hardhat compile',
    compile: 'hardhat compile',
    test: 'hardhat test',
    lint: 'solhint',
    clean: '',
  },
  '@wafflefinance/coordinator': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
    dev: 'tsx watch',
    start: 'node dist',
    clean: '',
  },
  '@wafflefinance/relayer': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
    dev: 'tsx watch',
    start: 'node dist',
    clean: '',
  },
  '@wafflefinance/resolver': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
    dev: 'tsx watch',
    start: 'node dist',
    clean: '',
  },
  '@wafflefinance/dashboard': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
    dev: 'tsx watch',
    start: 'node dist',
  },
  '@wafflefinance/sdk': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
    clean: '',
  },
  '@wafflefinance/config': {
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    clean: '',
  },
  '@wafflefinance/frontend': {
    build: 'vite build',
    test: 'vitest run',
    lint: 'eslint',
    dev: 'vite',
    preview: 'vite preview',
    clean: '',
  },
  // e2e is test-only: it intentionally has no build script (see docs/COMMANDS.md).
  '@wafflefinance/e2e': {
    test: 'vitest run',
    'test:smoke': 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint',
  },
};

// Root entry points contributors rely on. Substring semantics as above.
const ROOT_REQUIRED = {
  build: 'pnpm -r build',
  test: 'pnpm -r test',
  'test:e2e': '@wafflefinance/e2e',
  lint: 'pnpm -r lint',
  dev: 'pnpm -r dev',
  clean: 'pnpm -r clean',
  format: 'prettier',
  'format:check': 'prettier',
  'validate:commands': 'validate-commands.mjs',
  'validate:manifests': 'validate-workspace.mjs',
  'validate:deployments': 'validate-deployments.mjs',
};

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Resolve workspace package dirs from the root package.json `workspaces`
// field (same source of truth as scripts/validate-workspace.mjs).
function getWorkspaceDirs(rootPkg) {
  const dirs = [];
  for (const pattern of rootPkg.workspaces || []) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      if (!fs.existsSync(parent)) continue;
      for (const sub of fs.readdirSync(parent)) {
        const full = path.join(parent, sub);
        if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'package.json'))) {
          dirs.push(full);
        }
      }
    } else if (fs.existsSync(path.join(pattern, 'package.json'))) {
      dirs.push(pattern);
    }
  }
  return dirs;
}

function validateCommands() {
  const errors = [];
  const rootPkg = loadJson('package.json');
  const pkgsByName = new Map();

  for (const dir of getWorkspaceDirs(rootPkg)) {
    const pkg = loadJson(path.join(dir, 'package.json'));
    if (pkg.name) pkgsByName.set(pkg.name, pkg);
  }

  console.log(`Validating command contract for ${pkgsByName.size} workspace packages...`);

  // 1. Every contract entry must correspond to a real workspace package.
  for (const name of Object.keys(CONTRACT)) {
    if (!pkgsByName.has(name)) {
      errors.push(`Contract lists "${name}" but no workspace package with that name exists.`);
    }
  }

  // 2. Every workspace package must be covered by the contract.
  for (const name of pkgsByName.keys()) {
    if (!CONTRACT[name]) {
      errors.push(
        `Package "${name}" is not covered by the command contract. ` +
          `Add it to scripts/validate-commands.mjs and docs/COMMANDS.md.`
      );
    }
  }

  // 3. Required scripts exist and still invoke the documented tool.
  for (const [name, required] of Object.entries(CONTRACT)) {
    const pkg = pkgsByName.get(name);
    if (!pkg) continue;
    const scripts = pkg.scripts || {};

    for (const [script, mustContain] of Object.entries(required)) {
      if (!scripts[script]) {
        errors.push(`${name}: missing required script "${script}".`);
      } else if (mustContain && !scripts[script].includes(mustContain)) {
        errors.push(
          `${name}: script "${script}" is "${scripts[script]}" but the contract ` +
            `expects it to invoke "${mustContain}".`
        );
      }
    }
  }

  // 4. Root entry points exist and match.
  const rootScripts = rootPkg.scripts || {};
  for (const [script, mustContain] of Object.entries(ROOT_REQUIRED)) {
    if (!rootScripts[script]) {
      errors.push(`root: missing required script "${script}".`);
    } else if (mustContain && !rootScripts[script].includes(mustContain)) {
      errors.push(
        `root: script "${script}" is "${rootScripts[script]}" but the contract ` +
          `expects it to invoke "${mustContain}".`
      );
    }
  }

  // 5. Every `pnpm --filter <pkg> <script>` shortcut in the root manifest
  //    must resolve to a script that actually exists in the target package.
  const filterRe = /pnpm --filter (@wafflefinance\/[\w-]+) ([\w:-]+)/g;
  for (const [script, cmd] of Object.entries(rootScripts)) {
    for (const match of cmd.matchAll(filterRe)) {
      const [, target, targetScript] = match;
      const pkg = pkgsByName.get(target);
      if (!pkg) {
        errors.push(`root script "${script}": targets unknown package "${target}".`);
      } else if (targetScript !== 'exec' && !(pkg.scripts || {})[targetScript]) {
        errors.push(
          `root script "${script}": targets "${target}" script "${targetScript}", which does not exist.`
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n❌ Command contract validation failed:\n');
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      '\nThe contract is defined in scripts/validate-commands.mjs and documented in docs/COMMANDS.md.'
    );
    process.exit(1);
  }

  console.log('✅ All package scripts conform to the command contract.');
}

validateCommands();
