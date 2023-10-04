import { BigNumberish } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import * as Sdk from "@reservoir0x/sdk/src";
import { ethers } from "hardhat";

import { getChainId, bn, getCurrentTimestamp } from "../../utils";

import FactoryAbi from "@reservoir0x/sdk/src/nftx-v3/abis/Factory.json";
import CreateVaultZapAbi from "@reservoir0x/sdk/src/nftx-v3/abis/CreateVaultZap.json";
import { parseEther } from "ethers/lib/utils";

// --- Listings ---

export type NFTXV3Listing = {
  seller: SignerWithAddress;
  nft: {
    contract: Contract;
    id: number;
  };
  price: BigNumberish;
  // Whether the order is to be cancelled
  isCancelled?: boolean;
  order?: Sdk.NftxV3.Order;
  vault?: string;
};

export const setupNFTXV3Listings = async (listings: NFTXV3Listing[]) => {
  const chainId = getChainId();

  const createVaultZap = new Contract(
    Sdk.NftxV3.Addresses.CreateVaultZap[chainId],
    CreateVaultZapAbi,
    ethers.provider
  );

  for (const listing of listings) {
    const { seller, nft, price, isCancelled } = listing;

    const newId = nft.id;
    const newId2 = nft.id + 10002;
    const newId3 = nft.id + 10003;
    const newId4 = nft.id + 10004;

    const poolIds = [newId, newId2, newId3, newId4];

    const txs = await Promise.all(poolIds.map((c) => nft.contract.connect(seller).mint(c)));
    await Promise.all(txs.map((c) => c.wait()));

    await nft.contract.connect(seller).setApprovalForAll(createVaultZap.address, true);

    const pricePerToken = bn(price).div(bn(poolIds.length));

    const args = {
      vaultInfo: {
        assetAddress: nft.contract.address,
        is1155: false,
        allowAllItems: true,
        name: "TestNFT_" + new Date(), // adding timestamp so that multiple vaults can be deployed, without revert
        symbol: "TEST",
      },
      eligibilityStorage: {
        moduleIndex: 0,
        initData: "0x00",
      },
      nftIds: poolIds,
      nftAmounts: [],
      vaultFeaturesFlag: 111,
      vaultFees: {
        mintFee: 3000000,
        redeemFee: 3000000,
        swapFee: 3000000,
      },
      liquidityParams: {
        lowerNFTPriceInETH: pricePerToken.sub(pricePerToken.mul(50).div(100)), // 50% lower
        upperNFTPriceInETH: pricePerToken.add(pricePerToken.mul(50).div(100)), // 50% higher
        fee: Sdk.NftxV3.Helpers.REWARD_FEE_TIER,
        currentNFTPriceInETH: pricePerToken,
        vTokenMin: 0,
        wethMin: 0,
        deadline: (await getCurrentTimestamp(ethers.provider)) + 60 * 60,
      },
    };

    // TODO: determine actual ETH value
    const value = bn(price).mul(100);

    const _vaultId = await createVaultZap.connect(seller).callStatic.createVault(args, { value });

    await createVaultZap.connect(seller).createVault(args, { value });

    const factory = new Contract(
      Sdk.NftxV3.Addresses.VaultFactory[chainId],
      FactoryAbi,
      ethers.provider
    );
    const vaultAddress = await factory.vault(_vaultId.toString());

    const poolPrice = await Sdk.NftxV3.Helpers.getPoolPrice(
      vaultAddress,
      1,
      "buy",
      100,
      Sdk.NftxV3.Helpers.REWARD_FEE_TIER,
      ethers.provider,
      [nft.id]
    );

    if (poolPrice) {
      listing.price = bn(poolPrice.price);
      listing.vault = vaultAddress;
      listing.order = new Sdk.NftxV3.Order(chainId, vaultAddress, seller.address, {
        vaultId: _vaultId.toString(),
        collection: nft.contract.address,
        idsOut: [nft.id.toString()],
        price: isCancelled ? "0" : listing.price.toString(),
        executeCallData: poolPrice.executeCallData,
        vTokenPremiumLimit: ethers.constants.MaxUint256.toString(),
        deductRoyalty: false,
      });
    }
  }
};

// --- Offers ---

export type NFTXV3Offer = {
  buyer: SignerWithAddress;
  nft: {
    contract: Contract;
    id: number;
  };
  price: BigNumberish;
  // Whether the order is to be cancelled
  isCancelled?: boolean;
  order?: Sdk.NftxV3.Order;
  vault?: string;
};

export const setupNFTXV3Offers = async (offers: NFTXV3Offer[]) => {
  const chainId = getChainId();

  const createVaultZap = new Contract(
    Sdk.NftxV3.Addresses.CreateVaultZap[chainId],
    CreateVaultZapAbi,
    ethers.provider
  );

  for (const offer of offers) {
    const { buyer, nft, price, isCancelled } = offer;

    const newId = nft.id;
    const newId2 = nft.id + 10002;
    const newId3 = nft.id + 10003;
    const newId4 = nft.id + 10004;

    const poolIds = [newId2, newId3, newId4];

    // Approve the factory contract
    const txs = await Promise.all(poolIds.map((c) => nft.contract.connect(buyer).mint(c)));
    await Promise.all(txs.map((c) => c.wait()));

    await nft.contract.connect(buyer).setApprovalForAll(createVaultZap.address, true);

    const args = {
      vaultInfo: {
        assetAddress: nft.contract.address,
        is1155: false,
        allowAllItems: true,
        name: "TestNFT",
        symbol: "TEST",
      },
      eligibilityStorage: {
        moduleIndex: 0,
        initData: "0x00",
      },
      nftIds: poolIds,
      nftAmounts: [],
      vaultFeaturesFlag: 111,
      vaultFees: {
        mintFee: 3000000,
        redeemFee: 3000000,
        swapFee: 3000000,
      },
      liquidityParams: {
        lowerNFTPriceInETH: parseEther("0.1"),
        upperNFTPriceInETH: parseEther("0.3"),
        fee: Sdk.NftxV3.Helpers.REWARD_FEE_TIER,
        currentNFTPriceInETH: parseEther("0.2"),
        vTokenMin: 0,
        wethMin: 0,
        deadline: (await getCurrentTimestamp(ethers.provider)) + 100,
      },
    };

    const _vaultId = await createVaultZap
      .connect(buyer)
      .callStatic.createVault(args, { value: price });

    await createVaultZap.connect(buyer).createVault(args, { value: price });

    const factory = new Contract(
      Sdk.NftxV3.Addresses.VaultFactory[chainId],
      FactoryAbi,
      ethers.provider
    );
    const vaultAddress = await factory.vault(_vaultId.toString());

    const [poolPrice] = await Promise.all([
      Sdk.NftxV3.Helpers.getPoolPrice(
        vaultAddress,
        1,
        "sell",
        100,
        Sdk.NftxV3.Helpers.REWARD_FEE_TIER,
        ethers.provider
      ),
      Sdk.NftxV3.Helpers.getPoolNFTs(vaultAddress, ethers.provider),
    ]);

    if (poolPrice) {
      offer.price = bn(poolPrice.price);
      offer.vault = vaultAddress;
      offer.order = new Sdk.NftxV3.Order(chainId, vaultAddress, buyer.address, {
        vaultId: _vaultId.toString(),
        collection: nft.contract.address,
        currency: Sdk.Common.Addresses.WNative[chainId],
        idsIn: [nft.id.toString()],
        amounts: [],
        price: isCancelled ? offer.price.mul(bn(10)).toString() : offer.price.toString(),
        executeCallData: poolPrice.executeCallData,
        deductRoyalty: false,
      });
    }
  }
};
