import { Transaction } from "@mysten/sui/transactions";
import { getWallets } from "@mysten/wallet-standard";

const TESTNET_CHAIN = "sui:testnet";
const PACKAGE_ID = import.meta.env?.VITE_CASEFLOW_SNAPSHOT_PACKAGE_ID || "";

function configuredPackageId() {
  if (!PACKAGE_ID || PACKAGE_ID === "0x") {
    throw new Error("Set VITE_CASEFLOW_SNAPSHOT_PACKAGE_ID to the deployed testnet package id before minting.");
  }
  return PACKAGE_ID;
}

function signAndExecuteFeature(wallet) {
  return wallet.features?.["sui:signAndExecuteTransaction"];
}

function connectFeature(wallet) {
  return wallet.features?.["standard:connect"];
}

function testnetAccounts(accounts = []) {
  return accounts.filter((account) => account.chains?.includes(TESTNET_CHAIN));
}

function pickSuiWallet() {
  const wallets = getWallets().get();
  return wallets.find((wallet) => {
    const supportsTestnet = wallet.chains?.includes(TESTNET_CHAIN);
    return supportsTestnet && connectFeature(wallet) && signAndExecuteFeature(wallet);
  });
}

function metadataArgumentValues(metadata) {
  return [
    metadata.name,
    metadata.description,
    metadata.image_url,
    metadata.snapshot_url,
    metadata.snapshot_hash,
    metadata.seed_address,
  ];
}

export async function mintSnapshot({ metadata }) {
  const packageId = configuredPackageId();
  const wallet = pickSuiWallet();
  if (!wallet) {
    throw new Error("No Sui testnet wallet found. Install or unlock a Sui wallet, then refresh this page.");
  }

  const connectResult = await connectFeature(wallet).connect();
  const account = testnetAccounts(connectResult.accounts || wallet.accounts)[0];
  if (!account) {
    throw new Error("Connected wallet has no Sui testnet account. Switch the wallet network to testnet and try again.");
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::snapshot_nft::mint`,
    arguments: [
      ...metadataArgumentValues(metadata).map((value) => tx.pure.string(String(value || ""))),
      tx.pure.u64(BigInt(metadata.created_at_ms || Date.now())),
    ],
  });

  const result = await signAndExecuteFeature(wallet).signAndExecuteTransaction({
    transaction: tx,
    account,
    chain: TESTNET_CHAIN,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });

  if (result?.effects?.status?.status === "failure") {
    throw new Error(result.effects.status.error || "Sui transaction failed.");
  }

  return result;
}
