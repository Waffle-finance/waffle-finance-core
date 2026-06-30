import fs from 'fs';
import path from 'path';

// Helper to resolve workspaces from root package.json
function getWorkspaces() {
  const rootPkgPath = path.resolve('package.json');
  if (!fs.existsSync(rootPkgPath)) {
    throw new Error('Root package.json not found');
  }
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const workspaces = rootPkg.workspaces || [];
  const resolvedDirs = [];

  for (const pattern of workspaces) {
    if (pattern.endsWith('/*')) {
      const parentDir = pattern.replace('/*', '');
      if (fs.existsSync(parentDir)) {
        const subDirs = fs.readdirSync(parentDir);
        for (const subDir of subDirs) {
          const fullPath = path.join(parentDir, subDir);
          if (fs.statSync(fullPath).isDirectory()) {
            resolvedDirs.push(fullPath);
          }
        }
      }
    } else {
      if (fs.existsSync(pattern)) {
        resolvedDirs.push(pattern);
      }
    }
  }

  return { rootVersion: rootPkg.version, resolvedDirs };
}

// Helper to extract paths from exports field
function extractPaths(val) {
  if (typeof val === 'string') {
    return [val];
  }
  if (typeof val === 'object' && val !== null) {
    return Object.values(val).flatMap(extractPaths);
  }
  return [];
}

function validateWorkspace() {
  const { rootVersion, resolvedDirs } = getWorkspaces();
  let hasError = false;

  console.log(`Starting workspace validation against root version: ${rootVersion}`);

  for (const dir of resolvedDirs) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      continue;
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`\nValidating package: ${pkgJson.name || dir}`);

    // 1. Validate Name
    if (!pkgJson.name) {
      console.error(`❌ Error: Package in ${dir} is missing a name.`);
      hasError = true;
    } else if (!pkgJson.name.startsWith('@wafflefinance/')) {
      console.error(`❌ Error: Package name "${pkgJson.name}" must start with "@wafflefinance/".`);
      hasError = true;
    }

    // 2. Validate Version
    if (!pkgJson.version) {
      console.error(`❌ Error: Package in ${dir} is missing a version.`);
      hasError = true;
    } else if (pkgJson.version !== rootVersion) {
      console.error(`❌ Error: Package version "${pkgJson.version}" does not match root version "${rootVersion}".`);
      hasError = true;
    }

    // 3. Validate Entrypoints and Exports Paths (if they exist)
    const pathsToCheck = [];

    if (pkgJson.main) {
      pathsToCheck.push({ field: 'main', value: pkgJson.main });
    }
    if (pkgJson.module) {
      pathsToCheck.push({ field: 'module', value: pkgJson.module });
    }
    if (pkgJson.types) {
      pathsToCheck.push({ field: 'types', value: pkgJson.types });
    }
    if (pkgJson.typings) {
      pathsToCheck.push({ field: 'typings', value: pkgJson.typings });
    }

    if (pkgJson.bin) {
      if (typeof pkgJson.bin === 'string') {
        pathsToCheck.push({ field: 'bin', value: pkgJson.bin });
      } else if (typeof pkgJson.bin === 'object') {
        for (const [key, val] of Object.entries(pkgJson.bin)) {
          pathsToCheck.push({ field: `bin.${key}`, value: val });
        }
      }
    }

    if (pkgJson.exports) {
      const exportedPaths = extractPaths(pkgJson.exports);
      for (const val of exportedPaths) {
        pathsToCheck.push({ field: 'exports', value: val });
      }
    }

    for (const { field, value } of pathsToCheck) {
      // Resolve path relative to the package directory
      const fullPath = path.resolve(dir, value);
      if (!fs.existsSync(fullPath)) {
        console.error(`❌ Error: Referenced path in "${field}" does not exist: ${value} (Resolved: ${fullPath})`);
        hasError = true;
      } else {
        console.log(`  ✓ Verified ${field}: ${value}`);
      }
    }
  }

  if (hasError) {
    console.error('\n❌ Workspace validation failed with errors.');
    process.exit(1);
  } else {
    console.log('\n✅ All workspace manifests and export paths validated successfully.');
  }
}

validateWorkspace();
