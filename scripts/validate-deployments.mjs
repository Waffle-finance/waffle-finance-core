/**
 * Deployment artifact validator.
 *
 * Validates `deployments.<network>.json` artifacts and cross-checks the
 * chain-specific identifiers that must stay synchronized across:
 *   - the deployment artifact itself,
 *   - environment example files (`.env.example`, `.env.<network>.example`),
 *   - operator documentation (`docs/OPERATIONS.md`).
 *
 * Explicit field mappings (no arbitrary string searching):
 *   EVM:      ethereum.contracts.HTLCEscrow, ethereum.contracts.ResolverRegistry, ethereum.deployer
 *   Soroban:  stellar.contracts.HTLC, stellar.contracts.ResolverRegistry, stellar.deployer,
 *             stellar.resolverRegistryConfig.stakeAsset
 *   Solana:   solana.programs.* program IDs
 *
 * Optional/unconfigured networks (e.g. Solana on testnet) are treated as valid
 * when absent from every source; a value present in only some sources is
 * reported as a disagreement naming the chain and artifact.
 *
 * Update procedure: when a deployment changes, update the artifact, the
 * matching env example, and docs/OPERATIONS.md in the same change, then run
 * `node scripts/validate-deployments.mjs` (part of the standard release check).
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireEnv, checkCommand, requireFile } from './preflight.js';

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ETH_ADDRESS = /^0x0{40}$/;
const STELLAR_CONTRACT = /^C[A-Z2-7]{55}$/;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const HEX_32 = /^[0-9a-fA-F]{64}$/;
const SOLANA_PROGRAM = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Explicit mappings of identifiers that must stay synchronized across sources.
// Each entry: { chain, label, artifactPath, envKeys, docLabel }
const SYNCED_IDENTIFIERS = {
  ethereum: [
    { label: 'HTLCEscrow', artifactPath: ['ethereum', 'contracts', 'HTLCEscrow'], envKeys: ['HTLC_ESCROW_ADDRESS', 'ETH_HTLC_ESCROW'], docLabel: 'HTLCEscrow' },
    { label: 'ResolverRegistry', artifactPath: ['ethereum', 'contracts', 'ResolverRegistry'], envKeys: ['RESOLVER_REGISTRY_ADDRESS', 'ETH_RESOLVER_REGISTRY'], docLabel: 'ResolverRegistry' },
    { label: 'deployer', artifactPath: ['ethereum', 'deployer'], envKeys: ['ETH_DEPLOYER'], docLabel: 'EVM deployer' },
  ],
  stellar: [
    { label: 'HTLC', artifactPath: ['stellar', 'contracts', 'HTLC'], envKeys: ['STELLAR_HTLC_CONTRACT', 'SOROBAN_HTLC'], docLabel: 'HTLC' },
    { label: 'ResolverRegistry', artifactPath: ['stellar', 'contracts', 'ResolverRegistry'], envKeys: ['STELLAR_RESOLVER_REGISTRY', 'SOROBAN_RESOLVER_REGISTRY'], docLabel: 'ResolverRegistry' },
    { label: 'deployer', artifactPath: ['stellar', 'deployer'], envKeys: ['STELLAR_DEPLOYER'], docLabel: 'Soroban deployer' },
    { label: 'stakeAsset', artifactPath: ['stellar', 'resolverRegistryConfig', 'stakeAsset'], envKeys: ['STELLAR_STAKE_ASSET'], docLabel: 'stakeAsset' },
  ],
  solana: [
    { label: 'HTLC', artifactPath: ['solana', 'programs', 'HTLC'], envKeys: ['SOLANA_HTLC_PROGRAM_ID', 'SOLANA_PROGRAM_ID'], docLabel: 'HTLC program' },
    { label: 'ResolverRegistry', artifactPath: ['solana', 'programs', 'ResolverRegistry'], envKeys: ['SOLANA_RESOLVER_REGISTRY_PROGRAM_ID'], docLabel: 'ResolverRegistry program' },
  ],
};

const ENV_EXAMPLE_CANDIDATES = ['.env.example', '.env.testnet.example', '.env.sepolia.example', '.env.mainnet.example'];
const OPERATIONS_DOC = path.join('docs', 'OPERATIONS.md');

const NETWORKS = {
  testnet: {
    ethereumChainId: 11155111,
    ethereumName: 'Sepolia',
    stellarPassphrase: 'Test SDF Network ; September 2015',
    stellarHorizon: 'https://horizon-testnet.stellar.org',
    stellarRpc: 'https://soroban-testnet.stellar.org',
  },
  sepolia: {
    ethereumChainId: 11155111,
    ethereumName: 'Sepolia',
  },
  mainnet: {
    ethereumChainId: 1,
    ethereumName: 'Ethereum Mainnet',
    stellarPassphrase: 'Public Global Stellar Network ; September 2015',
    stellarHorizon: 'https://horizon.stellar.org',
  },
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`);
  }
}

function fail(errors, filePath, jsonPath, message) {
  errors.push(`${filePath}:${jsonPath} ${message}`);
}

function expectEqual(errors, filePath, jsonPath, actual, expected) {
  if (actual !== expected) {
    fail(errors, filePath, jsonPath, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectUrl(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string') {
    fail(errors, filePath, jsonPath, 'must be a URL string');
    return;
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      fail(errors, filePath, jsonPath, `uses unsupported URL protocol ${url.protocol}`);
    }
  } catch {
    fail(errors, filePath, jsonPath, `must be a valid URL, got ${JSON.stringify(value)}`);
  }
}

function expectEthereumAddress(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string' || !ETH_ADDRESS.test(value)) {
    fail(errors, filePath, jsonPath, `must be a 20-byte Ethereum address, got ${JSON.stringify(value)}`);
    return;
  }

  if (ZERO_ETH_ADDRESS.test(value)) {
    fail(errors, filePath, jsonPath, 'must not be the zero address');
  }
}

function expectStellarContract(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string' || !STELLAR_CONTRACT.test(value)) {
    fail(errors, filePath, jsonPath, `must be a Stellar contract address, got ${JSON.stringify(value)}`);
  }
}

function expectStellarAccount(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string' || !STELLAR_ACCOUNT.test(value)) {
    fail(errors, filePath, jsonPath, `must be a Stellar account address, got ${JSON.stringify(value)}`);
  }
}

function expectHex32(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    fail(errors, filePath, jsonPath, `must be a 32-byte hex transaction hash, got ${JSON.stringify(value)}`);
  }
}

function expectPositiveIntegerString(errors, filePath, jsonPath, value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    fail(errors, filePath, jsonPath, `must be a positive integer string, got ${JSON.stringify(value)}`);
  }
}

function getPath(obj, keys) {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function parseEnvFile(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readOperationsDoc() {
  if (!fs.existsSync(OPERATIONS_DOC)) {
    return null;
  }
  return fs.readFileSync(OPERATIONS_DOC, 'utf8');
}

// Extract a documented value for a label from OPERATIONS.md using an explicit
// `Label: value` or `Label = value` pattern (no arbitrary substring search).
function extractDocValue(doc, label) {
  if (!doc) {
    return undefined;
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*[:=]\\s*\`?([^\`\\s]+)\`?`, 'm');
  const match = doc.match(pattern);
  return match ? match[1] : undefined;
}

function crossCheckIdentifiers(errors, filePath, artifact, envValues, doc) {
  for (const [chain, entries] of Object.entries(SYNCED_IDENTIFIERS)) {
    for (const entry of entries) {
      const artifactValue = getPath(artifact, entry.artifactPath);
      const envValue = entry.envKeys.map((key) => envValues[key]).find((v) => v !== undefined && v !== '');
      const docValue = extractDocValue(doc, entry.docLabel);

      const present = [artifactValue, envValue, docValue].filter((v) => v !== undefined && v !== '');
      if (present.length === 0) {
        // Optional/unconfigured network: absent everywhere is valid.
        continue;
      }

      const canonical = present[0];
      const sources = [
        ['deployment artifact', artifactValue],
        ['env example', envValue],
        ['docs/OPERATIONS.md', docValue],
      ];
      for (const [sourceName, value] of sources) {
        if (value === undefined || value === '') {
          fail(errors, filePath, `${chain}.${entry.label}`, `missing in ${sourceName} but set in another source (${JSON.stringify(canonical)})`);
        } else if (value !== canonical) {
          fail(errors, filePath, `${chain}.${entry.label}`, `disagrees with ${sourceName}: expected ${JSON.stringify(canonical)}, got ${JSON.stringify(value)}`);
        }
      }
    }
  }
}

function expectReadmeContains(errors, filePath, jsonPath, value) {
  if (!fs.existsSync('README.md') || typeof value !== 'string') {
    return;
  }

  const readme = fs.readFileSync('README.md', 'utf8');
  if (!readme.toLowerCase().includes(value.toLowerCase())) {
    fail(errors, filePath, jsonPath, `is not reflected in README.md deployed-contracts documentation`);
  }
}

function validateCombinedManifest(errors, filePath, artifact, expected) {
  if (!artifact.ethereum) {
    fail(errors, filePath, 'ethereum', 'section is required');
  } else {
    expectEqual(errors, filePath, 'ethereum.chainId', artifact.ethereum.chainId, expected.ethereumChainId);
    if (expected.ethereumName) {
      expectEqual(errors, filePath, 'ethereum.name', artifact.ethereum.name, expected.ethereumName);
    }
    expectUrl(errors, filePath, 'ethereum.rpcUrl', artifact.ethereum.rpcUrl);
    expectEthereumAddress(errors, filePath, 'ethereum.deployer', artifact.ethereum.deployer);
    expectEthereumAddress(errors, filePath, 'ethereum.contracts.HTLCEscrow', artifact.ethereum.contracts?.HTLCEscrow);
    expectEthereumAddress(errors, filePath, 'ethereum.contracts.ResolverRegistry', artifact.ethereum.contracts?.ResolverRegistry);
    expectReadmeContains(errors, filePath, 'ethereum.contracts.HTLCEscrow', artifact.ethereum.contracts?.HTLCEscrow);
    expectReadmeContains(errors, filePath, 'ethereum.contracts.ResolverRegistry', artifact.ethereum.contracts?.ResolverRegistry);
  }

  if (!artifact.stellar) {
    fail(errors, filePath, 'stellar', 'section is required');
    return;
  }

  expectEqual(errors, filePath, 'stellar.passphrase', artifact.stellar.passphrase, expected.stellarPassphrase);
  expectEqual(errors, filePath, 'stellar.horizon', artifact.stellar.horizon, expected.stellarHorizon);
  if (expected.stellarRpc) {
    expectEqual(errors, filePath, 'stellar.rpc', artifact.stellar.rpc, expected.stellarRpc);
  } else {
    expectUrl(errors, filePath, 'stellar.rpc', artifact.stellar.rpc);
  }
  expectStellarAccount(errors, filePath, 'stellar.deployer', artifact.stellar.deployer);
  expectStellarContract(errors, filePath, 'stellar.contracts.HTLC', artifact.stellar.contracts?.HTLC);
  expectStellarContract(errors, filePath, 'stellar.contracts.ResolverRegistry', artifact.stellar.contracts?.ResolverRegistry);
  expectReadmeContains(errors, filePath, 'stellar.contracts.HTLC', artifact.stellar.contracts?.HTLC);
  expectReadmeContains(errors, filePath, 'stellar.contracts.ResolverRegistry', artifact.stellar.contracts?.ResolverRegistry);

  for (const [name, txHash] of Object.entries(artifact.stellar.deployTransactions ?? {})) {
    expectHex32(errors, filePath, `stellar.deployTransactions.${name}`, txHash);
  }

  const registryConfig = artifact.stellar.resolverRegistryConfig;
  if (registryConfig) {
    expectStellarAccount(errors, filePath, 'stellar.resolverRegistryConfig.admin', registryConfig.admin);
    expectStellarContract(errors, filePath, 'stellar.resolverRegistryConfig.stakeAsset', registryConfig.stakeAsset);
    expectPositiveIntegerString(errors, filePath, 'stellar.resolverRegistryConfig.minStake', registryConfig.minStake);
    expectStellarAccount(errors, filePath, 'stellar.resolverRegistryConfig.slashBeneficiary', registryConfig.slashBeneficiary);
  }
}

function validateHardhatManifest(errors, filePath, artifact, expected) {
  expectEqual(errors, filePath, 'chainId', artifact.chainId, expected.ethereumChainId);
  expectEthereumAddress(errors, filePath, 'deployer', artifact.deployer);
  expectEthereumAddress(errors, filePath, 'ethereum.htlcEscrow', artifact.ethereum?.htlcEscrow);
  expectEthereumAddress(errors, filePath, 'ethereum.resolverRegistry', artifact.ethereum?.resolverRegistry);
  expectEthereumAddress(errors, filePath, 'config.stakeAsset', artifact.config?.stakeAsset);
  expectPositiveIntegerString(errors, filePath, 'config.minStake', artifact.config?.minStake);

  if (artifact.config?.minSafetyDeposit !== undefined && !/^[0-9]+$/.test(String(artifact.config.minSafetyDeposit))) {
    fail(errors, filePath, 'config.minSafetyDeposit', 'must be a non-negative integer string');
  }
}

function validateDeploymentArtifact(filePath) {
  const artifact = readJson(filePath);
  const errors = [];
  const fileNetwork = path.basename(filePath).match(/^deployments\.([^.]+)\.json$/)?.[1];

  if (!fileNetwork) {
    fail(errors, filePath, 'filename', 'must match deployments.<network>.json');
    return errors;
  }

  const expected = NETWORKS[fileNetwork];
  if (!expected) {
    fail(errors, filePath, 'filename', `uses unsupported deployment network "${fileNetwork}"`);
    return errors;
  }

  expectEqual(errors, filePath, 'network', artifact.network, fileNetwork);

  if (artifact.stellar) {
    validateCombinedManifest(errors, filePath, artifact, expected);
  } else {
    validateHardhatManifest(errors, filePath, artifact, expected);
  }

  if (artifact.solana) {
    for (const [name, programId] of Object.entries(artifact.solana.programs ?? {})) {
      if (typeof programId !== 'string' || !SOLANA_PROGRAM.test(programId)) {
        fail(errors, filePath, `solana.programs.${name}`, `must be a Solana program ID, got ${JSON.stringify(programId)}`);
      }
    }
  }

  const envValues = {};
  for (const candidate of ENV_EXAMPLE_CANDIDATES) {
    Object.assign(envValues, parseEnvFile(candidate));
  }
  const doc = readOperationsDoc();
  crossCheckIdentifiers(errors, filePath, artifact, envValues, doc);

  return errors;
}

const deploymentFiles = fs
  .readdirSync(process.cwd())
  .filter((fileName) => /^deployments\.[^.]+\.json$/.test(fileName))
  .sort();

if (deploymentFiles.length === 0) {
  console.error('No deployment artifacts found. Expected at least one deployments.<network>.json file.');
  process.exit(1);
}

const errors = deploymentFiles.flatMap(validateDeploymentArtifact);

if (errors.length > 0) {
  console.error('Deployment artifact validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${deploymentFiles.length} deployment artifact(s): ${deploymentFiles.join(', ')}`);
