import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HTLCEscrow } from "../../typechain-types";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const TIMELOCK = 600; // 10 minutes
const SAFETY_DEPOSIT = ethers.parseEther("0.001");
const AMOUNT = ethers.parseEther("0.5");

async function deployEscrow() {
  const HTLCEscrow = await ethers.getContractFactory("HTLCEscrow");
  // resolverRegistry = address(0) → permissionless createOrder
  return (await HTLCEscrow.deploy(ZERO_ADDR, 0)) as unknown as HTLCEscrow;
}

async function deployToken() {
  const Token = await ethers.getContractFactory("TestERC20");
  return (await Token.deploy("MockToken", "MOCK", ethers.parseEther("1000000"))) as unknown as TestERC20;
}

// Receiver-mock modes (mirrors HTLCReceiverMock.Mode).
const MODE_ACCEPT = 0;
const MODE_REJECT = 1;
const MODE_GUZZLE = 2;

async function deployReceiver() {
  const F = await ethers.getContractFactory("HTLCReceiverMock");
  return await F.deploy();
}

async function deployNoFallbackReceiver() {
  const F = await ethers.getContractFactory("NoFallbackReceiver");
  return await F.deploy();
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

describe("HTLCEscrow v2", () => {
  describe("createOrder", () => {
    it("locks native ETH with correct hashlock/timelock", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();

      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      const tx = await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );
      const receipt = await tx.wait();
      const orderCreated = receipt!.logs.find(
        (l: any) => l.fragment?.name === "OrderCreated"
      ) as any;
      expect(orderCreated).to.not.be.undefined;
      const orderId = orderCreated.args.orderId;
      expect(orderId).to.equal(1n);

      const order = await escrow.getOrder(orderId);
      expect(order.amount).to.equal(AMOUNT);
      expect(order.safetyDeposit).to.equal(SAFETY_DEPOSIT);
      expect(order.beneficiary).to.equal(beneficiary.address);
      expect(order.status).to.equal(0); // Funded
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
        AMOUNT + SAFETY_DEPOSIT
      );
    });

    it("rejects zero amount", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          0,
          SAFETY_DEPOSIT,
          randomBytes32(),
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("rejects zero hashlock", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          ethers.ZeroHash,
          TIMELOCK,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidHashlock");
    });

    it("rejects timelock below MIN_TIMELOCK and above MAX_TIMELOCK", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          299,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidTimelock");

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          24 * 60 * 60 + 1,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidTimelock");
    });

    it("rejects msg.value mismatch for native orders", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: AMOUNT } // missing safety deposit
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidValue");
    });

    it("locks ERC20 with correct allowance", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();

      await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        await token.getAddress(),
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: SAFETY_DEPOSIT }
      );

      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
    });
  });

  describe("claimOrder", () => {
    it("pays beneficiary on correct sha256 preimage and pays caller the safety deposit", async () => {
      const [sender, beneficiary, relayer] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      const beneficiaryBefore = await ethers.provider.getBalance(beneficiary.address);
      const relayerBefore = await ethers.provider.getBalance(relayer.address);

      const tx = await escrow.connect(relayer).claimOrder(1, preimage);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice!;

      const beneficiaryAfter = await ethers.provider.getBalance(beneficiary.address);
      const relayerAfter = await ethers.provider.getBalance(relayer.address);
      expect(beneficiaryAfter - beneficiaryBefore).to.equal(AMOUNT);
      expect(relayerAfter - relayerBefore + gas).to.equal(SAFETY_DEPOSIT);

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(1); // Claimed
    });

    it("also accepts a keccak256 hashlock (EVM convention)", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.keccak256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await expect(escrow.connect(beneficiary).claimOrder(1, preimage)).to.not.be.reverted;
    });

    it("rejects invalid preimage", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      const wrong = randomBytes32();
      await expect(
        escrow.connect(beneficiary).claimOrder(1, wrong)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
    });

    it("rejects claim after expiry", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await time.increase(TIMELOCK + 1);

      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "Expired");
    });

    it("rejects double claim", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await escrow.connect(beneficiary).claimOrder(1, preimage);
      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "OrderNotClaimable");
    });
  });

  describe("refundOrder", () => {
    it("returns the locked amount to the refund address after timeout, permissionlessly", async () => {
      const [sender, beneficiary, cleaner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      const refundAddr = ethers.Wallet.createRandom().address;

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        refundAddr,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      // Refund before expiry → revert
      await expect(
        escrow.connect(cleaner).refundOrder(1)
      ).to.be.revertedWithCustomError(escrow, "NotExpired");

      await time.increase(TIMELOCK + 1);

      const refundBefore = await ethers.provider.getBalance(refundAddr);
      const cleanerBefore = await ethers.provider.getBalance(cleaner.address);

      const tx = await escrow.connect(cleaner).refundOrder(1);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice!;

      expect(await ethers.provider.getBalance(refundAddr)).to.equal(refundBefore + AMOUNT);
      expect(await ethers.provider.getBalance(cleaner.address) + gas).to.equal(
        cleanerBefore + SAFETY_DEPOSIT
      );

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(2); // Refunded
    });

    it("rejects refund after a successful claim", async () => {
      const [sender, beneficiary, cleaner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await escrow.connect(beneficiary).claimOrder(1, preimage);
      await time.increase(TIMELOCK + 1);
      await expect(
        escrow.connect(cleaner).refundOrder(1)
      ).to.be.revertedWithCustomError(escrow, "OrderNotRefundable");
    });
  });

  describe("non-custodial guarantees", () => {
    it("contract has no admin escape hatch", async () => {
      const escrow = await deployEscrow();
      const escrowContract = escrow as any;
      // None of the dangerous admin functions exist on the v2 contract.
      expect(escrowContract.emergencyWithdraw).to.be.undefined;
      expect(escrowContract.pause).to.be.undefined;
      expect(escrowContract.transferOwnership).to.be.undefined;
    });

    it("withdraw() is a self-service pull, not a drain — reverts with no pending balance", async () => {
      // The pull-payment `withdraw()` only ever returns a caller's OWN
      // credited balance; it cannot move locked order funds. A caller with
      // nothing credited gets nothing.
      const [, , stranger] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(stranger).withdraw()
      ).to.be.revertedWithCustomError(escrow, "NoPendingWithdrawal");
    });

    it("receive() rejects stray ETH", async () => {
      const [sender] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        sender.sendTransaction({ to: await escrow.getAddress(), value: 1n })
      ).to.be.reverted;
    });
  });

  describe("native payout failure handling", () => {
    async function setupOrder(beneficiary: string) {
      const [sender] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      await escrow.connect(sender).createOrder(
        beneficiary,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );
      return { escrow, preimage, sender };
    }

    it("pushes directly to EOA beneficiaries — no deferral", async () => {
      const [, beneficiary, relayer] = await ethers.getSigners();
      const { escrow, preimage } = await setupOrder(beneficiary.address);
      const escrowAddr = await escrow.getAddress();

      const tx = await escrow.connect(relayer).claimOrder(1, preimage);
      await expect(tx).to.not.emit(escrow, "PayoutDeferred");
      expect(await escrow.pendingWithdrawals(beneficiary.address)).to.equal(0);
      // Both legs left the contract: amount → beneficiary, deposit → relayer.
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0);
    });

    it("claim defers the amount when the beneficiary reverts on receive, then funds are recoverable", async () => {
      const [, , relayer] = await ethers.getSigners();
      const receiver = await deployReceiver();
      await receiver.setMode(MODE_REJECT);
      const recvAddr = await receiver.getAddress();
      const { escrow, preimage } = await setupOrder(recvAddr);
      const escrowAddr = await escrow.getAddress();

      // The claim succeeds (preimage revealed, order finalised) even though
      // the beneficiary cannot accept the push; the amount is deferred.
      await expect(escrow.connect(relayer).claimOrder(1, preimage))
        .to.emit(escrow, "PayoutDeferred")
        .withArgs(1, recvAddr, AMOUNT)
        .and.to.emit(escrow, "OrderClaimed");

      expect((await escrow.getOrder(1)).status).to.equal(1); // Claimed
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);
      // The safety deposit still reached the relayer EOA directly.
      expect(await escrow.pendingWithdrawals(relayer.address)).to.equal(0);
      // Only the deferred amount remains in the contract.
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(AMOUNT);

      // While the beneficiary legitimately rejects ETH, withdraw reverts and
      // the credited balance is preserved — nothing is lost.
      await expect(receiver.pull(escrowAddr)).to.be.revertedWithCustomError(
        escrow,
        "NativeTransferFailed"
      );
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);

      // Once the beneficiary can accept ETH, it pulls the funds.
      await receiver.setMode(MODE_ACCEPT);
      await expect(receiver.pull(escrowAddr))
        .to.emit(escrow, "Withdrawn")
        .withArgs(recvAddr, AMOUNT);
      expect(await ethers.provider.getBalance(recvAddr)).to.equal(AMOUNT);
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(0);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0);
    });

    it("claim defers when the receive hook exceeds the gas stipend, then withdraw (full gas) succeeds", async () => {
      const [, , relayer] = await ethers.getSigners();
      const receiver = await deployReceiver();
      await receiver.setMode(MODE_GUZZLE);
      const recvAddr = await receiver.getAddress();
      const { escrow, preimage } = await setupOrder(recvAddr);
      const escrowAddr = await escrow.getAddress();

      await expect(escrow.connect(relayer).claimOrder(1, preimage))
        .to.emit(escrow, "PayoutDeferred")
        .withArgs(1, recvAddr, AMOUNT);
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);

      // withdraw forwards all remaining gas, so the heavy receive completes.
      await receiver.pull(escrowAddr);
      expect(await ethers.provider.getBalance(recvAddr)).to.equal(AMOUNT);
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(0);
    });

    it("refund defers when the refund address reverts on receive, then funds are recoverable", async () => {
      const [sender, , cleaner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const receiver = await deployReceiver();
      await receiver.setMode(MODE_REJECT);
      const recvAddr = await receiver.getAddress();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      // refundAddress is the reverting contract.
      await escrow.connect(sender).createOrder(
        sender.address,
        recvAddr,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );
      await time.increase(TIMELOCK + 1);

      await expect(escrow.connect(cleaner).refundOrder(1))
        .to.emit(escrow, "PayoutDeferred")
        .withArgs(1, recvAddr, AMOUNT)
        .and.to.emit(escrow, "OrderRefunded");

      expect((await escrow.getOrder(1)).status).to.equal(2); // Refunded
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);

      await receiver.setMode(MODE_ACCEPT);
      await receiver.pull(await escrow.getAddress());
      expect(await ethers.provider.getBalance(recvAddr)).to.equal(AMOUNT);
    });

    it("a beneficiary that can never accept ETH keeps the amount safely credited (nothing lost)", async () => {
      const [, , relayer] = await ethers.getSigners();
      const receiver = await deployNoFallbackReceiver();
      const recvAddr = await receiver.getAddress();
      const { escrow, preimage } = await setupOrder(recvAddr);
      const escrowAddr = await escrow.getAddress();

      await escrow.connect(relayer).claimOrder(1, preimage); // succeeds via deferral
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);

      // The contract legitimately rejects the payment: withdraw reverts and
      // the funds stay credited and held by the escrow.
      await expect(receiver.pull(escrowAddr)).to.be.revertedWithCustomError(
        escrow,
        "NativeTransferFailed"
      );
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(AMOUNT);
    });
  });
});
