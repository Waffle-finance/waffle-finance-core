import { ethers } from "hardhat";
import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

interface DeploymentArtifact {
  network: string;
  chainId?: number;
  deployer?: string;
  ethereum?: {
    chainId?: number;
    contracts?: {
      HTLCEscrow: string;
      ResolverRegistry: string;
    };
    htlcEscrow?: string;
    resolverRegistry?: string;
  };
  soroban?: {
    htlc: string;
    resolverRegistry: string;
  };
  stellar?: {
    contracts?: {
      HTLC: string;
      ResolverRegistry: string;
    };
  };
  config?: {
    stakeAsset: string;
    minStake: string;
    minSafetyDeposit: string;
  };
  deployedAt?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function readDeploymentArtifact(): DeploymentArtifact | null {
  let artifactPath = path.resolve(__dirname, `../../deployments.${network.name}.json`);
  if (!fs.existsSync(artifactPath)) {
    if (network.name === 'sepolia') {
      artifactPath = path.resolve(__dirname, `../../deployments.testnet.json`);
      if (!fs.existsSync(artifactPath)) {
        return null;
      }
    } else {
      return null;
    }
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as DeploymentArtifact;
}

async function validateEthereumContracts(artifact: DeploymentArtifact, results: ValidationResult): Promise<void> {
  if (!artifact.ethereum) {
    results.warnings.push("No Ethereum deployment found in artifact");
    return;
  }

  const htlcEscrow = artifact.ethereum.contracts?.HTLCEscrow || artifact.ethereum.htlcEscrow;
  const resolverRegistry = artifact.ethereum.contracts?.ResolverRegistry || artifact.ethereum.resolverRegistry;

  if (!htlcEscrow || !resolverRegistry) {
    results.errors.push("Missing HTLCEscrow or ResolverRegistry address in artifact");
    results.valid = false;
    return;
  }

  // Verify HTLCEscrow contract exists and has correct interface
  try {
    const escrowCode = await ethers.provider.getCode(htlcEscrow);
    if (escrowCode === "0x") {
      results.errors.push(`HTLCEscrow contract not deployed at ${htlcEscrow}`);
      results.valid = false;
    } else {
      // Verify the contract has expected interface
      const escrow = await ethers.getContractAt("HTLCEscrow", htlcEscrow);
      try {
        const onChainRegistry = await escrow.resolverRegistry();
        if (onChainRegistry.toLowerCase() !== resolverRegistry.toLowerCase()) {
          results.errors.push(
            `HTLCEscrow.resolverRegistry = ${onChainRegistry} but expected ${resolverRegistry}`
          );
          results.valid = false;
        }
      } catch {
        results.errors.push("HTLCEscrow does not have expected interface (missing resolverRegistry)");
        results.valid = false;
      }
    }
  } catch (err: any) {
    results.errors.push(`Failed to verify HTLCEscrow: ${err?.message ?? String(err)}`);
    results.valid = false;
  }

  // Verify ResolverRegistry contract exists
  try {
    const registryCode = await ethers.provider.getCode(resolverRegistry);
    if (registryCode === "0x") {
      results.errors.push(`ResolverRegistry contract not deployed at ${resolverRegistry}`);
      results.valid = false;
    }
  } catch (err: any) {
    results.errors.push(`Failed to verify ResolverRegistry: ${err?.message ?? String(err)}`);
    results.valid = false;
  }
}

async function validateDeploymentParameters(artifact: DeploymentArtifact, results: ValidationResult): Promise<void> {
  const config = artifact.stellar?.resolverRegistryConfig || artifact.config;
  if (!config) {
    results.warnings.push("No config section in deployment artifact");
    return;
  }

  const { stakeAsset, minStake } = config;
  const minSafetyDeposit = (config as any).minSafetyDeposit;

  // For Ethereum network validation, stake asset from stellar config is a Stellar asset, not an ETH address.
  // We should skip checking it as an ETH contract if it's from the stellar config.
  if (stakeAsset && artifact.config?.stakeAsset && stakeAsset !== ethers.ZeroAddress) {
    const code = await ethers.provider.getCode(stakeAsset);
    if (code === "0x") {
      results.warnings.push(`Stake asset ${stakeAsset} is not a contract on this network`);
    }
  } else if (artifact.config && stakeAsset === ethers.ZeroAddress) {
    results.warnings.push("Stake asset is zero address - native ETH staking may not be supported");
  }

  // Validate minStake is reasonable
  if (minStake && BigInt(minStake) < 0) {
    results.errors.push(`Invalid minStake value: ${minStake}`);
    results.valid = false;
  }

  // Validate minSafetyDeposit
  if (minSafetyDeposit && BigInt(minSafetyDeposit) < 0) {
    results.errors.push(`Invalid minSafetyDeposit value: ${minSafetyDeposit}`);
    results.valid = false;
  }
}

async function validateChainId(artifact: DeploymentArtifact, results: ValidationResult): Promise<void> {
  const providerNetwork = await ethers.provider.getNetwork();
  const actualChainId = Number(providerNetwork.chainId);
  const expectedChainId = artifact.ethereum?.chainId || artifact.chainId;

  if (expectedChainId && actualChainId !== expectedChainId) {
    results.errors.push(
      `Chain ID mismatch: RPC reports ${actualChainId}, but artifact expects ${expectedChainId}`
    );
    results.valid = false;
  }
}

async function main(): Promise<void> {
  console.log("\n=== WaffleFinance Deployment Validation ===\n");

  const results: ValidationResult = { valid: true, errors: [], warnings: [] };

  const artifact = readDeploymentArtifact();
  if (!artifact) {
    console.error(`No deployment artifact found for network '${network.name}'`);
    console.error("Run deployment first: pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network <network>");
    process.exit(1);
  }

  console.log(`Validating deployment for: ${artifact.network}`);
  console.log(`Deployed at: ${artifact.deployedAt}`);

  // Verify chain ID
  console.log("\n1. Verifying chain ID...");
  await validateChainId(artifact, results);

  // Verify Ethereum contracts
  console.log("2. Verifying Ethereum contracts...");
  await validateEthereumContracts(artifact, results);

  // Validate deployment parameters
  console.log("3. Validating deployment parameters...");
  await validateDeploymentParameters(artifact, results);

  // Print results
  console.log("\n=== Validation Results ===\n");

  if (results.errors.length > 0) {
    console.log("Errors:");
    for (const err of results.errors) {
      console.log(`  ❌ ${err}`);
    }
  }

  if (results.warnings.length > 0) {
    console.log("Warnings:");
    for (const warn of results.warnings) {
      console.log(`  ⚠️  ${warn}`);
    }
  }

  if (results.valid) {
    console.log("✅ All validations passed!");
    console.log("\nDeployment is ready for use.");
  } else {
    console.log("\n❌ Validation failed. Fix errors before deploying.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nValidation failed with error:", err);
  process.exit(1);
});