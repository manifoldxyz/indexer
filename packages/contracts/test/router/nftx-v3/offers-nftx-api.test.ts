import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { parseEther } from "@ethersproject/units";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import * as Sdk from "@reservoir0x/sdk/src";
import { expect } from "chai";
import { ethers, network } from "hardhat";

import { NFTXV3Offer } from "../helpers/nftx-v3";
import { ExecutionInfo } from "../helpers/router";
import { bn, getRandomBoolean, getRandomFloat, reset } from "../../utils";

describe("[ReservoirV6_0_1] NFTX offers (with NFTX API routing)", () => {
  const chainId = 5;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let emilio: SignerWithAddress;

  let router: Contract;
  let nftxV3Module: Contract;

  beforeEach(async () => {
    [deployer, alice, bob, carol, emilio] = await ethers.getSigners();

    router = await ethers
      .getContractFactory("ReservoirV6_0_1", deployer)
      .then((factory) => factory.deploy());
    nftxV3Module = await ethers
      .getContractFactory("NFTXV3Module", deployer)
      .then((factory) =>
        factory.deploy(router.address, router.address, Sdk.NftxV3.Addresses.MarketplaceZap[chainId])
      );
  });

  const getBalances = async (token: string) => {
    if (token === Sdk.Common.Addresses.Native[chainId]) {
      return {
        alice: await ethers.provider.getBalance(alice.address),
        bob: await ethers.provider.getBalance(bob.address),
        carol: await ethers.provider.getBalance(carol.address),
        emilio: await ethers.provider.getBalance(emilio.address),
        router: await ethers.provider.getBalance(router.address),
        nftxV3Module: await ethers.provider.getBalance(nftxV3Module.address),
      };
    } else {
      const contract = new Sdk.Common.Helpers.Erc20(ethers.provider, token);
      return {
        alice: await contract.getBalance(alice.address),
        bob: await ethers.provider.getBalance(bob.address),
        carol: await contract.getBalance(carol.address),
        emilio: await contract.getBalance(emilio.address),
        router: await contract.getBalance(router.address),
        nftxV3Module: await contract.getBalance(nftxV3Module.address),
      };
    }
  };

  afterEach(reset);

  const testAcceptOffers = async (
    // Whether to charge fees on the received amount
    chargeFees: boolean,
    // Whether to revert or not in case of any failures
    revertIfIncomplete: boolean,
    // Whether to cancel some orders in order to trigger partial filling
    partial: boolean
  ) => {
    // Setup

    // Token owner = carol
    const owner = "0x4eAc46c2472b32dc7158110825A7443D35a90168";
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [owner],
    });
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [owner, "0x1000000000000000000"],
    });
    carol = await ethers.getSigner(owner);

    // Collection = CryptoPunks
    const collection = "0xbB12Ad601d0024aE2cD6B763a823aD3E6A53e1e7";
    const vault = "0x65696CFa2e38AEadF3FEF5f3Ed0cA6bC79468530";
    const vaultId = 8;
    const tokenId = 7;

    const factory = await ethers.getContractFactory("MockERC721", deployer);

    const offers: NFTXV3Offer[] = [];
    const fees: BigNumber[][] = [];

    const erc721 = factory.attach(collection);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offer: any = {
      buyer: getRandomBoolean() ? alice : bob,
      nft: {
        contract: erc721,
        id: tokenId,
      },
      price: parseEther(getRandomFloat(0.6, 5).toFixed(6)),
      isCancelled: partial && getRandomBoolean(),
    };

    const poolPrice = await Sdk.NftxV3.Helpers.getPoolPriceFromAPI({
      vault,
      side: "sell",
      slippage: 100,
      provider: ethers.provider,
      userAddress: carol.address,
      tokenIds: [offer.nft.id.toString()],
      type: "quote",
    });

    if (poolPrice.price) {
      offer.price = bn(poolPrice.price);
      offer.vault = vault;
      offer.order = new Sdk.NftxV3.Order(chainId, vault, carol.address, {
        vaultId: vaultId.toString(),
        collection: offer.nft.contract.address,
        currency: Sdk.Common.Addresses.WNative[chainId],
        idsIn: [offer.nft.id.toString()],
        amounts: [],
        price: offer.isCancelled ? "0" : offer.price.toString(),
        executeCallData: offer.isCancelled ? "0x00" : poolPrice.executeCallData,
        deductRoyalty: false,
      });
    }

    offers.push(offer);

    if (chargeFees) {
      fees.push([parseEther(getRandomFloat(0.0001, 0.1).toFixed(6))]);
    } else {
      fees.push([]);
    }

    await erc721.connect(carol).transferFrom(carol.address, nftxV3Module.address, tokenId);

    // Prepare executions

    const executions: ExecutionInfo[] = [
      ...offers
        .filter((_) => _.order)
        .map((offer, i) => ({
          module: nftxV3Module.address,
          data: nftxV3Module.interface.encodeFunctionData("sell", [
            [offer.order?.params],
            {
              fillTo: carol.address,
              refundTo: carol.address,
              revertIfIncomplete,
            },
            [
              ...fees[i].map((amount) => ({
                recipient: emilio.address,
                amount,
              })),
            ],
          ]),
          value: 0,
        })),
    ];

    // Checks

    // If the `revertIfIncomplete` option is enabled and we have any
    // orders that are not fillable, the whole transaction should be
    // reverted
    if (partial && revertIfIncomplete && offers.some(({ isCancelled }) => isCancelled)) {
      await expect(
        router.connect(carol).execute(executions, {
          value: executions.map(({ value }) => value).reduce((a, b) => bn(a).add(b), bn(0)),
        })
      ).to.be.revertedWith("reverted with custom error 'UnsuccessfulExecution()'");

      return;
    }

    // Fetch pre-state

    const balancesBefore = await getBalances(Sdk.Common.Addresses.Native[chainId]);

    // Execute
    await router.connect(carol).execute(executions, {
      value: executions.map(({ value }) => value).reduce((a, b) => bn(a).add(b), bn(0)),
    });

    // Fetch post-state
    const balancesAfter = await getBalances(Sdk.Common.Addresses.Native[chainId]);

    // Checks

    // Carol got the payment
    const orderFee = offers
      .map((_, i) => (offers[i].isCancelled ? [] : fees[i]))
      .map((executionFees) => executionFees.reduce((a, b) => bn(a).add(b), bn(0)))
      .reduce((a, b) => bn(a).add(b), bn(0));

    // Emilio got the fee payments
    if (chargeFees) {
      expect(balancesAfter.emilio.sub(balancesBefore.emilio)).to.eq(orderFee);
    }

    // Alice and Bob got the NFTs of the filled orders
    for (const { nft, isCancelled, vault } of offers) {
      if (!isCancelled) {
        expect(await nft.contract.ownerOf(nft.id)).to.eq(vault);
      } else {
        expect(await nft.contract.ownerOf(nft.id)).to.eq(carol.address);
      }
    }

    // Router is stateless
    expect(balancesAfter.router).to.eq(0);
    expect(balancesAfter.nftxV3Module).to.eq(0);
  };

  for (const partial of [false, true]) {
    for (const chargeFees of [false, true]) {
      for (const revertIfIncomplete of [true, false]) {
        const testCaseName =
          `${partial ? "[partial]" : "[full]"}` +
          `${chargeFees ? "[fees]" : "[no-fees]"}` +
          `${revertIfIncomplete ? "[reverts]" : "[skip-reverts]"}`;

        it(testCaseName, async () => testAcceptOffers(chargeFees, revertIfIncomplete, partial));
      }
    }
  }
});
