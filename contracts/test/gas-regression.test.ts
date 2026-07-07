import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { HTLCEscrow, ResolverRegistry, TestERC20 } from '../typechain-types';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const TIMELOCK = 600; // 10 minutes
const SAFETY_DEPOSIT = ethers.parseEther('0.001');
const AMOUNT = ethers.parseEther('0.5');
const MIN_STAKE = ethers.parseEther('10');

// Gas thresholds for regression detection (wei of gas × 1)
// These are designed to catch significant regressions while avoiding false positives
const GAS_THRESHOLDS = {
  // HTLCEscrow operations
  createOrderNative: 200_000n, // Native ETH order creation
  createOrderERC20: 300_000n, // ERC20 order creation
  claimOrder: 200_000n, // Claim with preimage reveal
  refundOrder: 150_000n, // Refund after timelock expiry
  withdraw: 100_000n, // Withdraw credited balance

  // ResolverRegistry operations
  register: 200_000n, // Register as resolver with stake
  increaseStake: 150_000n, // Increase existing stake
  unregister: 150_000n, // Unregister and withdraw stake
  slash: 150_000n, // Slash a resolver
};

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
        const tx = await registry.connect(owner).slash(resolver.address, slashAmount);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.slash, 'slash');
      });

      it('slash with amount > stake should not regress', async () => {
        const [owner, resolver] = await ethers.getSigners();
        const { registry, stakeToken } = await deployResolverRegistry();

        // Register a resolver
        await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
        await registry.connect(resolver).register(MIN_STAKE);

        // Slash with amount exceeding stake
        const excessiveSlashAmount = MIN_STAKE * 2n;
        const tx = await registry.connect(owner).slash(resolver.address, excessiveSlashAmount);

        const gas = await measureGas(tx);
        assertGasBelow(gas, GAS_THRESHOLDS.slash, 'slash(excessive)');
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
