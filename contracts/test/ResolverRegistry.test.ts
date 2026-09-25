import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ResolverRegistry, TestERC20 } from "../typechain-types";

//  Helpers 

const MIN_STAKE = ethers.parseEther("100");

async function deploy() {
  const [owner, beneficiary] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("TestERC20");
  const token = (await Token.deploy(
    "Stake",
    "STK",
    ethers.parseEther("1000000")
  )) as unknown as TestERC20;

  const Registry = await ethers.getContractFactory("ResolverRegistry");
  const registry = (await Registry.deploy(
    await token.getAddress(),
    MIN_STAKE,
    beneficiary.address,
    owner.address
  )) as unknown as ResolverRegistry;

  return { owner, beneficiary, token, registry };
}

/** Fund an account with tokens and approve the registry to spend them. */
async function fundAndApprove(
  token: TestERC20,
  registry: ResolverRegistry,
  signer: HardhatEthersSigner,
  amount: bigint
) {
  await token.transfer(signer.address, amount);
  await token.connect(signer).approve(await registry.getAddress(), amount);
}

/**
 * Verify the two core storage invariants from the contract NatSpec:
 *   I1: _resolverIndex[a] == 0 iff a is NOT in list()
 *   I2: list()[ index - 1 ] == a  for every registered address a
 *   I5: list().length == getResolverCount()
 *
 * Because _resolverIndex is private we derive the invariants from the
 * public views (list, isActive, get, getResolverCount).
 */
async function assertInvariants(
  registry: ResolverRegistry,
  expectedAddresses: string[]
) {
  const listed = await registry.list();
  const count  = await registry.getResolverCount();

  // I5
  expect(listed.length).to.equal(Number(count), "list().length != getResolverCount()");
  expect(listed.length).to.equal(
    expectedAddresses.length,
    "list length does not match expectation"
  );

  // Every expected address must appear exactly once in the list.
  const listedSet = new Set(listed.map((a: string) => a.toLowerCase()));
  for (const addr of expectedAddresses) {
    expect(listedSet.has(addr.toLowerCase())).to.be.true;
  }

  // No address outside expectedAddresses should appear.
  const expectedSet = new Set(expectedAddresses.map((a) => a.toLowerCase()));
  for (const addr of listed) {
    expect(expectedSet.has(addr.toLowerCase())).to.be.true;
  }
}

//  Test suite 

describe("ResolverRegistry", () => {

  //  register 

  describe("register", () => {
    it("registers a resolver with the exact minimum stake", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);

      await expect(registry.connect(resolver).register(MIN_STAKE))
        .to.emit(registry, "Registered")
        .withArgs(resolver.address, MIN_STAKE);

      expect(await registry.isActive(resolver.address)).to.be.true;
      await assertInvariants(registry, [resolver.address]);
    });

    it("registers with stake above the minimum", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      const bigStake = MIN_STAKE * 5n;
      await fundAndApprove(token, registry, resolver, bigStake);

      await registry.connect(resolver).register(bigStake);

      const info = await registry.get(resolver.address);
      expect(info.stake).to.equal(bigStake);
      expect(info.active).to.be.true;
    });

    it("rejects stake strictly below minimum", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      const tooSmall = MIN_STAKE - 1n;
      await fundAndApprove(token, registry, resolver, tooSmall);

      await expect(
        registry.connect(resolver).register(tooSmall)
      ).to.be.revertedWithCustomError(registry, "StakeBelowMinimum");

      // No side effects.
      await assertInvariants(registry, []);
    });

    it("rejects duplicate registration for the same address", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);

      await registry.connect(resolver).register(MIN_STAKE);

      await expect(
        registry.connect(resolver).register(MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

      // Still exactly one entry.
      await assertInvariants(registry, [resolver.address]);
    });

    it("rejects registration from the zero address with no stake movement or list entry", async () => {
      const { token, registry } = await deploy();

      await ethers.provider.send("hardhat_impersonateAccount", [ethers.ZeroAddress]);
      await ethers.provider.send("hardhat_setBalance", [
        ethers.ZeroAddress,
        ethers.toBeHex(ethers.parseEther("1")),
      ]);
      const zeroSigner = await ethers.getImpersonatedSigner(ethers.ZeroAddress);

      // Guard fires before any token interaction.
      await expect(
        registry.connect(zeroSigner).register(MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");

      // No side effects: list is empty, count is zero.
      await assertInvariants(registry, []);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [ethers.ZeroAddress]);
    });

    it("duplicate registration reverts with AlreadyRegistered and leaves stake, list length, and index unchanged", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);

      await registry.connect(resolver).register(MIN_STAKE);

      // Snapshot state before the attempted duplicate.
      const registryBalanceBefore = await token.balanceOf(await registry.getAddress());
      const listLengthBefore = await registry.getResolverCount();
      const infoBefore = await registry.get(resolver.address);

      await expect(
        registry.connect(resolver).register(MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

      // Stake must be unchanged — no second token pull.
      expect(await token.balanceOf(await registry.getAddress())).to.equal(registryBalanceBefore);

      // List length must be unchanged — no duplicate entry.
      expect(await registry.getResolverCount()).to.equal(listLengthBefore);

      // Resolver info must be unchanged.
      const infoAfter = await registry.get(resolver.address);
      expect(infoAfter.stake).to.equal(infoBefore.stake);
      expect(infoAfter.active).to.equal(infoBefore.active);

      // Index is valid: the resolver can still be unregistered correctly.
      await registry.connect(resolver).unregister();
      await assertInvariants(registry, []);
    });

    it("allows re-registration after a clean unregister", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);

      await registry.connect(resolver).register(MIN_STAKE);
      await registry.connect(resolver).unregister();

      // After unregister the slot is clean  re-registration must succeed.
      await token.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
      await expect(registry.connect(resolver).register(MIN_STAKE))
        .to.emit(registry, "Registered");

      expect(await registry.isActive(resolver.address)).to.be.true;
      await assertInvariants(registry, [resolver.address]);
    });

    it("populates resolver.registeredAt with the current block timestamp", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);

      const tx = await registry.connect(resolver).register(MIN_STAKE);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const info = await registry.get(resolver.address);
      expect(info.registeredAt).to.equal(BigInt(block!.timestamp));
    });
  });

  //  increaseStake 

  describe("increaseStake", () => {
    it("increases stake and emits StakeIncreased", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);

      await registry.connect(resolver).register(MIN_STAKE);
      await expect(registry.connect(resolver).increaseStake(MIN_STAKE))
        .to.emit(registry, "StakeIncreased")
        .withArgs(resolver.address, MIN_STAKE, MIN_STAKE * 2n);

      const info = await registry.get(resolver.address);
      expect(info.stake).to.equal(MIN_STAKE * 2n);
    });

    it("rejects zero additional amount and leaves stake and token balances unchanged", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      const stakeBefore = (await registry.get(resolver.address)).stake;
      const resolverBalanceBefore = await token.balanceOf(resolver.address);
      const registryBalanceBefore = await token.balanceOf(await registry.getAddress());

      await expect(
        registry.connect(resolver).increaseStake(0n)
      ).to.be.revertedWithCustomError(registry, "InvalidAmount");

      expect((await registry.get(resolver.address)).stake).to.equal(stakeBefore);
      expect(await token.balanceOf(resolver.address)).to.equal(resolverBalanceBefore);
      expect(await token.balanceOf(await registry.getAddress())).to.equal(registryBalanceBefore);
    });

    it("rejects call from an unregistered address", async () => {
      const [, , , , stranger] = await ethers.getSigners();
      const { registry } = await deploy();

      await expect(
        registry.connect(stranger).increaseStake(MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("reactivates a slashed-below-minimum resolver once stake is topped up", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { owner, token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);

      // Register, then slash to push stake below minimum.
      await registry.connect(resolver).register(MIN_STAKE * 2n);
      await registry.slash(resolver.address, MIN_STAKE + 1n);
      expect(await registry.isActive(resolver.address)).to.be.false;

      // Resolver tops up just enough to exceed minimum again.
      await registry.connect(resolver).increaseStake(2n);
      expect(await registry.isActive(resolver.address)).to.be.true;
      await assertInvariants(registry, [resolver.address]);
    });
  });

  //  unregister 

  describe("unregister", () => {
    it("returns the full stake and removes the resolver", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);

      await registry.connect(resolver).register(MIN_STAKE);
      const before = await token.balanceOf(resolver.address);

      await expect(registry.connect(resolver).unregister())
        .to.emit(registry, "Unregistered")
        .withArgs(resolver.address, MIN_STAKE);

      expect(await token.balanceOf(resolver.address)).to.equal(before + MIN_STAKE);
      expect(await registry.isActive(resolver.address)).to.be.false;
      await assertInvariants(registry, []);
    });

    it("returns accumulated stake (initial + increaseStake) on unregister", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);

      await registry.connect(resolver).register(MIN_STAKE);
      await registry.connect(resolver).increaseStake(MIN_STAKE);

      const before = await token.balanceOf(resolver.address);
      await registry.connect(resolver).unregister();
      expect(await token.balanceOf(resolver.address)).to.equal(before + MIN_STAKE * 2n);
    });

    it("rejects unregister from an address not registered", async () => {
      const [, , , , stranger] = await ethers.getSigners();
      const { registry } = await deploy();

      await expect(
        registry.connect(stranger).unregister()
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("clears ResolverInfo entirely after unregister (invariant I4)", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);

      await registry.connect(resolver).register(MIN_STAKE);
      await registry.connect(resolver).unregister();

      const info = await registry.get(resolver.address);
      // All fields must be zero/false (default ResolverInfo).
      expect(info.stake).to.equal(0n);
      expect(info.active).to.be.false;
      expect(info.resolver).to.equal(ethers.ZeroAddress);
    });

    //  list/index consistency after removing the ONLY resolver 

    it("list is empty and count is 0 after the sole resolver unregisters", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);

      await registry.connect(resolver).register(MIN_STAKE);
      await registry.connect(resolver).unregister();

      await assertInvariants(registry, []);
      expect(await registry.getResolverCount()).to.equal(0n);
    });

    //  unregistering the LAST resolver in a multi-resolver list 

    it("list/index consistent after removing the last-added resolver (multi)", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }
      await assertInvariants(registry, [r1.address, r2.address, r3.address]);

      // r3 is the last-added  its removal is a simple pop, no swap needed.
      await registry.connect(r3).unregister();
      await assertInvariants(registry, [r1.address, r2.address]);
    });

    //  unregistering a MIDDLE resolver (swap-and-pop path) 

    it("list/index consistent after removing a middle resolver (swap-and-pop)", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }

      // Remove the middle element  r3 gets swapped into r2's slot.
      await registry.connect(r2).unregister();
      await assertInvariants(registry, [r1.address, r3.address]);

      // r3 must still be active and queryable after being swapped.
      expect(await registry.isActive(r3.address)).to.be.true;
    });

    //  unregistering the FIRST resolver 

    it("list/index consistent after removing the first resolver (swap-and-pop)", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }

      // Remove first resolver  last (r3) swaps into slot 0.
      await registry.connect(r1).unregister();
      await assertInvariants(registry, [r2.address, r3.address]);

      expect(await registry.isActive(r1.address)).to.be.false;
      expect(await registry.isActive(r2.address)).to.be.true;
      expect(await registry.isActive(r3.address)).to.be.true;
    });

    //  middle removal index synchronization

    it("middle removal: moved resolver index is updated and can be subsequently unregistered", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }
      await assertInvariants(registry, [r1.address, r2.address, r3.address]);

      // Remove the middle resolver; r3 is swapped into r2's slot.
      await registry.connect(r2).unregister();

      // Remaining list: exactly r1 and r3, no duplicates, no missing entries.
      await assertInvariants(registry, [r1.address, r3.address]);

      // Prove r3's index was updated: a subsequent unregister must succeed and
      // remove only r3, leaving r1 intact. A stale index would target the wrong
      // slot and either panic or corrupt the list.
      await registry.connect(r3).unregister();
      await assertInvariants(registry, [r1.address]);

      expect(await registry.isActive(r1.address)).to.be.true;
      expect(await registry.getResolverCount()).to.equal(1n);
    });

    //  sequential unregisters

    it("list stays consistent through multiple sequential unregisters", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3, r4] = signers;
      const { token, registry } = await deploy();
      const resolvers = [r1, r2, r3, r4];

      for (const r of resolvers) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }
      await assertInvariants(registry, resolvers.map((r) => r.address));

      await registry.connect(r2).unregister();
      await assertInvariants(registry, [r1.address, r3.address, r4.address]);

      await registry.connect(r4).unregister();
      await assertInvariants(registry, [r1.address, r3.address]);

      await registry.connect(r1).unregister();
      await assertInvariants(registry, [r3.address]);

      await registry.connect(r3).unregister();
      await assertInvariants(registry, []);
    });
  });

  //  slash 

  describe("slash", () => {
    it("routes slashed tokens to slashBeneficiary", async () => {
      const [, beneficiary, , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      const benBefore = await token.balanceOf(beneficiary.address);
      await registry.slash(resolver.address, MIN_STAKE);
      expect(await token.balanceOf(beneficiary.address)).to.equal(
        benBefore + MIN_STAKE
      );
    });

    it("deactivates resolver when stake drops below minimum", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      await registry.slash(resolver.address, MIN_STAKE + 1n);
      expect(await registry.isActive(resolver.address)).to.be.false;

      // Resolver is still in the list (slash does NOT remove from list).
      await assertInvariants(registry, [resolver.address]);
    });

    it("does NOT remove the resolver from the list on slash (only deactivates)", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2]) {
        await fundAndApprove(token, registry, r, MIN_STAKE * 2n);
        await registry.connect(r).register(MIN_STAKE * 2n);
      }

      await registry.slash(r1.address, MIN_STAKE * 2n); // wipe entire stake
      // r1 must still appear in list() even with zero stake.
      await assertInvariants(registry, [r1.address, r2.address]);
      expect(await registry.isActive(r1.address)).to.be.false;
    });

    it("rejects slash amount larger than the resolver's current stake with no state mutation", async () => {
      const [, beneficiary, , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      const beneficiaryBalanceBefore = await token.balanceOf(beneficiary.address);

      await expect(
        registry.slash(resolver.address, MIN_STAKE + 1n)
      ).to.be.revertedWithCustomError(registry, "InvalidAmount");

      expect(await token.balanceOf(beneficiary.address)).to.equal(beneficiaryBalanceBefore);
      const info = await registry.get(resolver.address);
      expect(info.stake).to.equal(MIN_STAKE);
      expect(info.active).to.be.true;
      await assertInvariants(registry, [resolver.address]);
    });

    it("accumulates totalSlashed across multiple slashes", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 4n);
      await registry.connect(resolver).register(MIN_STAKE * 4n);

      await registry.slash(resolver.address, MIN_STAKE);
      await registry.slash(resolver.address, MIN_STAKE);

      const info = await registry.get(resolver.address);
      expect(info.totalSlashed).to.equal(MIN_STAKE * 2n);
      expect(info.stake).to.equal(MIN_STAKE * 2n);
    });

    it("rejects slash on an unregistered address", async () => {
      const [, , , , stranger] = await ethers.getSigners();
      const { registry } = await deploy();

      await expect(
        registry.slash(stranger.address, MIN_STAKE)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("rejects slash with zero amount and leaves stake, status, and beneficiary balance unchanged", async () => {
      const [, beneficiary, , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      const stakeBefore = (await registry.get(resolver.address)).stake;
      const activeBefore = (await registry.get(resolver.address)).active;
      const beneficiaryBalanceBefore = await token.balanceOf(beneficiary.address);

      await expect(
        registry.slash(resolver.address, 0n)
      ).to.be.revertedWithCustomError(registry, "InvalidAmount");

      const infoAfter = await registry.get(resolver.address);
      expect(infoAfter.stake).to.equal(stakeBefore);
      expect(infoAfter.active).to.equal(activeBefore);
      expect(await token.balanceOf(beneficiary.address)).to.equal(beneficiaryBalanceBefore);
    });

    it("only owner can slash", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      await expect(
        registry.connect(resolver).slash(resolver.address, 1n)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("slashes exactly the current stake leaving zero stake, inactive status, and full beneficiary payout", async () => {
      const [, beneficiary, , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      const beneficiaryBalanceBefore = await token.balanceOf(beneficiary.address);

      await expect(registry.slash(resolver.address, MIN_STAKE))
        .to.emit(registry, "Slashed")
        .withArgs(resolver.address, MIN_STAKE, beneficiary.address);

      const info = await registry.get(resolver.address);
      expect(info.stake).to.equal(0n);
      expect(info.active).to.be.false;
      expect(await token.balanceOf(beneficiary.address)).to.equal(
        beneficiaryBalanceBefore + MIN_STAKE
      );
      // Slash does not remove the resolver from the list.
      await assertInvariants(registry, [resolver.address]);
    });
  });

  //  isActive 

  describe("isActive", () => {
    it("returns false for an address that has never registered", async () => {
      const [, , , , stranger] = await ethers.getSigners();
      const { registry } = await deploy();
      expect(await registry.isActive(stranger.address)).to.be.false;
    });

    it("returns false after unregister", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);
      await registry.connect(resolver).unregister();
      expect(await registry.isActive(resolver.address)).to.be.false;
    });

    it("returns false after slash below minStake", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      await registry.slash(resolver.address, MIN_STAKE + 1n);
      expect(await registry.isActive(resolver.address)).to.be.false;
    });

    it("returns true after increaseStake restores stake to minStake", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      await registry.slash(resolver.address, MIN_STAKE + 1n);
      expect(await registry.isActive(resolver.address)).to.be.false;

      await registry.connect(resolver).increaseStake(2n);
      expect(await registry.isActive(resolver.address)).to.be.true;
    });

    it("reflects minStake change: active resolver can become inactive if minStake is raised", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { owner, token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);
      expect(await registry.isActive(resolver.address)).to.be.true;

      // Owner raises the minimum stake threshold.
      await registry.connect(owner).setMinStake(MIN_STAKE * 2n);
      // isActive checks stake >= minStake on-the-fly, so this is now false.
      expect(await registry.isActive(resolver.address)).to.be.false;
    });
  });

  //  list / getResolverCount 

  describe("list and getResolverCount", () => {
    it("list() returns empty array before any registration", async () => {
      const { registry } = await deploy();
      expect(await registry.list()).to.deep.equal([]);
      expect(await registry.getResolverCount()).to.equal(0n);
    });

    it("getResolverCount matches list().length at every step", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
        const listed = await registry.list();
        expect(listed.length).to.equal(Number(await registry.getResolverCount()));
      }

      await registry.connect(r2).unregister();
      {
        const listed = await registry.list();
        expect(listed.length).to.equal(Number(await registry.getResolverCount()));
        expect(listed.length).to.equal(2);
      }
    });
  });

  //  owner admin 

  describe("owner admin", () => {
    it("setMinStake emits MinStakeUpdated and updates minStake", async () => {
      const { owner, registry } = await deploy();
      const newMin = MIN_STAKE * 2n;

      await expect(registry.connect(owner).setMinStake(newMin))
        .to.emit(registry, "MinStakeUpdated")
        .withArgs(MIN_STAKE, newMin);

      expect(await registry.minStake()).to.equal(newMin);
    });

    it("setSlashBeneficiary emits SlashBeneficiaryUpdated with old and new addresses in correct order", async () => {
      const [, , newBen] = await ethers.getSigners();
      const { owner, beneficiary, registry } = await deploy();

      // Both indexed args must be present and in documented order:
      // (oldBeneficiary, newBeneficiary).  A swap would make the old
      // address appear as the new one, breaking off-chain indexers.
      await expect(
        registry.connect(owner).setSlashBeneficiary(newBen.address)
      )
        .to.emit(registry, "SlashBeneficiaryUpdated")
        .withArgs(beneficiary.address, newBen.address);

      // Storage reflects the replacement (not the old value).
      expect(await registry.slashBeneficiary()).to.equal(newBen.address);
    });

    it("setSlashBeneficiary rejects zero address", async () => {
      const { owner, registry } = await deploy();
      await expect(
        registry.connect(owner).setSlashBeneficiary(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");
    });

    it("only owner can call setMinStake and setSlashBeneficiary", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { registry } = await deploy();

      await expect(
        registry.connect(resolver).setMinStake(1n)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

      await expect(
        registry.connect(resolver).setSlashBeneficiary(resolver.address)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects a zero pending administrator and leaves owner/pendingOwner unchanged", async () => {
      const { owner, registry } = await deploy();

      const ownerBefore = await registry.owner();
      const pendingBefore = await registry.pendingOwner();

      await expect(
        registry.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");

      expect(await registry.owner()).to.equal(ownerBefore);
      expect(await registry.pendingOwner()).to.equal(pendingBefore);
    });

    it("still allows a valid two-step ownership transfer to a non-zero address", async () => {
      const [, , newOwner] = await ethers.getSigners();
      const { owner, registry } = await deploy();

      await expect(registry.connect(owner).transferOwnership(newOwner.address))
        .to.emit(registry, "OwnershipTransferStarted")
        .withArgs(owner.address, newOwner.address);

      expect(await registry.pendingOwner()).to.equal(newOwner.address);

      await registry.connect(newOwner).acceptOwnership();
      expect(await registry.owner()).to.equal(newOwner.address);
    });

    it("rejects acceptOwnership from an account that is not the pending administrator", async () => {
      const [, , newOwner, stranger] = await ethers.getSigners();
      const { owner, registry } = await deploy();

      await registry.connect(owner).transferOwnership(newOwner.address);

      const ownerBefore = await registry.owner();
      const pendingBefore = await registry.pendingOwner();

      await expect(
        registry.connect(stranger).acceptOwnership()
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

      // Neither current nor pending admin changed.
      expect(await registry.owner()).to.equal(ownerBefore);
      expect(await registry.pendingOwner()).to.equal(pendingBefore);
    });
  });

  //  getActiveResolvers

  describe("getActiveResolvers", () => {
    it("returns an empty array when no resolvers are registered", async () => {
      const { registry } = await deploy();
      expect(await registry.getActiveResolvers()).to.deep.equal([]);
    });

    it("returns all resolvers when all are active", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }

      const active = await registry.getActiveResolvers();
      expect(active.length).to.equal(2);
      const addresses = active.map((i: { resolver: string }) => i.resolver.toLowerCase());
      expect(addresses).to.include(r1.address.toLowerCase());
      expect(addresses).to.include(r2.address.toLowerCase());
    });

    it("excludes slashed-inactive resolvers while keeping active ones", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2]) {
        await fundAndApprove(token, registry, r, MIN_STAKE * 2n);
        await registry.connect(r).register(MIN_STAKE * 2n);
      }

      // Slash r1 below minimum — deactivates it.
      await registry.slash(r1.address, MIN_STAKE + 1n);

      const active = await registry.getActiveResolvers();
      expect(active.length).to.equal(1);
      expect(active[0].resolver.toLowerCase()).to.equal(r2.address.toLowerCase());
    });

    it("re-includes a resolver that tops up stake after being slashed below minimum", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 3n);

      await registry.connect(resolver).register(MIN_STAKE * 2n);
      await registry.slash(resolver.address, MIN_STAKE + 1n);
      expect((await registry.getActiveResolvers()).length).to.equal(0);

      await registry.connect(resolver).increaseStake(2n);
      const active = await registry.getActiveResolvers();
      expect(active.length).to.equal(1);
      expect(active[0].resolver.toLowerCase()).to.equal(resolver.address.toLowerCase());
    });

    it("reflects minStake increase: previously-active resolvers drop out", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { owner, token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      expect((await registry.getActiveResolvers()).length).to.equal(1);

      await registry.connect(owner).setMinStake(MIN_STAKE * 2n);
      expect((await registry.getActiveResolvers()).length).to.equal(0);
    });

    it("returns empty array after the only active resolver unregisters", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      await registry.connect(resolver).unregister();
      expect(await registry.getActiveResolvers()).to.deep.equal([]);
    });
  });

  //  getBatchInfo

  describe("getBatchInfo", () => {
    it("returns zero-value structs for unregistered addresses", async () => {
      const [, , , , stranger] = await ethers.getSigners();
      const { registry } = await deploy();

      const results = await registry.getBatchInfo([stranger.address]);
      expect(results.length).to.equal(1);
      expect(results[0].stake).to.equal(0n);
      expect(results[0].active).to.be.false;
      expect(results[0].resolver).to.equal(ethers.ZeroAddress);
    });

    it("returns an empty array for an empty input", async () => {
      const { registry } = await deploy();
      expect(await registry.getBatchInfo([])).to.deep.equal([]);
    });

    it("returns correct info for registered addresses", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
        await registry.connect(r).register(MIN_STAKE);
      }

      const results = await registry.getBatchInfo([r1.address, r2.address]);
      expect(results.length).to.equal(2);
      expect(results[0].stake).to.equal(MIN_STAKE);
      expect(results[0].active).to.be.true;
      expect(results[1].stake).to.equal(MIN_STAKE);
      expect(results[1].active).to.be.true;
    });

    it("handles a mix of registered and unregistered addresses", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, , stranger] = signers;
      const { token, registry } = await deploy();

      await fundAndApprove(token, registry, r1, MIN_STAKE);
      await registry.connect(r1).register(MIN_STAKE);

      const results = await registry.getBatchInfo([r1.address, stranger.address]);
      expect(results.length).to.equal(2);
      expect(results[0].stake).to.equal(MIN_STAKE);
      expect(results[0].active).to.be.true;
      expect(results[1].stake).to.equal(0n);
      expect(results[1].active).to.be.false;
      expect(results[1].resolver).to.equal(ethers.ZeroAddress);
    });

    it("reflects current state after slashing", async () => {
      const [, , , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      await registry.slash(resolver.address, MIN_STAKE + 1n);

      const results = await registry.getBatchInfo([resolver.address]);
      expect(results[0].active).to.be.false;
      expect(results[0].totalSlashed).to.equal(MIN_STAKE + 1n);
    });
  });

  //  Slashed event — indexed beneficiary

  describe("Slashed event indexing", () => {
    it("emits Slashed with resolver and beneficiary as indexed topics", async () => {
      const [, beneficiary, , resolver] = await ethers.getSigners();
      const { token, registry } = await deploy();
      await fundAndApprove(token, registry, resolver, MIN_STAKE * 2n);
      await registry.connect(resolver).register(MIN_STAKE * 2n);

      await expect(registry.slash(resolver.address, MIN_STAKE))
        .to.emit(registry, "Slashed")
        .withArgs(resolver.address, MIN_STAKE, beneficiary.address);
    });
  });

  //  constructor validation

  describe("constructor", () => {
    it("reverts if stakeAsset is the zero address", async () => {
      const [owner, beneficiary] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("ResolverRegistry");
      await expect(
        Registry.deploy(ethers.ZeroAddress, MIN_STAKE, beneficiary.address, owner.address)
      ).to.be.revertedWithCustomError(Registry, "InvalidAddress");
    });

    it("reverts if slashBeneficiary is the zero address", async () => {
      const [owner] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("TestERC20");
      const token = await Token.deploy("S", "S", 1n);
      const Registry = await ethers.getContractFactory("ResolverRegistry");
      await expect(
        Registry.deploy(await token.getAddress(), MIN_STAKE, ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(Registry, "InvalidAddress");
    });

    it("reverts if owner is the zero address", async () => {
      const [, beneficiary] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("TestERC20");
      const token = await Token.deploy("S", "S", 1n);
      const Registry = await ethers.getContractFactory("ResolverRegistry");
      await expect(
        Registry.deploy(
          await token.getAddress(),
          MIN_STAKE,
          beneficiary.address,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(Registry, "OwnableInvalidOwner");
    });
  });

  //  list/mapping invariant sequence

  describe("list/mapping invariant sequence", () => {
    it("keeps list() and the index mapping synchronized across a mixed sequence of registrations and removals", async () => {
      const signers = await ethers.getSigners();
      const [, , , r1, r2, r3, r4] = signers;
      const { token, registry } = await deploy();

      for (const r of [r1, r2, r3, r4]) {
        await fundAndApprove(token, registry, r, MIN_STAKE);
      }

      // Build up a list of four, then remove a middle entry (forces
      // swap-and-pop compaction), then remove the newly-swapped-in last
      // entry, then register a fresh resolver to confirm the freed slot
      // is reused correctly.
      await registry.connect(r1).register(MIN_STAKE);
      await assertInvariants(registry, [r1.address]);

      await registry.connect(r2).register(MIN_STAKE);
      await assertInvariants(registry, [r1.address, r2.address]);

      await registry.connect(r3).register(MIN_STAKE);
      await assertInvariants(registry, [r1.address, r2.address, r3.address]);

      // Remove r1 (first element): triggers swap-and-pop, moving r3 into
      // r1's old slot.
      await registry.connect(r1).unregister();
      await assertInvariants(registry, [r2.address, r3.address]);

      await registry.connect(r4).register(MIN_STAKE);
      await assertInvariants(registry, [r2.address, r3.address, r4.address]);

      // Remove r3, now in a middle slot after the earlier compaction.
      await registry.connect(r3).unregister();
      await assertInvariants(registry, [r2.address, r4.address]);

      // Every resolver still listed must independently report itself
      // active and resolvable, and each address appears exactly once.
      const listed = await registry.list();
      expect(listed.length).to.equal(2);
      const seen = new Set<string>();
      for (const addr of listed) {
        const lower = addr.toLowerCase();
        expect(seen.has(lower), `duplicate entry for ${addr}`).to.be.false;
        seen.add(lower);
        expect(await registry.isActive(addr)).to.be.true;
      }
    });
  });
});

