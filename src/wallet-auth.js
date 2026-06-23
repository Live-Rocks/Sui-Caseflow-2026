import { getWallets } from "@mysten/wallet-standard";

const MAINNET_CHAIN = "sui:mainnet";
const TESTNET_CHAIN = "sui:testnet";

function connectFeature(wallet) {
  return wallet.features?.["standard:connect"];
}

function disconnectFeature(wallet) {
  return wallet.features?.["standard:disconnect"];
}

function signPersonalMessageFeature(wallet) {
  return wallet.features?.["sui:signPersonalMessage"];
}

function compatibleAccounts(accounts = []) {
  return accounts.filter((account) => account.address && (account.chains?.includes(MAINNET_CHAIN) || account.chains?.includes(TESTNET_CHAIN)));
}

function accountSummary(account) {
  return {
    address: account.address,
    chains: account.chains || [],
    publicKey: account.publicKey ? Array.from(account.publicKey) : null,
  };
}

function walletSummary(wallet, index) {
  return {
    id: `${wallet.name || "wallet"}:${index}`,
    index,
    name: wallet.name || `Wallet ${index + 1}`,
    icon: wallet.icon || "",
    chains: wallet.chains || [],
    canDisconnect: Boolean(disconnectFeature(wallet)),
  };
}

export function getSuiWalletChoices() {
  return getWallets()
    .get()
    .map((wallet, index) => ({ wallet, summary: walletSummary(wallet, index) }))
    .filter(({ wallet }) => connectFeature(wallet) && signPersonalMessageFeature(wallet));
}

export async function disconnectSuiWallet(wallet) {
  const disconnect = disconnectFeature(wallet);
  if (!disconnect) return false;
  await disconnect.disconnect();
  return true;
}

export async function connectSuiWallet(wallet) {
  const connect = connectFeature(wallet);
  if (!connect) throw new Error("Selected wallet does not support connection.");
  const connectResult = await connect.connect();
  const accounts = compatibleAccounts(connectResult.accounts || wallet.accounts);
  return {
    wallet: walletSummary(wallet, 0),
    accounts: accounts.map(accountSummary),
    rawAccounts: accounts,
  };
}

export async function signInWithSuiWallet({ message, wallet, account }) {
  let selectedWallet = wallet;
  let selectedAccount = account;

  if (!selectedWallet) {
    selectedWallet = getSuiWalletChoices()[0]?.wallet;
  }
  if (!selectedWallet) {
    throw new Error("No Sui wallet found. Install or unlock a Sui wallet, then refresh this page.");
  }

  if (!selectedAccount) {
    const connectResult = await connectFeature(selectedWallet).connect();
    selectedAccount = compatibleAccounts(connectResult.accounts || selectedWallet.accounts)[0];
  }
  if (!selectedAccount) {
    throw new Error("Connected wallet has no Sui account available for signing.");
  }

  const encodedMessage = new TextEncoder().encode(message);
  const result = await signPersonalMessageFeature(selectedWallet).signPersonalMessage({
    message: encodedMessage,
    account: selectedAccount,
  });

  return {
    address: selectedAccount.address,
    publicKey: selectedAccount.publicKey ? Array.from(selectedAccount.publicKey) : null,
    bytes: result.bytes,
    signature: result.signature,
  };
}
