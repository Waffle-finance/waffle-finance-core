// scripts/preflight.js
import { execSync } from 'child_process';
import fs from 'fs';

export function requireEnv(vars) {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  console.log('✅ All required environment variables are set');
}

export function checkCommand(cmd, name, minVersion) {
  try {
    const out = execSync(`${cmd} --version`, { encoding: 'utf8' }).trim();
    console.log(`✅ ${name} version: ${out}`);
    if (minVersion) {
      const version = out.replace(/[^0-9.]/g, '');
      const [major, minor = '0'] = version.split('.').map(Number);
      const [reqMajor, reqMinor = '0'] = minVersion.split('.').map(Number);
      if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
        console.error(`❌ ${name} version ${version} is lower than required ${minVersion}`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(`❌ ${name} is not installed or not executable`);
    process.exit(1);
  }
}

export function requireFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing ${description}: ${filePath}`);
    process.exit(1);
  }
  console.log(`✅ Found ${description}`);
}
