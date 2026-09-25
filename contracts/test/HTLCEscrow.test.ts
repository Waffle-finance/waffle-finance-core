import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HTLCEscrow, TestERC20 } from "../typechain-types";

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
      expect(await escrow.nextOrderId()).to.equal(1n);
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

    it("reverts with InsufficientAllowance when the ERC20 approval is too small", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();
      const hashlock = ethers.sha256(randomBytes32());

      // Approve less than the order amount.
      const approved = AMOUNT - 1n;
      await token.connect(sender).approve(await escrow.getAddress(), approved);

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          await token.getAddress(),
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      )
        .to.be.revertedWithCustomError(escrow, "InsufficientAllowance")
        .withArgs(approved, AMOUNT);
    });

    it("reverts with InsufficientAllowance when there is no approval at all", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          await token.getAddress(),
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      )
        .to.be.revertedWithCustomError(escrow, "InsufficientAllowance")
        .withArgs(0, AMOUNT);
    });

    it("reverts with InsufficientBalance when allowance is sufficient but balance is not", async () => {
      const [, beneficiary, poorSigner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();
      const hashlock = ethers.sha256(randomBytes32());

      // poorSigner holds no tokens but still approves the escrow: allowance
      // passes, the balance check is what trips.
      await token.connect(poorSigner).approve(await escrow.getAddress(), AMOUNT);
      expect(await token.balanceOf(poorSigner.address)).to.equal(0);

      await expect(
        escrow.connect(poorSigner).createOrder(
          beneficiary.address,
          poorSigner.address,
          await token.getAddress(),
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      )
        .to.be.revertedWithCustomError(escrow, "InsufficientBalance")
        .withArgs(0, AMOUNT);
    });

    it("reverts with InvalidToken when the token address is not a contract", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const hashlock = ethers.sha256(randomBytes32());
      // An EOA address has no contract code.
      const notAToken = ethers.Wallet.createRandom().address;

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          notAToken,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidToken");
    });

    it("reverts with InvalidValue when msg.value != safetyDeposit for an ERC20 order", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();
      const hashlock = ethers.sha256(randomBytes32());

      await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          await token.getAddress(),
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: SAFETY_DEPOSIT + 1n } // wrong: ERC20 deposit must be exact
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidValue");
    });

    it("rejects MIN_TIMELOCK - 1 with InvalidTimelock and accepts MIN_TIMELOCK exactly", async () => {
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
          300,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.not.be.reverted;
    });

    it("rejects MAX_TIMELOCK + 1 and leaves escrow balance and order count unchanged", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const escrowAddr = await escrow.getAddress();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          ethers.sha256(randomBytes32()),
          24 * 60 * 60 + 1,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidTimelock");
      expect(await escrow.nextOrderId()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
    });

    it("rejects zero beneficiary address before any state change", async () => {
      const [sender] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const escrowAddr = await escrow.getAddress();
      await expect(
        escrow.connect(sender).createOrder(
          ZERO_ADDR,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          randomBytes32(),
          TIMELOCK,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
      expect(await escrow.nextOrderId()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
    });

    it("rejects zero refundAddress before any state change", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const escrowAddr = await escrow.getAddress();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          ZERO_ADDR,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          randomBytes32(),
          TIMELOCK,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
      expect(await escrow.nextOrderId()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
    });

    it("reverts before any state change when amount and safetyDeposit sum overflows uint256", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const escrowAddr = await escrow.getAddress();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          ethers.MaxUint256,
          1n,
          hashlock,
          TIMELOCK,
          { value: 0n }
        )
      ).to.be.revertedWithPanic(0x11);

      expect(await escrow.nextOrderId()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
    });

    it("propagates registry revert and leaves no partial order state", async () => {
      const [sender, beneficiary] = await ethers.getSigners();

      const MockRegistry = await ethers.getContractFactory("MockRegistry");
      const mockReg = await MockRegistry.deploy(true);

      const HTLCEscrowFactory = await ethers.getContractFactory("HTLCEscrow");
      const escrow = (await HTLCEscrowFactory.deploy(
        await mockReg.getAddress(),
        0
      )) as unknown as HTLCEscrow;
      const escrowAddr = await escrow.getAddress();

      // Force the registry to revert on any isActive() call.
      await mockReg.setShouldRevert(true);

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
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWith("MockRegistry: registry reverted");

      // No partial state: no order stored, no ETH trapped.
      expect(await escrow.nextOrderId()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
    });
  });

  describe("setResolverRegistry", () => {
    it("rejects the zero address — a zero registry would silently disable the sybil gate without an explicit deployment decision", async () => {
      const [owner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(owner).setResolverRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("accepts a non-zero registry and emits ResolverRegistryUpdated with correct old and new addresses", async () => {
      const [owner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const MockRegistry = await ethers.getContractFactory("MockRegistry");
      const reg1 = await MockRegistry.deploy();
      const reg1Addr = await reg1.getAddress();

      const previousRegistry = await escrow.resolverRegistry();

      await expect(escrow.connect(owner).setResolverRegistry(reg1Addr))
        .to.emit(escrow, "ResolverRegistryUpdated")
        .withArgs(previousRegistry, reg1Addr);

      expect(await escrow.resolverRegistry()).to.equal(reg1Addr);
    });

    it("can replace the registry a second time and preserves the old address as previousRegistry", async () => {
      const [owner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const MockRegistry = await ethers.getContractFactory("MockRegistry");
      const reg1 = await MockRegistry.deploy();
      const reg2 = await MockRegistry.deploy();
      const reg1Addr = await reg1.getAddress();
      const reg2Addr = await reg2.getAddress();

      await escrow.connect(owner).setResolverRegistry(reg1Addr);

      await expect(escrow.connect(owner).setResolverRegistry(reg2Addr))
        .to.emit(escrow, "ResolverRegistryUpdated")
        .withArgs(reg1Addr, reg2Addr);

      expect(await escrow.resolverRegistry()).to.equal(reg2Addr);
    });

    it("reverts when a non-owner calls setResolverRegistry", async () => {
      const [, nonOwner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const MockRegistry = await ethers.getContractFactory("MockRegistry");
      const reg = await MockRegistry.deploy();
      await expect(
        escrow.connect(nonOwner).setResolverRegistry(await reg.getAddress())
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
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
      const gas = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice ?? 0n);

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

    it("always pays the stored beneficiary regardless of who submits the claim", async () => {
      const [sender, beneficiary, refundSigner, stranger] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        refundSigner.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      const beneficiaryBefore = await ethers.provider.getBalance(beneficiary.address);
      const strangerBefore = await ethers.provider.getBalance(stranger.address);
      const refundSignerBefore = await ethers.provider.getBalance(refundSigner.address);

      const tx = await escrow.connect(stranger).claimOrder(1, preimage);
      const receipt = await tx.wait();
      const gas = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice ?? 0n);

      expect(await ethers.provider.getBalance(beneficiary.address)).to.equal(
        beneficiaryBefore + AMOUNT
      );
      expect(await ethers.provider.getBalance(stranger.address)).to.equal(
        strangerBefore + SAFETY_DEPOSIT - gas
      );
      expect(await ethers.provider.getBalance(refundSigner.address)).to.equal(refundSignerBefore);

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(1); // Claimed
    });

    it("rejects a claim submitted exactly at the order timelock", async () => {
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

      const order = await escrow.getOrder(1);
      await time.increaseTo(Number(order.timelock));

      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "Expired");

      expect((await escrow.getOrder(1)).status).to.equal(0); // Still Funded
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
      const gas = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice ?? 0n);

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
      // emergencyWithdraw and pause must not exist.
      // transferOwnership is intentionally present from Ownable2Step but
      // cannot move locked order funds.
      expect(escrowContract.emergencyWithdraw).to.be.undefined;
      expect(escrowContract.pause).to.be.undefined;
    });

    it("withdraw() rejects a zero-amount pull — no-op withdrawals are rejected consistently", async () => {
      // A caller whose pendingWithdrawals balance is exactly zero must receive
      // NoPendingWithdrawal.  This is the zero-amount withdrawal guard: no
      // state is mutated and no event is emitted for a no-op pull.
      const [, , stranger] = await ethers.getSigners();
      const escrow = await deployEscrow();
      expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
      await expect(
        escrow.connect(stranger).withdraw()
      ).to.be.revertedWithCustomError(escrow, "NoPendingWithdrawal");
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

  describe("claimOrder — digest mode differential", () => {
    async function createSingleOrder(
      escrow: HTLCEscrow,
      sender: any,
      beneficiary: any,
      hashlock: string
    ): Promise<void> {
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
    }

    it("keccak256 hashlock: rejects a wrong preimage", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.keccak256(preimage);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);

      const wrongPreimage = randomBytes32();
      await expect(
        escrow.connect(beneficiary).claimOrder(1, wrongPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
    });

    it("sha256 hashlock: stores preimageKeccak as keccak256 of the claimed preimage", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);
      await escrow.connect(beneficiary).claimOrder(1, preimage);

      const order = await escrow.getOrder(1);
      expect(order.preimageKeccak).to.equal(ethers.keccak256(preimage));
    });

    it("keccak256 hashlock: stores preimageKeccak as keccak256 of the claimed preimage", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.keccak256(preimage);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);
      await escrow.connect(beneficiary).claimOrder(1, preimage);

      const order = await escrow.getOrder(1);
      expect(order.preimageKeccak).to.equal(ethers.keccak256(preimage));
    });

    it("rejects an empty preimage before transferring any funds", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);

      const escrowAddr = await escrow.getAddress();
      const balanceBefore = await ethers.provider.getBalance(escrowAddr);

      await expect(
        escrow.connect(beneficiary).claimOrder(1, "0x")
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");

      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(balanceBefore);
      expect((await escrow.getOrder(1)).status).to.equal(0); // Still Funded
    });

    it("rejects a preimage that is not exactly 32 bytes", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);

      const shortPreimage = ethers.hexlify(ethers.randomBytes(16));
      await expect(
        escrow.connect(beneficiary).claimOrder(1, shortPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");

      const longPreimage = ethers.hexlify(ethers.randomBytes(64));
      await expect(
        escrow.connect(beneficiary).claimOrder(1, longPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
    });

    it("sha256 hashlock: passing keccak256(secret) as preimage is rejected", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const secret = randomBytes32();
      const hashlock = ethers.sha256(secret);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);

      // Neither sha256 nor keccak256 of keccak256(secret) equals sha256(secret).
      const wrongPreimage = ethers.keccak256(secret);
      await expect(
        escrow.connect(beneficiary).claimOrder(1, wrongPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
    });

    it("keccak256 hashlock: passing sha256(secret) as preimage is rejected", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const secret = randomBytes32();
      const hashlock = ethers.keccak256(secret);

      await createSingleOrder(escrow, sender, beneficiary, hashlock);

      // Neither sha256 nor keccak256 of sha256(secret) equals keccak256(secret).
      const wrongPreimage = ethers.sha256(secret);
      await expect(
        escrow.connect(beneficiary).claimOrder(1, wrongPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
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

    it("pushes directly to a recording receiver mock, which tallies the exact amount received", async () => {
      const [, , relayer] = await ethers.getSigners();
      const Recorder = await ethers.getContractFactory("RecordingReceiverMock");
      const recorder = await Recorder.deploy();
      const recorderAddr = await recorder.getAddress();
      const { escrow, preimage } = await setupOrder(recorderAddr);

      await expect(escrow.connect(relayer).claimOrder(1, preimage)).to.not.emit(
        escrow,
        "PayoutDeferred"
      );

      expect(await recorder.totalReceived()).to.equal(AMOUNT);
      expect(await escrow.pendingWithdrawals(recorderAddr)).to.equal(0);
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

    it("withdraw reverts atomically when the recipient reverts — accounting is intact and funds remain recoverable", async () => {
      // Issue #524: a reverting native recipient must not leave accounting
      // in an inconsistent state.  The withdraw() follows CEI order:
      //   1. Zeroes the credit (effect)
      //   2. Attempts the transfer (interaction)
      //   3. Restores the credit and reverts if the transfer fails
      // After the failed withdraw the full amount is still pending and a
      // subsequent attempt (once the receiver can accept ETH) succeeds.
      const [, , relayer] = await ethers.getSigners();
      const receiver = await deployReceiver();
      const recvAddr = await receiver.getAddress();

      // Fund the contract and trigger deferral via a rejecting recipient.
      await receiver.setMode(MODE_REJECT);
      const { escrow, preimage } = await setupOrder(recvAddr);
      const escrowAddr = await escrow.getAddress();
      await escrow.connect(relayer).claimOrder(1, preimage);

      // Sanity: amount is credited, not burned.
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(AMOUNT);

      // withdraw() reverts — receiver still rejects ETH.
      await expect(receiver.pull(escrowAddr)).to.be.revertedWithCustomError(
        escrow,
        "NativeTransferFailed"
      );

      // Accounting is atomically restored: credit and contract balance are unchanged.
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(AMOUNT);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(AMOUNT);

      // Once the receiver can accept ETH the funds are fully recoverable.
      await receiver.setMode(MODE_ACCEPT);
      await receiver.pull(escrowAddr);
      expect(await ethers.provider.getBalance(recvAddr)).to.equal(AMOUNT);
      expect(await escrow.pendingWithdrawals(recvAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(0n);
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

  // ---------------------------------------------------------------------------
  // Issue #519 — overlong preimage rejection
  // ---------------------------------------------------------------------------
  describe("claimOrder — overlong preimage (#519)", () => {
    it("rejects a 33-byte preimage with InvalidPreimage and leaves the order claimable", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32(); // valid 32-byte secret
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

      // A 33-byte value is distinct from any wrong 32-byte value: the length
      // check fires before the digest comparison, so it is rejected regardless
      // of what bytes it contains.
      const overlongPreimage = ethers.hexlify(ethers.randomBytes(33));
      await expect(
        escrow.connect(beneficiary).claimOrder(1, overlongPreimage)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");

      // Order must still be in Funded state — no funds were released.
      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(0); // Funded
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
        AMOUNT + SAFETY_DEPOSIT
      );

      // Confirm the order is still claimable with the correct preimage.
      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #520 — permissionless refund from unrelated caller
  // ---------------------------------------------------------------------------
  describe("refundOrder — permissionless from unrelated caller (#520)", () => {
    it("allows an unrelated account to trigger the refund after expiry", async () => {
      // signers[3] is unrelated: not the sender, beneficiary, or refundAddress.
      const [sender, beneficiary, , unrelated] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      // Use a fresh random address as the designated refund recipient so it is
      // clearly distinct from both `sender` and `unrelated`.
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

      await time.increase(TIMELOCK + 1);

      const refundBefore = await ethers.provider.getBalance(refundAddr);
      const unrelatedBefore = await ethers.provider.getBalance(unrelated.address);

      // The unrelated caller submits the refund — no caller restriction.
      const tx = await escrow.connect(unrelated).refundOrder(1);
      const receipt = await tx.wait();
      const gas = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice ?? 0n);

      // Principal goes to the designated refundAddress, not to the caller.
      expect(await ethers.provider.getBalance(refundAddr)).to.equal(
        refundBefore + AMOUNT
      );
      // Safety deposit is the caller's incentive.
      expect(
        await ethers.provider.getBalance(unrelated.address) + gas
      ).to.equal(unrelatedBefore + SAFETY_DEPOSIT);

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(2); // Refunded
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #521 — refund rejection one second before expiry
  // ---------------------------------------------------------------------------
  describe("refundOrder — rejected at timelock - 1 (#521)", () => {
    it("reverts with NotExpired when called exactly one second before the deadline", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      // Anchor the order creation to a deterministic timestamp so that
      // `timelock - 1` is meaningful.
      const createTx = await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );
      const createReceipt = await createTx.wait();
      const createBlock = await ethers.provider.getBlock(createReceipt!.blockNumber);
      const absoluteTimelock = createBlock!.timestamp + TIMELOCK;

      // Advance to exactly one second before the deadline.
      await time.setNextBlockTimestamp(absoluteTimelock - 1);
      await ethers.provider.send("evm_mine", []);

      await expect(
        escrow.connect(sender).refundOrder(1)
      ).to.be.revertedWithCustomError(escrow, "NotExpired");

      // Order and balances are unchanged after the failed refund attempt.
      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(0); // still Funded
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
        AMOUNT + SAFETY_DEPOSIT
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #522 — safety-deposit recipient verification on refund
  // ---------------------------------------------------------------------------
  describe("refundOrder — safety-deposit goes to refund caller, not refund address (#522)", () => {
    it("credits safety deposit to the caller and principal to refundAddress independently", async () => {
      // Three distinct roles: sender creates; refundAddr is the designated
      // recovery wallet; caller is whoever submits the refund transaction.
      const [sender, beneficiary, caller] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      // Fresh address with no prior balance — makes delta assertions unambiguous.
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

      await time.increase(TIMELOCK + 1);

      const refundAddrBefore = await ethers.provider.getBalance(refundAddr);
      const callerBefore = await ethers.provider.getBalance(caller.address);
      const beneficiaryBefore = await ethers.provider.getBalance(beneficiary.address);

      const tx = await escrow.connect(caller).refundOrder(1);
      const receipt = await tx.wait();
      const gas = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice ?? 0n);

      // Principal → refundAddress (not the caller, not the beneficiary).
      expect(await ethers.provider.getBalance(refundAddr)).to.equal(
        refundAddrBefore + AMOUNT
      );
      // Safety deposit → caller (whoever submitted the transaction).
      expect(
        await ethers.provider.getBalance(caller.address) + gas
      ).to.equal(callerBefore + SAFETY_DEPOSIT);
      // Beneficiary is completely unaffected.
      expect(await ethers.provider.getBalance(beneficiary.address)).to.equal(
        beneficiaryBefore
      );

      // Order is finalised exactly once.
      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(2); // Refunded
      expect(order.finalisedAt).to.be.greaterThan(0);
    });
  });
});
