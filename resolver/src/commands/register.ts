import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseUnits,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";
import { loadConfig } from "../config.js";
import { getLogger } from "../logger.js";

const REGISTRY_ABI = parseAbi([
  "function register(uint256 stake)",
  "function increaseStake(uint256 additional)",
  "function unregister()",
  "function isActive(address resolver) view returns (bool)",
  "function get(address resolver) view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active))",
  "function getActiveResolvers() view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active)[])",
  "function getBatchInfo(address[] resolvers) view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active)[])",
  "function list() view returns (address[])",
  "function getResolverCount() view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function stakeAsset() view returns (address)"
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
]);

function ensureEvmContext() {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);

  if (!cfg.ethereum.resolverRegistry) {
    throw new Error("ETH_RESOLVER_REGISTRY contract address is not configured");
  }
  if (!cfg.ethereum.resolverPrivateKey) {
    throw new Error("RESOLVER_ETH_PRIVATE_KEY env var is required for registry actions");
  }

  const chain = cfg.ethereum.chainId === 1 ? mainnet : sepolia;
  const account = privateKeyToAccount(cfg.ethereum.resolverPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(cfg.ethereum.rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(cfg.ethereum.rpcUrl) });

  return { cfg, log, account, publicClient, walletClient };
}

export async function registerCommand(amountInput?: string): Promise<void> {
  const { cfg, log, account, publicClient, walletClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;

  const stakeAsset = (await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "stakeAsset"
  })) as Address;
  const decimals = await publicClient.readContract({
    address: stakeAsset,
    abi: ERC20_ABI,
    functionName: "decimals"
  });
  const symbol = await publicClient.readContract({
    address: stakeAsset,
    abi: ERC20_ABI,
    functionName: "symbol"
  });

  const minStake = (await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "minStake"
  })) as bigint;

  const stake = amountInput
    ? parseUnits(amountInput, decimals as number)
    : minStake;

  if (stake < minStake) {
    throw new Error(`Stake ${stake} is below minimum ${minStake}`);
  }

  log.info({ stakeAsset, symbol, stake: stake.toString() }, "approving stake transfer");
  const approveTx = await walletClient.writeContract({
    address: stakeAsset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [registry, stake]
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  log.info({ stake: stake.toString() }, "calling registry.register");
  const tx = await walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "register",
    args: [stake]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  log.info({ tx, gasUsed: receipt.gasUsed.toString() }, "registered as resolver");
  log.info(`Resolver ${account.address} is now registered with ${stake} ${symbol}.`);
}

export async function statusCommand(): Promise<void> {
  const { cfg, log, account, publicClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;

  const [info, active, minStake] = await Promise.all([
    publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "get",
      args: [account.address]
    }),
    publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "isActive",
      args: [account.address]
    }),
    publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "minStake"
    })
  ]);
  log.info({ info, active, minStake: (minStake as bigint).toString() }, "resolver status");
}

export async function unregisterCommand(): Promise<void> {
  const { cfg, log, account, publicClient, walletClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;
  const tx = await walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "unregister"
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  log.info({ tx, resolver: account.address }, "unregistered");
}
