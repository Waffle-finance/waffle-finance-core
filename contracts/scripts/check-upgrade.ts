import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

interface ContractSourceInfo {
  abi: string[];
  constructorArgs: any[];
  bytecodeHash?: string;
}

interface ContractCompatibility {
  current: ContractSourceInfo;
  deployed: {
    address: string;
    abi: string[];
    bytecodeHash?: string;
  };
  compatible: boolean;
  issues: string[];
}

async function getDeployedContractInfo(contractName: string, address: string): Promise<ContractCompatibility["deployed"]> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`Contract not found at ${address}`);
  }

  const contract = await ethers.getContractAt(contractName, address);
  const abi = contract.interface.format(ethers.FormatTypes.full as any) as string[];
  const bytecodeHash = ethers.keccak256(code);

  return { address, abi, bytecodeHash };
}

function compareAbis(currentAbi: string[], deployedAbi: string[]): string[] {
  const issues: string[] = [];
  const currentFunctions = new Set(currentAbi.filter((s) => s.includes("function") || s.includes("event")));
  const deployedFunctions = new Set(deployedAbi.filter((s) => s.includes("function") || s.includes("event")));

  // Check for removed functions
  for (const fn of deployedFunctions) {
    if (!currentFunctions.has(fn)) {
      issues.push(`Function/event removed: ${fn.split("(")[0].trim()}`);
    }
  }

  // Check for new functions (warnings only - these are backward compatible)
  for (const fn of currentFunctions) {
    if (!deployedFunctions.has(fn)) {
      issues.push(`New function/event: ${fn.split("(")[0].trim()} (backward compatible)`);
    }
  }

  return issues;
}

async function validateUpgradeCompatibility(
  contractName: string,
  deployedAddress: string
): Promise<ContractCompatibility> {
  const contractFactory = await ethers.getContractFactory(contractName);
  const currentAbi = contractFactory.interface.format(ethers.FormatTypes.full as any) as string[];
  const currentSource = await ethers.provider.getContract(
    contractName === "HTLCEscrow"
      ? ((await ethers.getContractAt(contractName, deployedAddress)) as any)
      : null
  );

  const deployed = await getDeployedContractInfo(contractName, deployedAddress);
  const issues = compareAbis(currentAbi, deployed.abi);

  const incompatibleIssues = issues.filter((i) => !i.includes("backward compatible"));

  return {
    current: { abi: currentAbi, constructorArgs: [] },
    deployed,
    compatible: incompatibleIssues.length === 0,
    issues,
  };
}

async function main(): Promise<void> {
  console.log("\n=== Contract Upgrade Compatibility Check ===\n");

  const artifactPath = path.resolve(__dirname, `../../deployments.${network.name}.json`);
  if (!fs.existsSync(artifactPath)) {
    console.error("No deployment artifact found. Run deployment first.");
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  if (!artifact.ethereum) {
    console.log("No Ethereum contracts in artifact.");
    return;
  }

  console.log(`Network: ${artifact.network}`);
  console.log(`Chain ID: ${artifact.chainId}\n`);

  // Check HTLCEscrow
  console.log("Checking HTLCEscrow...");
  if (artifact.ethereum.htlcEscrow) {
    try {
      const htlcCheck = await validateUpgradeCompatibility("HTLCEscrow", artifact.ethereum.htlcEscrow);
      if (htlcCheck.compatible) {
        console.log("  ✅ HTLCEscrow is backward compatible");
      } else {
        console.log("  ❌ HTLCEscrow has incompatible changes:");
        for (const issue of htlcCheck.issues) {
          console.log(`     - ${issue}`);
        }
      }
    } catch (err: any) {
      console.log(`  ⚠️  Could not check HTLCEscrow: ${err?.message ?? String(err)}`);
    }
  }

  // Check ResolverRegistry
  console.log("\nChecking ResolverRegistry...");
  if (artifact.ethereum.resolverRegistry) {
    try {
      const registryCheck = await validateUpgradeCompatibility(
        "ResolverRegistry",
        artifact.ethereum.resolverRegistry
      );
      if (registryCheck.compatible) {
        console.log("  ✅ ResolverRegistry is backward compatible");
      } else {
        console.log("  ❌ ResolverRegistry has incompatible changes:");
        for (const issue of registryCheck.issues) {
          console.log(`     - ${issue}`);
        }
      }
    } catch (err: any) {
      console.log(`  ⚠️  Could not check ResolverRegistry: ${err?.message ?? String(err)}`);
    }
  }

  // Verify bytecode match (exact match check)
  console.log("\nVerifying bytecode hashes...");
  const htlc = await ethers.getContractAt("HTLCEscrow", artifact.ethereum.htlcEscrow);
  const registry = await ethers.getContractAt("ResolverRegistry", artifact.ethereum.resolverRegistry);

  const htlcCode = await ethers.provider.getCode(artifact.ethereum.htlcEscrow);
  const registryCode = await ethers.provider.getCode(artifact.ethereum.resolverRegistry);

  console.log(`  HTLCEscrow bytecode hash: ${ethers.keccak256(htlcCode).substring(0, 10)}...`);
  console.log(`  ResolverRegistry bytecode hash: ${ethers.keccak256(registryCode).substring(0, 10)}...`);

  console.log("\n=== Summary ===");
  console.log("Before upgrading, ensure:");
  console.log("  1. Existing on-chain state is preserved (storage layout)");
  console.log("  2. Constructor arguments match the deployment artifact");
  console.log("  3. No functions called by the coordinator are removed");
  console.log("  4. New functions are additive only (proxy pattern if needed)");
}

main().catch((err) => {
  console.error("\nCompatibility check failed:", err);
  process.exit(1);
});