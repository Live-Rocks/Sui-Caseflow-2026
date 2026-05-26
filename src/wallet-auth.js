import { getWallets } from "@mysten/wallet-standard";

const MAINNET_CHAIN = "sui:mainnet";
const TESTNET_CHAIN = "sui:testnet";

function connectFeature(wallet) {
  return wallet.features?.["standard:connect"];
}

function signPersonalMessageFeature(wallet) {
  return wallet.features?.["sui:signPersonalMessage"];
}

function compatibleAccounts(accounts = []) {
  return accounts.filter((account) => account.address && (account.chains?.includes(MAINNET_CHAIN) || account.chains?.includes(TESTNET_CHAIN)));
}

function pickSuiWallet() {
  const wallets = getWallets().get();
  return wallets.find((wallet) => connectFeature(wallet) && signPersonalMessageFeature(wallet));
}

export async function signInWithSuiWallet({ message }) {
  const wallet = pickSuiWallet();
  if (!wallet) {
    throw new Error("No Sui wallet found. Install or unlock a Sui wallet, then refresh this page.");
  }

  const connectResult = await connectFeature(wallet).connect();
  const account = compatibleAccounts(connectResult.accounts || wallet.accounts)[0];
  if (!account) {
    throw new Error("Connected wallet has no Sui account available for signing.");
  }

  const encodedMessage = new TextEncoder().encode(message);
  const result = await signPersonalMessageFeature(wallet).signPersonalMessage({
    message: encodedMessage,
    account,
  });

  return {
    address: account.address,
    publicKey: account.publicKey ? Array.from(account.publicKey) : null,
    bytes: result.bytes,
    signature: result.signature,
  };
}
