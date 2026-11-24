import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import * as fs from 'fs';
import * as path from 'path';
import type { HTLCEscrow, ResolverRegistry, TestERC20 } from '../typechain-types';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const TIMELOCK = 600; // 10 minutes
const SAFETY_DEPOSIT = ethers.parseEther('0.001');
const AMOUNT = ethers.parseEther('0.5');
const MIN_STAKE = ethers.parseEther('10');

// Fixed fixtures keep snapshots reproducible across runs and machines.
const FIXED_PREIMAGE = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FIXED_HASHLOCK = ethers.sha256(FIXED_PREIMAGE);

// Gas thresholds for regression detection (wei of gas × 1)
// These are designed to catch significant regressions while avoiding false positives
const GAS_THRESHOLDS = {
  // HTLCEscrow operations
  createOrderNative: 200_000n, // Native ETH order creation
  createOrderERC20: 300_000n, // ERC20 order creation
  claimOrder: 200_000n, // Claim with preimage reveal
  refundOrder: 150_000n, // Refund after timelock expiry
  withdraw: 100_000n, // Withdraw credited balance
  withdrawFallback: 120_000n, // Pull-payment fallback when direct transfer fails

  // ResolverRegistry operations
  register: 200_000n, // Register as resolver with stake
  increaseStake: 150_000n, // Increase existing stake
  unregister: 150_000n, // Unregister and withdraw stake
  slash: 150_000n, // Slash a resolver
};

// Tolerance applied to the checked-in snapshot baseline. This is intentionally
// tighter than the absolute thresholds above: it catches meaningful regressions
// (e.g. extra storage writes) while ignoring insignificant compiler noise.
const SNAPSHOT_TOLERANCE_BPS = 300n; // 3%
const BPS_DENOMINATOR = 10_000n;

const SNAPSHOT_PATH = path.join(__dirname, 'gas-snapshots', 'order-lifecycle.json');

type SnapshotKey =
  | 'createOrderNative'
  | 'createOrderERC20'
  | 'claimOrderNative'
  | 'claimOrderERC20'
  | 'refundOrderNative'
  | 'refundOrderERC20'
  | 'withdrawFallback';

type GasSnapshot = Partial<Record<SnapshotKey, string>>;

function loadSnapshot(): GasSnapshot {
  if (!fs.existsSync(SNAPSHOT_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as GasSnapshot;
  } catch {
    return {};
  }
}

const SNAPSHOT = loadSnapshot();
const OBSERVED: GasSnapshot = {};

/**
 * Compare an observed gas value against the checked-in snapshot baseline.
 * - When no baseline exists, the value is recorded (first run establishes it).
 * - When a baseline exists, a regression beyond SNAPSHOT_TOLERANCE_BPS fails.
 * - Improvements are reported but do not fail, so reviewers can refresh.
 */
function assertSnapshot(key: SnapshotKey, actual: bigint) {
  OBSERVED[key] = actual.toString();
  const baselineStr = SNAPSHOT[key];

  if (!baselineStr) {
    console.log(`  ├─ ${key}: ${actual.toString()} gas (no baseline yet)`);
    return;
  }

  const baseline = BigInt(baselineStr);
  const tolerance = (baseline * SNAPSHOT_TOLERANCE_BPS) / BPS_DENOMINATOR;
  const limit = baseline + tolerance;
  const delta = actual - baseline;
  const deltaPct = baseline === 0n ? 0n : (delta * BPS_DENOMINATOR) / baseline;

  console.log(
    `  ├─ ${key}: ${actual.toString()} gas ` +
      `(baseline: ${baseline.toString()}, delta: ${delta.toString()}, ` +
      `${(Number(deltaPct) / 100).toFixed(2)}%)`
  );

  if (actual > limit) {
    console.error(
      `  └─ ⚠️  GAS SNAPSHOT REGRESSION: ${key} used ${actual.toString()} gas, ` +
        `exceeding baseline ${baseline.toString()} + ${SNAPSHOT_TOLERANCE_BPS / 100n}% ` +
        `(limit: ${limit.toString()}). Refresh the snapshot only after review.`
    );
  }

  expect(actual).to.be.lte(
    limit,
    `${key} gas usage (${actual}) exceeds snapshot baseline (${baseline}) + tolerance`
  );
}

async function deployEscrow(
  resolverRegistry: string = ZERO_ADDR,
  minSafetyDeposit: bigint = SAFETY_DEPOSIT
) {
  const HTLCEscrow = await ethers.getContractFactory('HTLCEscrow');
  return (await HTLCEscrow.deploy(resolverRegistry, minSafetyDeposit)) as unknown as HTLCEscrow;
}

async function deployToken() {
  const Token = await ethers.getContractFactory('TestERC20');
  return (await Token.deploy(
    'MockToken',
    'MOCK',
    ethers.parseEther('1000000')
  )) as unknown as TestERC20;
}

async function deployReceiverMock(mode: 'Reject' | 'Guzzle') {
  const Receiver = await ethers.getContractFactory('HTLCReceiverMock');
  return await Receiver.deploy(mode === 'Reject' ? 0 : 1);
}

async function deployResolverRegistry() {
  const Token = await ethers.getContractFactory('TestERC20');
  const stakeToken = (await Token.deploy(
    'StakeToken',
    'STAKE',
    ethers.parseEther('1000000')
  )) as unknown as TestERC20;

  const [owner, resolver] = await ethers.getSigners();
  
  // Transfer some tokens to the resolver so they can test staking
  await stakeToken.connect(owner).transfer(resolver.address, ethers.parseEther('10000'));

  const ResolverRegistry = await ethers.getContractFactory('ResolverRegistry');
  const registry = (await ResolverRegistry.deploy(
    await stakeToken.getAddress(),
    MIN_STAKE,
    owner.address,
    owner.address
  )) as unknown as ResolverRegistry;

  return { registry, stakeToken };
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Measure gas used by a transaction.
 * Returns the gas used in decimal form for easy logging and comparison.
 */
async function measureGas(tx: any): Promise<bigint> {
  if (!tx) throw new Error('Transaction is null');
  const receipt = await tx.wait();
  if (!receipt) throw new Error('Receipt is null');
  return receipt.gasUsed;
}

/**
 * Assert that gas usage is below threshold and log the result.
 * Helps catch regressions early.
 */
function assertGasBelow(actual: bigint, threshold: bigint, operationName: string) {
  const overhead = (threshold * 10n) / 100n; // Allow 10% variance for slight fluctuations
  const limit = threshold + overhead;

  console.log(`  ├─ ${operationName}: ${actual.toString()} gas (limit: ${limit.toString()})`);

  if (actual > limit) {
    console.error(
      `  └─ ⚠️  GAS REGRESSION: ${operationName} used ${actual.toString()} gas, ` +
        `exceeding limit of ${limit.toString()} (threshold: ${threshold.toString()})`
    );
  }

  expect(actual).to.be.lte(
    limit,
    `${operationName} gas usage (${actual}) exceeds threshold (${threshold}) + 10% variance`
  );
}

describe('Gas Regression Suite', () => {
  describe('HTLCEscrow Gas Benchmarks', () => {
    describe('createOrder', () => {
      it('createOrder with native ETH should not regress', async () => {
        const [sender, beneficiary] = await ethers.getSigners();
        const escrow = await deployEscrow();

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        const tx = await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.createOrderNative, 'createOrder(native)');
      });

      it('createOrder with ERC20 should not regress', async () => {
        const [sender, beneficiary] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();

        // Grant approval and balance
        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        const tx = await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            TIMELOCK,
            { value: SAFETY_DEPOSIT }
          );

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.createOrderERC20, 'createOrder(ERC20)');
      });
    });

    describe('claimOrder', () => {
      it('claimOrder should not regress', async () => {
        const [sender, beneficiary, claimer] = await ethers.getSigners();
        const escrow = await deployEscrow();

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        // Create an order
        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        const orderId = 1n;

        // Claim the order
        const tx = await escrow.connect(claimer).claimOrder(orderId, preimage);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.claimOrder, 'claimOrder');
      });

      it('claimOrder with ERC20 should not regress', async () => {
        const [sender, beneficiary, claimer] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();

        // Grant approval
        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        // Create ERC20 order
        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            TIMELOCK,
            { value: SAFETY_DEPOSIT }
          );

        const orderId = 1n;

        // Claim the order
        const tx = await escrow.connect(claimer).claimOrder(orderId, preimage);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.claimOrder, 'claimOrder(ERC20)');
      });
    });

    describe('refundOrder', () => {
      it('refundOrder should not regress', async () => {
        const [sender, beneficiary, refunder] = await ethers.getSigners();
        const escrow = await deployEscrow();

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        // Create an order with short timelock for testing
        const shortTimelock = 300; // 5 minutes
        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            shortTimelock,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        const orderId = 1n;

        // Move time forward to expire the order
        await time.increase(shortTimelock + 1);

        // Refund the order
        const tx = await escrow.connect(refunder).refundOrder(orderId);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.refundOrder, 'refundOrder');
      });

      it('refundOrder with ERC20 should not regress', async () => {
        const [sender, beneficiary, refunder] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();

        // Grant approval
        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        const shortTimelock = 300;
        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            shortTimelock,
            { value: SAFETY_DEPOSIT }
          );

        const orderId = 1n;

        // Move time forward to expire
        await time.increase(shortTimelock + 1);

        // Refund the order
        const tx = await escrow.connect(refunder).refundOrder(orderId);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.refundOrder, 'refundOrder(ERC20)');
      });
    });

    describe('withdraw', () => {
      it('withdraw should not regress', async () => {
        const [sender, beneficiary, claimer] = await ethers.getSigners();
        const escrow = await deployEscrow();

        const preimage = randomBytes32();
        const hashlock = ethers.sha256(preimage);

        // Create order and claim
        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            hashlock,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        await escrow.connect(claimer).claimOrder(1n, preimage);

        // Attempt to withdraw (will go to pull-payment if needed)
        const pendingBefore = await escrow.pendingWithdrawals(claimer.address);

        if (pendingBefore > 0n) {
          const tx = await escrow.connect(claimer).withdraw();
          const gas = await measureGas(tx);
          assertGasBelow(gas, GAS_THRESHOLDS.withdraw, 'withdraw');
        } else {
          console.log('  ├─ withdraw: skipped (no pending balance in this case)');
        }
      });
    });

    describe('snapshots', () => {
      it('createOrder(native) snapshot', async () => {
        const [sender, beneficiary] = await ethers.getSigners();
        const escrow = await deployEscrow();

        const tx = await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.createOrderNative, 'createOrder(native)');
        assertSnapshot('createOrderNative', gas);
      });

      it('createOrder(ERC20) snapshot', async () => {
        const [sender, beneficiary] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();

        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        const tx = await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            TIMELOCK,
            { value: SAFETY_DEPOSIT }
          );

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.createOrderERC20, 'createOrder(ERC20)');
        assertSnapshot('createOrderERC20', gas);
      });

      it('claimOrder(native) snapshot', async () => {
        const [sender, beneficiary, claimer] = await ethers.getSigners();
        const escrow = await deployEscrow();

        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        const tx = await escrow.connect(claimer).claimOrder(1n, FIXED_PREIMAGE);
        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.claimOrder, 'claimOrder(native)');
        assertSnapshot('claimOrderNative', gas);
      });

      it('claimOrder(ERC20) snapshot', async () => {
        const [sender, beneficiary, claimer] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();

        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            TIMELOCK,
            { value: SAFETY_DEPOSIT }
          );

        const tx = await escrow.connect(claimer).claimOrder(1n, FIXED_PREIMAGE);
        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.claimOrder, 'claimOrder(ERC20)');
        assertSnapshot('claimOrderERC20', gas);
      });

      it('refundOrder(native) snapshot', async () => {
        const [sender, beneficiary, refunder] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const shortTimelock = 300;

        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            shortTimelock,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        await time.increase(shortTimelock + 1);

        const tx = await escrow.connect(refunder).refundOrder(1n);
        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.refundOrder, 'refundOrder(native)');
        assertSnapshot('refundOrderNative', gas);
      });

      it('refundOrder(ERC20) snapshot', async () => {
        const [sender, beneficiary, refunder] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const token = await deployToken();
        const shortTimelock = 300;

        await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

        await escrow
          .connect(sender)
          .createOrder(
            beneficiary.address,
            sender.address,
            await token.getAddress(),
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            shortTimelock,
            { value: SAFETY_DEPOSIT }
          );

        await time.increase(shortTimelock + 1);

        const tx = await escrow.connect(refunder).refundOrder(1n);
        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.refundOrder, 'refundOrder(ERC20)');
        assertSnapshot('refundOrderERC20', gas);
      });

      it('withdraw fallback snapshot (rejecting receiver)', async () => {
        const [sender, beneficiary] = await ethers.getSigners();
        const escrow = await deployEscrow();
        const receiver = await deployReceiverMock('Reject');

        // Beneficiary is a contract that rejects ETH, forcing the pull-payment path.
        await escrow
          .connect(sender)
          .createOrder(
            await receiver.getAddress(),
            sender.address,
            ZERO_ADDR,
            AMOUNT,
            SAFETY_DEPOSIT,
            FIXED_HASHLOCK,
            TIMELOCK,
            { value: AMOUNT + SAFETY_DEPOSIT }
          );

        await escrow.connect(sender).claimOrder(1n, FIXED_PREIMAGE);

        const pending = await escrow.pendingWithdrawals(await receiver.getAddress());
        expect(pending).to.be.gt(0n, 'expected fallback to credit pending balance');

        const tx = await receiver.withdrawFrom(await escrow.getAddress());
        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.withdrawFallback, 'withdraw(fallback)');
        assertSnapshot('withdrawFallback', gas);
      });

      it('reports snapshot deltas for CI review', async () => {
        const keys = Object.keys(OBSERVED) as SnapshotKey[];
        if (keys.length === 0) return;

        console.log('\n  Gas snapshot deltas vs checked-in baseline:');
        for (const key of keys) {
          const actual = BigInt(OBSERVED[key]!);
          const baselineStr = SNAPSHOT[key];
          if (!baselineStr) {
            console.log(`  ├─ ${key}: NEW baseline ${actual.toString()}`);
            continue;
          }
          const baseline = BigInt(baselineStr);
          const delta = actual - baseline;
          const sign = delta >= 0n ? '+' : '';
          console.log(`  ├─ ${key}: ${sign}${delta.toString()} gas`);
        }
      });
    });
  });

  describe('ResolverRegistry Gas Benchmarks', () => {
    describe('register', () => {
      it('register should not regress', async () => {
        const [, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Approve stake amount
        await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);

        const tx = await registry.connect(resolver).register(MIN_STAKE);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.register, 'register');
      });
    });

    describe('increaseStake', () => {
      it('increaseStake should not regress', async () => {
        const [, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Register first
        await stakeToken
          .connect(resolver)
          .approve(await registry.getAddress(), MIN_STAKE + ethers.parseEther('5'));
        await registry.connect(resolver).register(MIN_STAKE);

        // Now increase stake
        const additionalStake = ethers.parseEther('5');
        const tx = await registry.connect(resolver).increaseStake(additionalStake);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.increaseStake, 'increaseStake');
      });
    });

    describe('unregister', () => {
      it('unregister should not regress', async () => {
        const [, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Register first
        await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
        await registry.connect(resolver).register(MIN_STAKE);

        // Now unregister
        const tx = await registry.connect(resolver).unregister();

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.unregister, 'unregister');
      });
    });

    describe('slash', () => {
      it('slash should not regress', async () => {
        const [owner, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Register a resolver
        await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
        await registry.connect(resolver).register(MIN_STAKE);

        // Slash the resolver
        const slashAmount = ethers.parseEther('1');
        const tx = await registry.connect(owner).slash(resolver.address, slashAmount, 0n);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.slash, 'slash');
      });

      it('slash full stake should not regress', async () => {
        const [owner, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Register a resolver
        await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
        await registry.connect(resolver).register(MIN_STAKE);

        // Slash the full stake (contract rejects amounts exceeding the stake)
        const tx = await registry.connect(owner).slash(resolver.address, MIN_STAKE, 0n);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.slash, 'slash(full-stake)');
      });
    });
  });

  describe('Gas Summary Report', () => {
    it('should provide gas summary', async () => {
      console.log('\n');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║              Gas Regression Baseline Report                 ║');
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log('║ HTLCEscrow Operations                                       ║');
      console.log('╟────────────────────────────────────────────────────────────╢');
      console.log(
        `║ • createOrder(native):        ${String(GAS_THRESHOLDS.createOrderNative).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • createOrder(ERC20):         ${String(GAS_THRESHOLDS.createOrderERC20).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • claimOrder:                 ${String(GAS_THRESHOLDS.claimOrder).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • refundOrder:                ${String(GAS_THRESHOLDS.refundOrder).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • withdraw:                   ${String(GAS_THRESHOLDS.withdraw).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • withdraw(fallback):         ${String(GAS_THRESHOLDS.withdrawFallback).padEnd(7)} gas (base)  ║`
      );
      console.log('╟────────────────────────────────────────────────────────────╢');
      console.log('║ ResolverRegistry Operations                                 ║');
      console.log('╟────────────────────────────────────────────────────────────╢');
      console.log(
        `║ • register:                   ${String(GAS_THRESHOLDS.register).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • increaseStake:              ${String(GAS_THRESHOLDS.increaseStake).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • unregister:                 ${String(GAS_THRESHOLDS.unregister).padEnd(7)} gas (base)  ║`
      );
      console.log(
        `║ • slash:                      ${String(GAS_THRESHOLDS.slash).padEnd(7)} gas (base)  ║`
      );
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log('║ Note: All values allow +10% variance for minor fluctuations ║');
      console.log(`║ Snapshots: ${SNAPSHOT_PATH.replace(process.cwd() + '/', '').padEnd(47)}║`);
      console.log(`║ Snapshot tolerance: ${(SNAPSHOT_TOLERANCE_BPS / 100n).toString()}% vs checked-in baseline${' '.repeat(18)}║`);
      console.log("║ Run with: npx hardhat test --grep 'Gas Regression'         ║");
      console.log('╚════════════════════════════════════════════════════════════╝\n');
    });
  });

  describe('Integration: Full Cross-Chain Swap Sequence', () => {
    it('should measure end-to-end gas for a full swap sequence', async () => {
      const [creator, beneficiary, claimer] = await ethers.getSigners();
      const escrow = await deployEscrow();

      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      const shortTimelock = 300;

      console.log('\n  ╔═══════════════════════════════════════════════════════╗');
      console.log('  ║         Full Swap Sequence Gas Analysis              ║');
      console.log('  ╠═══════════════════════════════════════════════════════╣');

      // Step 1: User creates order
      const createTx = await escrow
        .connect(creator)
        .createOrder(
          beneficiary.address,
          creator.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          shortTimelock,
          { value: AMOUNT + SAFETY_DEPOSIT }
        );
      const createGas = await measureGas(createTx);
      console.log(`  ├─ Step 1 - Create Order:       ${createGas.toString().padEnd(8)} gas`);

      const orderId = 1n;

      // Step 2: Beneficiary claims with preimage
      const claimTx = await escrow.connect(claimer).claimOrder(orderId, preimage);
      const claimGas = await measureGas(claimTx);
      console.log(`  ├─ Step 2 - Claim Order:        ${claimGas.toString().padEnd(8)} gas`);

      // Step 3: Total cost
      const totalGas = createGas + claimGas;
      console.log(`  ├─ Total Gas (Create + Claim): ${totalGas.toString().padEnd(8)} gas`);
      console.log('  ╠═══════════════════════════════════════════════════════╣');
      console.log(
        `  ║ Average per operation: ${(totalGas / 2n).toString().padEnd(7)} gas             ║`
      );
      console.log('  ╚═══════════════════════════════════════════════════════╝\n');
    });
  });
});
