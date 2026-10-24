
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
      // Consumer-facing OrderCreated fields used by the coordinator/relayer listener.
      expect(orderCreated.args.hashlock).to.equal(hashlock);
      expect(orderCreated.args.sender).to.equal(sender.address);
      expect(orderCreated.args.beneficiary).to.equal(beneficiary.address);
      expect(orderCreated.args.token).to.equal(ZERO_ADDR);
      expect(orderCreated.args.amount).to.equal(AMOUNT);
      expect(orderCreated.args.safetyDeposit).to.equal(SAFETY_DEPOSIT);
      expect(orderCreated.args.timelock).to.equal(TIMELOCK);

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

  // ---------------------------------------------------------------------------
  // Issue #862 — zero safety-deposit order creation
  // ---------------------------------------------------------------------------
  describe("createOrder — zero safety deposit (#862)", () => {
    it("accepts a zero safety deposit when minSafetyDeposit is zero (native ETH)", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow(); // deployed with minSafetyDeposit = 0
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      // With zero safety deposit, msg.value must equal amount exactly.
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          0, // zero safety deposit
          hashlock,
          TIMELOCK,
          { value: AMOUNT }
        )
      ).to.not.be.reverted;

      const order = await escrow.getOrder(1);
      expect(order.amount).to.equal(AMOUNT);
      expect(order.safetyDeposit).to.equal(0n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(AMOUNT);
    });

    it("accepts a zero safety deposit for an ERC20 order (msg.value = 0)", async () => {
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
          0, // zero safety deposit
          hashlock,
          TIMELOCK,
          { value: 0 } // no ETH needed: amount in token, deposit is zero
        )
      ).to.not.be.reverted;

      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("rejects a zero safety deposit when minSafetyDeposit > 0", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const HTLCEscrowFactory = await ethers.getContractFactory("HTLCEscrow");
      const escrow = (await HTLCEscrowFactory.deploy(
        ZERO_ADDR,
        ethers.parseEther("0.001") // non-zero minimum
      )) as unknown as HTLCEscrow;

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          0, // zero — below the non-zero minimum
          randomBytes32(),
          TIMELOCK,
          { value: AMOUNT }
        )
      ).to.be.revertedWithCustomError(escrow, "SafetyDepositTooSmall");

      // No order was created.
      expect(await escrow.nextOrderId()).to.equal(1n);
    });

    it("pays no safety-deposit incentive on claim when deposit is zero", async () => {
      const [sender, beneficiary, relayer] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        0, // zero safety deposit
        hashlock,
        TIMELOCK,
        { value: AMOUNT }
      );

      const beneficiaryBefore = await ethers.provider.getBalance(beneficiary.address);
      const relayerBefore = await ethers.provider.getBalance(relayer.address);

      await escrow.connect(relayer).claimOrder(1, preimage);

      // Beneficiary receives the full amount; relayer gets no deposit.
      expect(await ethers.provider.getBalance(beneficiary.address)).to.equal(
        beneficiaryBefore + AMOUNT
      );
      // Relayer only paid gas — no safety deposit credited.
      expect(await escrow.pendingWithdrawals(relayer.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("pays no safety-deposit incentive on refund when deposit is zero", async () => {
      const [sender, beneficiary, caller] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      const refundAddr = ethers.Wallet.createRandom().address;

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        refundAddr,
        ZERO_ADDR,
        AMOUNT,
        0, // zero safety deposit
        hashlock,
        TIMELOCK,
        { value: AMOUNT }
      );

      await time.increase(TIMELOCK + 1);

      const refundBefore = await ethers.provider.getBalance(refundAddr);

      await escrow.connect(caller).refundOrder(1);

      // Refund address receives principal; caller gets no deposit.
      expect(await ethers.provider.getBalance(refundAddr)).to.equal(
        refundBefore + AMOUNT
      );
      expect(await escrow.pendingWithdrawals(caller.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
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

  // ---------------------------------------------------------------------------
  // Issue #867 — zero-address constructor tests for escrow dependencies
  // ---------------------------------------------------------------------------
  describe("constructor — zero-address dependency guards (#867)", () => {
    // HTLCEscrow constructor:
    //   constructor(IResolverRegistry _resolverRegistry, uint256 _minSafetyDeposit)
    //
    // _resolverRegistry is intentionally optional (address(0) disables the sybil
    // gate and makes createOrder permissionless), so passing zero is accepted.
    // _minSafetyDeposit = 0 is also accepted (advisory only).
    //
    // ResolverRegistry constructor:
    //   constructor(IERC20 _stakeAsset, uint256 _minStake, address _slashBeneficiary, address _owner)
    //
    // All three address parameters are required to be non-zero; minStake must be > 0.

    it("HTLCEscrow: accepts address(0) as resolverRegistry — permissionless mode is intentional", async () => {
      const HTLCEscrowFactory = await ethers.getContractFactory("HTLCEscrow");
      // Should deploy without reverting; zero registry is the documented way to
      // make createOrder permissionless.
      const escrow = await HTLCEscrowFactory.deploy(ZERO_ADDR, 0);
      expect(await escrow.resolverRegistry()).to.equal(ZERO_ADDR);
    });

    it("ResolverRegistry: reverts with InvalidAddress when stakeAsset is zero", async () => {
      const [owner] = await ethers.getSigners();
      const RegistryFactory = await ethers.getContractFactory("ResolverRegistry");
      await expect(
        RegistryFactory.deploy(
          ZERO_ADDR,           // _stakeAsset — required non-zero
          ethers.parseEther("1"),
          owner.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(
        await RegistryFactory.deploy(
          await deployToken().then((t) => t.getAddress()),
          ethers.parseEther("1"),
          owner.address,
          owner.address
        ),
        "InvalidAddress"
      );
    });

    it("ResolverRegistry: reverts with InvalidAddress when slashBeneficiary is zero", async () => {
      const [owner] = await ethers.getSigners();
      const token = await deployToken();
      const RegistryFactory = await ethers.getContractFactory("ResolverRegistry");
      const stub = await RegistryFactory.deploy(
        await token.getAddress(),
        ethers.parseEther("1"),
        owner.address,
        owner.address
      );
      await expect(
        RegistryFactory.deploy(
          await token.getAddress(),
          ethers.parseEther("1"),
          ZERO_ADDR,           // _slashBeneficiary — required non-zero
          owner.address
        )
      ).to.be.revertedWithCustomError(stub, "InvalidAddress");
    });

    it("ResolverRegistry: reverts when owner is zero — OpenZeppelin Ownable guard fires first", async () => {
      // OpenZeppelin's Ownable constructor checks for address(0) before
      // our InvalidAddress guard, so the revert reason is OwnableInvalidOwner.
      // Both guards protect against the same misconfiguration; the OZ check
      // simply fires first in the constructor execution order.
      const [owner] = await ethers.getSigners();
      const token = await deployToken();
      const RegistryFactory = await ethers.getContractFactory("ResolverRegistry");
      const stub = await RegistryFactory.deploy(
        await token.getAddress(),
        ethers.parseEther("1"),
        owner.address,
        owner.address
      );
      await expect(
        RegistryFactory.deploy(
          await token.getAddress(),
          ethers.parseEther("1"),
          owner.address,
          ZERO_ADDR            // _owner — protected by OZ Ownable before InvalidAddress
        )
      ).to.be.revertedWithCustomError(stub, "OwnableInvalidOwner");
    });

    it("ResolverRegistry: reverts with InvalidAmount when minStake is zero", async () => {
      const [owner] = await ethers.getSigners();
      const token = await deployToken();
      const RegistryFactory = await ethers.getContractFactory("ResolverRegistry");
      const stub = await RegistryFactory.deploy(
        await token.getAddress(),
        ethers.parseEther("1"),
        owner.address,
        owner.address
      );
      await expect(
        RegistryFactory.deploy(
          await token.getAddress(),
          0,                   // _minStake — must be > 0
          owner.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(stub, "InvalidAmount");
    });

    it("ResolverRegistry: deploys successfully when all required addresses are valid and minStake > 0", async () => {
      const [owner] = await ethers.getSigners();
      const token = await deployToken();
      const RegistryFactory = await ethers.getContractFactory("ResolverRegistry");
      const registry = await RegistryFactory.deploy(
        await token.getAddress(),
        ethers.parseEther("1"),
        owner.address,
        owner.address
      );
      expect(await registry.stakeAsset()).to.equal(await token.getAddress());
      expect(await registry.slashBeneficiary()).to.equal(owner.address);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #869 — duplicate claim/refund attempt tests
  // ---------------------------------------------------------------------------
  describe("duplicate finalization attempts (#869)", () => {
    // Helper: create a funded native-ETH order and return its id along with
    // the escrow instance, preimage, and signers.
    async function setupFundedOrder() {
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
      return { escrow, preimage, sender, beneficiary, relayer, orderId: 1n };
    }

    it("second claimOrder on the same order reverts with OrderNotClaimable, no funds move", async () => {
      const { escrow, preimage, beneficiary, orderId } = await setupFundedOrder();
      const escrowAddr = await escrow.getAddress();

      // First claim succeeds.
      await escrow.connect(beneficiary).claimOrder(orderId, preimage);
      expect((await escrow.getOrder(orderId)).status).to.equal(1); // Claimed

      const balanceBefore = await ethers.provider.getBalance(escrowAddr);

      // Second claim must revert.
      await expect(
        escrow.connect(beneficiary).claimOrder(orderId, preimage)
      ).to.be.revertedWithCustomError(escrow, "OrderNotClaimable");

      // No funds left the contract on the duplicate attempt (balance unchanged).
      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(balanceBefore);

      // Only one OrderClaimed event was ever emitted for this order id.
      const filter = escrow.filters.OrderClaimed(orderId);
      const events = await escrow.queryFilter(filter);
      expect(events.length).to.equal(1);
    });

    it("refundOrder after a successful claim reverts with OrderNotRefundable, no funds move", async () => {
      const { escrow, preimage, beneficiary, sender, orderId } = await setupFundedOrder();
      const escrowAddr = await escrow.getAddress();

      // Claim the order first.
      await escrow.connect(beneficiary).claimOrder(orderId, preimage);
      expect((await escrow.getOrder(orderId)).status).to.equal(1); // Claimed

      // Advance time past the timelock so a refund would otherwise be valid.
      await time.increase(TIMELOCK + 1);

      const balanceBefore = await ethers.provider.getBalance(escrowAddr);

      // Refund after claim must revert.
      await expect(
        escrow.connect(sender).refundOrder(orderId)
      ).to.be.revertedWithCustomError(escrow, "OrderNotRefundable");

      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(balanceBefore);

      // No OrderRefunded event was emitted.
      const filter = escrow.filters.OrderRefunded(orderId);
      const events = await escrow.queryFilter(filter);
      expect(events.length).to.equal(0);
    });

    it("second refundOrder on the same order reverts with OrderNotRefundable, no funds move", async () => {
      const { escrow, sender, orderId } = await setupFundedOrder();
      const escrowAddr = await escrow.getAddress();

      // Advance past expiry and execute the first refund.
      await time.increase(TIMELOCK + 1);
      await escrow.connect(sender).refundOrder(orderId);
      expect((await escrow.getOrder(orderId)).status).to.equal(2); // Refunded

      const balanceBefore = await ethers.provider.getBalance(escrowAddr);

      // Second refund attempt must revert.
      await expect(
        escrow.connect(sender).refundOrder(orderId)
      ).to.be.revertedWithCustomError(escrow, "OrderNotRefundable");

      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(balanceBefore);

      // Exactly one OrderRefunded event for this order.
      const filter = escrow.filters.OrderRefunded(orderId);
      const events = await escrow.queryFilter(filter);
      expect(events.length).to.equal(1);
    });

    it("claimOrder after a successful refund reverts with OrderNotClaimable, no funds move", async () => {
      const { escrow, preimage, sender, beneficiary, orderId } = await setupFundedOrder();
      const escrowAddr = await escrow.getAddress();

      // Refund the order first.
      await time.increase(TIMELOCK + 1);
      await escrow.connect(sender).refundOrder(orderId);
      expect((await escrow.getOrder(orderId)).status).to.equal(2); // Refunded

      const balanceBefore = await ethers.provider.getBalance(escrowAddr);

      // Claim after refund must revert — even with a valid preimage.
      await expect(
        escrow.connect(beneficiary).claimOrder(orderId, preimage)
      ).to.be.revertedWithCustomError(escrow, "OrderNotClaimable");

      expect(await ethers.provider.getBalance(escrowAddr)).to.equal(balanceBefore);

      // No OrderClaimed event was emitted.
      const filter = escrow.filters.OrderClaimed(orderId);
      const events = await escrow.queryFilter(filter);
      expect(events.length).to.equal(0);
    });

    it("finalisedAt is set exactly once and is not overwritten by a duplicate attempt", async () => {
      const { escrow, preimage, beneficiary, sender, orderId } = await setupFundedOrder();

      // Claim the order.
      await escrow.connect(beneficiary).claimOrder(orderId, preimage);
      const finalisedAt = (await escrow.getOrder(orderId)).finalisedAt;
      expect(finalisedAt).to.be.greaterThan(0n);

      // Advance past expiry so a refund would conceptually be eligible.
      await time.increase(TIMELOCK + 1);

      // Duplicate refund attempt should revert.
      await expect(
        escrow.connect(sender).refundOrder(orderId)
      ).to.be.revertedWithCustomError(escrow, "OrderNotRefundable");

      // finalisedAt is unchanged.
      expect((await escrow.getOrder(orderId)).finalisedAt).to.equal(finalisedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #870 — ERC20 transfer return variant regression cases
  // ---------------------------------------------------------------------------
  describe("ERC20 transfer return variants (#870)", () => {
    // SafeERC20 handles three ERC20 return patterns:
    //   - Returns true   → accepted (standard ERC20)
    //   - Returns nothing → accepted (USDT-style void transfer)
    //   - Returns false  → rejected (SafeERC20 treats false as revert)
    //
    // These tests verify that the escrow's safeTransferFrom / safeTransfer
    // path behaves correctly for each variant.

    const TOKEN_SUPPLY = ethers.parseEther("1000000");

    async function deployReturnsTrueToken() {
      const F = await ethers.getContractFactory("ReturnsTrueERC20");
      return F.deploy(TOKEN_SUPPLY) as Promise<ReturnsTrueERC20>;
    }

    async function deployNoReturnToken() {
      const F = await ethers.getContractFactory("NoReturnERC20");
      return F.deploy(TOKEN_SUPPLY) as Promise<NoReturnERC20>;
    }

    async function deployReturnsFalseToken() {
      const F = await ethers.getContractFactory("ReturnsFalseERC20");
      return F.deploy(TOKEN_SUPPLY) as Promise<ReturnsFalseERC20>;
    }

    // ── createOrder (safeTransferFrom) ───────────────────────────────────────

    it("standard (returns true): createOrder locks tokens successfully", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployReturnsTrueToken();
      const escrowAddr = await escrow.getAddress();

      await token.connect(sender).approve(escrowAddr, AMOUNT);
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
      ).to.not.be.reverted;

      expect(await token.balanceOf(escrowAddr)).to.equal(AMOUNT);
    });

    it("no-return (void transfer): createOrder locks tokens successfully", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployNoReturnToken();
      const escrowAddr = await escrow.getAddress();

      await token.connect(sender).approve(escrowAddr, AMOUNT);
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
      ).to.not.be.reverted;

      expect(await token.balanceOf(escrowAddr)).to.equal(AMOUNT);
    });

    it("false-return: createOrder reverts — SafeERC20 rejects a false transferFrom", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployReturnsFalseToken();
      const escrowAddr = await escrow.getAddress();

      // Even with a generous approval, ReturnsFalseERC20.transferFrom always
      // returns false; SafeERC20 must surface this as a revert so the order
      // is never created.
      await token.connect(sender).approve(escrowAddr, AMOUNT);
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
      ).to.be.reverted; // SafeERC20 reverts on false return

      // No order was stored.
      expect(await escrow.nextOrderId()).to.equal(1n);
    });

    // ── claimOrder (safeTransfer) ────────────────────────────────────────────

    it("standard (returns true): claimOrder transfers tokens to beneficiary", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployReturnsTrueToken();
      const escrowAddr = await escrow.getAddress();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await token.connect(sender).approve(escrowAddr, AMOUNT);
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

      const beneficiaryBefore = await token.balanceOf(beneficiary.address);
      await escrow.connect(beneficiary).claimOrder(1, preimage);

      expect(await token.balanceOf(beneficiary.address)).to.equal(
        beneficiaryBefore + AMOUNT
      );
      expect(await token.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("no-return (void transfer): claimOrder transfers tokens to beneficiary", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployNoReturnToken();
      const escrowAddr = await escrow.getAddress();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await token.connect(sender).approve(escrowAddr, AMOUNT);
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

      const beneficiaryBefore = await token.balanceOf(beneficiary.address);
      await escrow.connect(beneficiary).claimOrder(1, preimage);

      expect(await token.balanceOf(beneficiary.address)).to.equal(
        beneficiaryBefore + AMOUNT
      );
      expect(await token.balanceOf(escrowAddr)).to.equal(0n);
    });
  });
});
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
