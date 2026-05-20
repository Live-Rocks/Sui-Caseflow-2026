#!/usr/bin/env node

const RPC_URLS = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
};
const MAX_TRANSACTION_PAGE_SIZE = 50;
const MAX_INFERRED_EDGES_PER_COIN = 25;
const PROTOCOL_ACTIVITY_NODE_ID = "protocol:activity";
const PROTOCOL_BRIDGE_NODE_ID = "protocol:bridge";
const PROTOCOL_SWAP_NODE_ID = "protocol:swap";
const SUI_COIN_TYPE = "0x2::sui::SUI";
const SUI_GAS_TOLERANCE = 10_000_000n;

async function writeJsonFile(path, value) {
  const fs = await import("node:fs/promises");
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    address: argv[2],
    limit: 10,
    network: "mainnet",
    out: null,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--network" && next) {
      args.network = next;
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = next;
      i += 1;
    }
  }

  return args;
}

function usage() {
  console.error("Usage: node scripts/query-sui-address.mjs 0xADDRESS [--limit 10] [--network mainnet] [--out data/trace.json]");
}

function assertValidArgs(args) {
  if (!args.address || !args.address.startsWith("0x")) {
    usage();
    process.exit(1);
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
    console.error("--limit must be an integer from 1 to 100");
    process.exit(1);
  }

  if (!RPC_URLS[args.network]) {
    console.error(`Unsupported network: ${args.network}`);
    console.error(`Use one of: ${Object.keys(RPC_URLS).join(", ")}`);
    process.exit(1);
  }
}

async function rpc(network, method, params) {
  const response = await fetch(RPC_URLS[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`RPC error: ${JSON.stringify(payload.error)}`);
  }

  return payload.result;
}

function ownerToAddress(owner) {
  if (!owner) return null;
  if (typeof owner === "string") return owner;
  if (owner.AddressOwner) return owner.AddressOwner;
  if (owner.ObjectOwner) return `object:${owner.ObjectOwner}`;
  if (owner.Shared) return "shared";
  if (owner.Immutable) return "immutable";
  return JSON.stringify(owner);
}

function formatAmount(rawAmount) {
  const value = BigInt(rawAmount);
  return value.toString();
}

function fallbackCoinMetadata(coinType) {
  if (coinType === SUI_COIN_TYPE) {
    return {
      coinType,
      symbol: "SUI",
      decimals: 9,
    };
  }

  return {
    coinType,
    symbol: coinType.split("::").at(-1) || coinType,
    decimals: 9,
  };
}

function getCoinMetadata(metadataByCoinType, coinType) {
  return metadataByCoinType.get(coinType) || fallbackCoinMetadata(coinType);
}

function summarizeBalanceChanges(balanceChanges = [], metadataByCoinType = new Map()) {
  return balanceChanges.map((change) => ({
    owner: ownerToAddress(change.owner),
    coinType: change.coinType,
    coinSymbol: getCoinMetadata(metadataByCoinType, change.coinType).symbol,
    coinDecimals: getCoinMetadata(metadataByCoinType, change.coinType).decimals,
    amount: formatAmount(change.amount),
  }));
}

function inferProbableEdges(tx, metadataByCoinType = new Map()) {
  const changes = summarizeBalanceChanges(tx.balanceChanges || [], metadataByCoinType);
  const byCoinType = new Map();

  for (const change of changes) {
    if (!change.owner || change.owner === "shared" || change.owner === "immutable") continue;
    const existing = byCoinType.get(change.coinType) || [];
    existing.push(change);
    byCoinType.set(change.coinType, existing);
  }

  const edges = [];
  for (const [coinType, coinChanges] of byCoinType.entries()) {
    const debits = coinChanges.filter((change) => BigInt(change.amount) < 0n);
    const credits = coinChanges.filter((change) => BigInt(change.amount) > 0n);
    const metadata = getCoinMetadata(metadataByCoinType, coinType);

    if (debits.length === 0 || credits.length === 0) continue;

    if (debits.length > 1 && credits.length > 1) {
      continue;
    }

    if (debits.length === 1 && credits.length > MAX_INFERRED_EDGES_PER_COIN) {
      continue;
    }

    if (credits.length === 1 && debits.length > MAX_INFERRED_EDGES_PER_COIN) {
      continue;
    }

    if (debits.length === 1) {
      for (const credit of credits) {
        if (debits[0].owner === credit.owner) continue;
        edges.push(buildEdge({
          from: debits[0].owner,
          to: credit.owner,
          coinType,
          metadata,
          amount: credit.amount,
          tx,
          reason: "single debit matched to positive balance changes for this coin type",
        }));
      }
    } else if (credits.length === 1) {
      for (const debit of debits) {
        if (debit.owner === credits[0].owner) continue;
        edges.push(buildEdge({
          from: debit.owner,
          to: credits[0].owner,
          coinType,
          metadata,
          amount: (BigInt(debit.amount) * -1n).toString(),
          tx,
          reason: "negative balance changes matched to single credit for this coin type",
        }));
      }
    }
  }

  return edges;
}

function inferSeedActivityEdges(seedAddress, tx, probableEdges, metadataByCoinType = new Map()) {
  const changes = summarizeBalanceChanges(tx.balanceChanges || [], metadataByCoinType);
  const seedChanges = changes.filter((change) => change.owner === seedAddress && BigInt(change.amount) !== 0n);
  const hasNonSuiSeedChange = seedChanges.some((change) => change.coinType !== SUI_COIN_TYPE);
  const activityEdges = [];
  const protocol = classifyProtocolActivity(tx);

  for (const change of seedChanges) {
    if (isCoveredByProbableEdge(seedAddress, change, probableEdges)) continue;
    if (isLikelyGasOnlyChange(change, hasNonSuiSeedChange)) continue;

    const amount = BigInt(change.amount);
    const metadata = getCoinMetadata(metadataByCoinType, change.coinType);
    const isOutflow = amount < 0n;

    activityEdges.push(buildEdge({
      from: isOutflow ? seedAddress : protocol.nodeId,
      to: isOutflow ? protocol.nodeId : seedAddress,
      coinType: change.coinType,
      metadata,
      amount: (amount < 0n ? -amount : amount).toString(),
      tx,
      confidence: protocol.confidence,
      reason: isOutflow
        ? `seed address balance decreased through ${protocol.label}`
        : `seed address balance increased through ${protocol.label}`,
    }));
  }

  return activityEdges;
}

function classifyProtocolActivity(tx) {
  const eventTypes = (tx.events || []).map((event) => event.type?.toLowerCase() || "");
  const eventModules = (tx.events || []).map((event) => event.transactionModule?.toLowerCase() || "");

  if (eventTypes.some((type) => type.includes("::bridge::")) || eventModules.includes("bridge")) {
    return {
      nodeId: PROTOCOL_BRIDGE_NODE_ID,
      label: "bridge",
      confidence: "bridge",
    };
  }

  if (eventTypes.some((type) => type.includes("swapevent") || type.includes("::swap")) || eventModules.some((module) => module.includes("swap"))) {
    return {
      nodeId: PROTOCOL_SWAP_NODE_ID,
      label: "swap",
      confidence: "swap",
    };
  }

  return {
    nodeId: PROTOCOL_ACTIVITY_NODE_ID,
    label: "protocol activity",
    confidence: "activity",
  };
}

function isCoveredByProbableEdge(seedAddress, change, probableEdges) {
  const amount = BigInt(change.amount);
  const absoluteAmount = amount < 0n ? -amount : amount;

  return probableEdges.some((edge) => {
    if (edge.coinType !== change.coinType) return false;
    if (!amountsCloseEnough(change.coinType, BigInt(edge.amount), absoluteAmount)) return false;
    if (amount < 0n) return edge.from === seedAddress;
    return edge.to === seedAddress;
  });
}

function amountsCloseEnough(coinType, inferredAmount, seedChangeAmount) {
  if (inferredAmount === seedChangeAmount) return true;
  if (coinType !== SUI_COIN_TYPE) return false;

  const difference = inferredAmount > seedChangeAmount
    ? inferredAmount - seedChangeAmount
    : seedChangeAmount - inferredAmount;
  return difference <= SUI_GAS_TOLERANCE;
}

function isLikelyGasOnlyChange(change, hasNonSuiSeedChange) {
  if (!hasNonSuiSeedChange || change.coinType !== SUI_COIN_TYPE) return false;
  const amount = BigInt(change.amount);
  return (amount < 0n ? -amount : amount) < SUI_GAS_TOLERANCE;
}

function buildEdge({ from, to, coinType, metadata, amount, tx, confidence = "probable", reason }) {
  return {
    from,
    to,
    coinType,
    coinSymbol: metadata.symbol,
    coinDecimals: metadata.decimals,
    amount,
    txDigest: tx.digest,
    timestampMs: tx.timestampMs,
    confidence,
    reason,
  };
}

function shortAddress(address) {
  if (!address) return "";
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

function edgeId(edge, index) {
  return `${edge.txDigest}:${edge.coinType}:${edge.from}:${edge.to}:${index}`;
}

function buildGraphSnapshot(address, network, transactions, metadataByCoinType) {
  const nodeMap = new Map();
  const edges = [];
  const timeline = [];

  function ensureNode(nodeAddress, label) {
    if (!nodeAddress || nodeAddress.startsWith("object:")) return;

    const existing = nodeMap.get(nodeAddress);
    if (existing) {
      if (label && !existing.labels.includes(label)) existing.labels.push(label);
      return;
    }

    if (nodeAddress === PROTOCOL_ACTIVITY_NODE_ID || nodeAddress === PROTOCOL_BRIDGE_NODE_ID || nodeAddress === PROTOCOL_SWAP_NODE_ID) {
      const config = {
        [PROTOCOL_ACTIVITY_NODE_ID]: { address: "Protocol Activity", shortAddress: "Protocol", labels: ["protocol"] },
        [PROTOCOL_BRIDGE_NODE_ID]: { address: "Bridge", shortAddress: "Bridge", labels: ["bridge", "protocol"] },
        [PROTOCOL_SWAP_NODE_ID]: { address: "Swap", shortAddress: "Swap", labels: ["swap", "protocol"] },
      }[nodeAddress];

      nodeMap.set(nodeAddress, {
        id: nodeAddress,
        address: config.address,
        shortAddress: config.shortAddress,
        labels: config.labels,
        stats: {
          txCount: 0,
          inboundCount: 0,
          outboundCount: 0,
        },
      });
      return;
    }

    nodeMap.set(nodeAddress, {
      id: nodeAddress,
      address: nodeAddress,
      shortAddress: shortAddress(nodeAddress),
      labels: label ? [label] : [],
      stats: {
        txCount: 0,
        inboundCount: 0,
        outboundCount: 0,
      },
    });
  }

  ensureNode(address, "seed");

  for (const tx of transactions) {
    const probableEdges = inferProbableEdges(tx, metadataByCoinType);
    const activityEdges = inferSeedActivityEdges(address, tx, probableEdges, metadataByCoinType);
    const txEdges = [...probableEdges, ...activityEdges];
    const relatedAddresses = new Set();

    for (const change of summarizeBalanceChanges(tx.balanceChanges || [], metadataByCoinType)) {
      if (!change.owner || change.owner.startsWith("object:")) continue;
      ensureNode(change.owner);
      relatedAddresses.add(change.owner);
      nodeMap.get(change.owner).stats.txCount += 1;
    }

    txEdges.forEach((edge, index) => {
      ensureNode(edge.from);
      ensureNode(edge.to);

      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (fromNode) fromNode.stats.outboundCount += 1;
      if (toNode) toNode.stats.inboundCount += 1;

      edges.push({
        id: edgeId(edge, index),
        ...edge,
      });
    });

    timeline.push({
      id: tx.digest,
      txDigest: tx.digest,
      timestampMs: tx.timestampMs,
      kind: txEdges.length > 0 ? "transfer" : "unknown",
      title: txEdges.length > 0
        ? `${txEdges.length} flow edge(s)`
        : "No simple transfer edge inferred",
      details: [
        `status: ${tx.effects?.status?.status || "unknown"}`,
        `balance changes: ${tx.balanceChanges?.length || 0}`,
        `events: ${tx.events?.length || 0}`,
        `object changes: ${tx.objectChanges?.length || 0}`,
      ],
      relatedAddresses: Array.from(relatedAddresses),
    });
  }

  return {
    seedAddress: address,
    network,
    generatedAt: new Date().toISOString(),
    nodes: Array.from(nodeMap.values()),
    edges,
    timeline,
  };
}

async function queryAddressByFilter({ filter, limit, network }) {
  const data = [];
  let cursor = null;
  let hasNextPage = false;
  let nextCursor = null;
  let pageCount = 0;

  do {
    const remaining = limit - data.length;
    if (remaining <= 0) break;

    const pageLimit = Math.min(MAX_TRANSACTION_PAGE_SIZE, remaining);
    const page = await rpc(network, "suix_queryTransactionBlocks", [
      {
        filter,
        options: {
          showBalanceChanges: true,
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
          showInput: true,
        },
      },
      cursor,
      pageLimit,
      true,
    ]);

    pageCount += 1;
    data.push(...(page.data || []));
    hasNextPage = Boolean(page.hasNextPage);
    nextCursor = page.nextCursor || null;
    cursor = nextCursor;

    if (!hasNextPage || !nextCursor || (page.data || []).length === 0) break;
  } while (data.length < limit);

  return {
    data,
    nextCursor,
    hasNextPage,
    pageCount,
    requestedCount: limit,
  };
}

async function fetchCoinMetadata(network, coinType) {
  try {
    const metadata = await rpc(network, "suix_getCoinMetadata", [coinType]);
    const fallback = fallbackCoinMetadata(coinType);
    return {
      coinType,
      symbol: metadata?.symbol || fallback.symbol,
      decimals: Number.isInteger(metadata?.decimals) ? metadata.decimals : fallback.decimals,
    };
  } catch {
    return fallbackCoinMetadata(coinType);
  }
}

async function buildCoinMetadataMap(network, transactions) {
  const coinTypes = new Set();

  for (const tx of transactions) {
    for (const change of tx.balanceChanges || []) {
      coinTypes.add(change.coinType);
    }
  }

  const metadataEntries = await Promise.all(
    Array.from(coinTypes).map((coinType) => fetchCoinMetadata(network, coinType)),
  );

  return new Map(metadataEntries.map((metadata) => [metadata.coinType, metadata]));
}

function mergeTransactionPages(pages, limit) {
  const byDigest = new Map();

  for (const page of pages) {
    for (const tx of page.data || []) {
      byDigest.set(tx.digest, tx);
    }
  }

  const data = Array.from(byDigest.values())
    .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0))
    .slice(0, limit);

  return {
    data,
    nextCursor: null,
    hasNextPage: pages.some((page) => page.hasNextPage),
    sourcePages: pages.map((page) => ({
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      count: page.data?.length || 0,
      pageCount: page.pageCount || 1,
      requestedCount: page.requestedCount || limit,
    })),
  };
}

async function queryAddress({ address, limit, network }) {
  const [fromPage, toPage] = await Promise.all([
    queryAddressByFilter({
      filter: {
        FromAddress: address,
      },
      limit,
      network,
    }),
    queryAddressByFilter({
      filter: {
        ToAddress: address,
      },
      limit,
      network,
    }),
  ]);

  return mergeTransactionPages([fromPage, toPage], limit);
}

async function buildSummary(address, network, result) {
  const transactions = result.data || [];
  const metadataByCoinType = await buildCoinMetadataMap(network, transactions);
  const edges = transactions.flatMap((tx) => inferProbableEdges(tx, metadataByCoinType));
  const graphSnapshot = buildGraphSnapshot(address, network, transactions, metadataByCoinType);

  return {
    seedAddress: address,
    network,
    txCount: transactions.length,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
    sourcePages: result.sourcePages,
    graphSnapshot,
    transactions: transactions.map((tx) => ({
      digest: tx.digest,
      timestampMs: tx.timestampMs,
      status: tx.effects?.status?.status,
      balanceChanges: summarizeBalanceChanges(tx.balanceChanges || [], metadataByCoinType),
      probableEdges: inferProbableEdges(tx, metadataByCoinType),
      eventCount: tx.events?.length || 0,
      objectChangeCount: tx.objectChanges?.length || 0,
    })),
    probableEdges: edges,
  };
}

const args = parseArgs(process.argv);
assertValidArgs(args);

try {
  const result = await queryAddress(args);
  const summary = await buildSummary(args.address, args.network, result);
  if (args.out) {
    await writeJsonFile(args.out, summary);
    console.log(`Wrote ${args.out}`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
