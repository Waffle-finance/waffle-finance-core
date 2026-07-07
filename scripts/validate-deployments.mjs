import fs from 'node:fs';
import path from 'node:path';
import { requireEnv, checkCommand, requireFile } from './preflight.js';

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ETH_ADDRESS = /^0x0{40}$/;
const STELLAR_CONTRACT = /^C[A-Z2-7]{55}$/;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const HEX_32 = /^[0-9a-fA-F]{64}$/;

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
