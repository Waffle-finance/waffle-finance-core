import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { runPreflightChecks } from "./validateEnv";

/**
 * WaffleFinance v2 deployment script.
 *
 * Deploys ResolverRegistry + HTLCEscrow on the configured network and
 * writes the addresses to `deployments.<network>.json` at the repo root,
 * which the coordinator and frontend pick up via env vars.
 *
 * Usage:
 *   pnpm hardhat run scripts/deploy.ts --network sepolia
 *   pnpm hardhat run scripts/deploy.ts --network mainnet
 *
 * Required env vars:
 *   - RELAYER_PRIVATE_KEY   (deployer; will be the registry owner)
 *   - V2_STAKE_ASSET        (ERC20 used for resolver staking on this network)
 *   - V2_MIN_STAKE          (in wei of the stake asset)
 *
 * Optional env vars:
 *   - V2_MIN_SAFETY_DEPOSIT (in wei of native ETH; default: 0)
 *
 * See env.example at the repository root for a full variable reference.
 */

async function main(): Promise<void> {
  // ── Preflight checks ────────────────────────────────────────────────────────
  // Validate ALL required env vars before touching the network or spending gas.
  // runPreflightChecks throws (and exits non-zero) on any hard error.
  runPreflightChecks(network.name);

  // ── Deployer info ───────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Network:  ${network.name}`);

  // ── Deployer balance check ──────────────────────────────────────────────────
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  const WARN_BALANCE_THRESHOLD = ethers.parseEther("0.01");
  if (balance < WARN_BALANCE_THRESHOLD) {
    console.warn(
      `\n⚠️  Deployer balance is very low (${ethers.formatEther(balance)} ETH). ` +
        "Deployment transactions may fail due to insufficient gas funds.\n"
    );
  }

  // ── Deployment parameters ───────────────────────────────────────────────────
  // Safe to access here: runPreflightChecks already confirmed their presence
  // and format.  The fallback strings satisfy the type-checker without !.
  const stakeAsset = (process.env["V2_STAKE_ASSET"] ?? "").trim();
  const minStake = BigInt(process.env["V2_MIN_STAKE"] ?? "0");
  const minSafetyDeposit = BigInt(process.env["V2_MIN_SAFETY_DEPOSIT"] ?? "0");

  console.log("\nDeployment parameters:");
  console.log(`  stakeAsset:        ${stakeAsset}`);
  console.log(`  minStake:          ${minStake.toString()} wei`);
  console.log(`  minSafetyDeposit:  ${minSafetyDeposit.toString()} wei`);

  // ── Chain-id sanity check ───────────────────────────────────────────────────
  // Confirm the RPC endpoint corresponds to the expected network so we don't
  // accidentally deploy to mainnet when --network sepolia was intended.
  const providerNetwork = await ethers.provider.getNetwork();
  const actualChainId = Number(providerNetwork.chainId);

  const EXPECTED_CHAIN_IDS: Record<string, number> = {
    hardhat: 1337,
    localhost: 1337,
    sepolia: 11155111,
    mainnet: 1,
  };

  const expectedChainId = EXPECTED_CHAIN_IDS[network.name];
  if (expectedChainId !== undefined && actualChainId !== expectedChainId) {
    throw new Error(
      `Chain-ID mismatch: --network ${network.name} expects chainId ${expectedChainId} ` +
        `but the RPC endpoint returned chainId ${actualChainId}. ` +
        "Check your RPC URL and network configuration."
    );
  }

  console.log(`\nChain ID: ${actualChainId} ✓`);

  // ── Deploy ResolverRegistry ─────────────────────────────────────────────────
  console.log("\nDeploying ResolverRegistry...");
  const Registry = await ethers.getContractFactory("ResolverRegistry");
  const registry = await Registry.deploy(
    stakeAsset,
    minStake,
    deployer.address, // slashBeneficiary — move to DAO/treasury post-audit
    deployer.address  // owner            — move to DAO/multisig post-audit
  );
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`  ResolverRegistry @ ${registryAddress}`);

  // ── Deploy HTLCEscrow ───────────────────────────────────────────────────────
  console.log("Deploying HTLCEscrow...");
  const Escrow = await ethers.getContractFactory("HTLCEscrow");
  const escrow = await Escrow.deploy(registryAddress, minSafetyDeposit);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`  HTLCEscrow @ ${escrowAddress}`);

  // ── Post-deploy verification ────────────────────────────────────────────────
  // Read immutables back from chain to confirm the deployment parameters landed
  // as intended.
  const onChainRegistry = await escrow.resolverRegistry();
  const onChainMinSD = await escrow.minSafetyDeposit();

  if (onChainRegistry.toLowerCase() !== registryAddress.toLowerCase()) {
    throw new Error(
      `HTLCEscrow.resolverRegistry() = ${onChainRegistry} but expected ${registryAddress}. ` +
        "Deployment may have been corrupted."
    );
  }
  if (onChainMinSD !== minSafetyDeposit) {
    throw new Error(
      `HTLCEscrow.minSafetyDeposit() = ${onChainMinSD.toString()} but expected ${minSafetyDeposit.toString()}. ` +
        "Deployment may have been corrupted."
    );
  }

  console.log("\n✅ On-chain parameter verification passed.");

  // ── Write deployment summary ────────────────────────────────────────────────
  const out = {
    network: network.name,
    chainId: actualChainId,
    deployer: deployer.address,
    ethereum: {
      htlcEscrow: escrowAddress,
      resolverRegistry: registryAddress,
    },
    config: {
      stakeAsset,
      minStake: minStake.toString(),
      minSafetyDeposit: minSafetyDeposit.toString(),
    },
    deployedAt: new Date().toISOString(),
  };

  // Repo root: contracts/../deployments.<network>.json
  const outPath = path.resolve(
    __dirname,
    `../../../deployments.${network.name}.json`
  );

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      existing = {};
    }
  }

  const merged: Record<string, unknown> = {
    ...existing,
    ...out,
    ethereum: out.ethereum,
  };
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log(`\nDeployment summary written to ${outPath}`);
  console.log("\n── Deployment complete ──────────────────────────────────────");
  console.log(`  ResolverRegistry: ${registryAddress}`);
  console.log(`  HTLCEscrow:       ${escrowAddress}`);
  console.log("────────────────────────────────────────────────────────────\n");
}

main().catch((err: unknown) => {
  console.error("\n❌ Deployment failed:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
