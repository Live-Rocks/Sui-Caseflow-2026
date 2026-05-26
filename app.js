const SAMPLE_ADDRESS = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
const EXPLORER_BASE_URL = "https://suivision.xyz";
const LABELS = ["hacker", "intermediate", "bridge", "exchange_suspect", "known_entity", "watch"];
const MAX_UNDO_STEPS = 20;
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DUST_SUI_THRESHOLD = 5_000_000n;
const AUTH_STORAGE_KEY = "sui-caseflow-auth-session";

let trace = null;
let selectedNodeId = SAMPLE_ADDRESS;
let selectedFlowKey = null;
let dragState = null;
let panState = null;
let viewportState = null;
let pendingSnapshot = null;
let dustFilterEnabled = false;
let authSession = null;
let mySnapshots = [];
let walletDropdownOpen = false;
const manualPositions = new Map();
let currentPositions = new Map();
const labelState = new Map();
const hiddenNodeIds = new Set();
const hiddenEdgeIds = new Set();
const expandedNodeIds = new Set();
const nodeDepthById = new Map();
const nodeParentById = new Map();
const undoStack = [];

const els = {
  addressInput: document.querySelector("#addressInput"),
  limitSelect: document.querySelector("#limitSelect"),
  loadSampleButton: document.querySelector("#loadSampleButton"),
  traceButton: document.querySelector("#traceButton"),
  historyHint: document.querySelector("#historyHint"),
  walletMenu: document.querySelector("#walletMenu"),
  walletButton: document.querySelector("#walletButton"),
  walletDropdown: document.querySelector("#walletDropdown"),
  signOutButton: document.querySelector("#signOutButton"),
  authStatus: document.querySelector("#authStatus"),
  snapshotList: document.querySelector("#snapshotList"),
  undoButton: document.querySelector("#undoButton"),
  showAllButton: document.querySelector("#showAllButton"),
  dustFilterButton: document.querySelector("#dustFilterButton"),
  fitButton: document.querySelector("#fitButton"),
  mintSnapshotButton: document.querySelector("#mintSnapshotButton"),
  nodeCount: document.querySelector("#nodeCount"),
  edgeCount: document.querySelector("#edgeCount"),
  txCount: document.querySelector("#txCount"),
  caseTitle: document.querySelector("#caseTitle"),
  flowGraph: document.querySelector("#flowGraph"),
  labelList: document.querySelector("#labelList"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedAddress: document.querySelector("#selectedAddress"),
  labelControls: document.querySelector("#labelControls"),
  hideNodeButton: document.querySelector("#hideNodeButton"),
  expandNodeButton: document.querySelector("#expandNodeButton"),
  flowTitle: document.querySelector("#flowTitle"),
  flowSummary: document.querySelector("#flowSummary"),
  flowList: document.querySelector("#flowList"),
  hideFlowButton: document.querySelector("#hideFlowButton"),
  mintDialog: document.querySelector("#mintDialog"),
  closeMintButton: document.querySelector("#closeMintButton"),
  snapshotPreview: document.querySelector("#snapshotPreview"),
  snapshotSeed: document.querySelector("#snapshotSeed"),
  snapshotStats: document.querySelector("#snapshotStats"),
  snapshotHash: document.querySelector("#snapshotHash"),
  mintStatus: document.querySelector("#mintStatus"),
  downloadReportButton: document.querySelector("#downloadReportButton"),
  downloadSnapshotButton: document.querySelector("#downloadSnapshotButton"),
  uploadWalrusButton: document.querySelector("#uploadWalrusButton"),
  confirmMintButton: document.querySelector("#confirmMintButton"),
};

function shortAddress(address) {
  if (!address) return "";
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

function txUrl(txDigest) {
  return `${EXPLORER_BASE_URL}/txblock/${encodeURIComponent(txDigest)}`;
}

function accountUrl(address) {
  return `${EXPLORER_BASE_URL}/account/${encodeURIComponent(address)}`;
}

function testnetObjectUrl(objectId) {
  return `${EXPLORER_BASE_URL}/object/${encodeURIComponent(objectId)}?network=testnet`;
}

function setAuthStatus(message, state = "") {
  els.authStatus.textContent = message;
  els.authStatus.className = `auth-status ${state}`.trim();
}

function storedAuthSession() {
  try {
    const value = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    if (!value?.token || !value?.address || Date.now() > Number(value.expiresAt || 0)) return null;
    return value;
  } catch {
    return null;
  }
}

function saveAuthSession(session) {
  authSession = session;
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  renderAuthState();
}

function clearAuthSession() {
  authSession = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  mySnapshots = [];
  renderAuthState();
}

function authHeaders() {
  return authSession?.token ? { authorization: `Bearer ${authSession.token}` } : {};
}

function setWalletDropdownOpen(open) {
  walletDropdownOpen = Boolean(open);
  els.walletDropdown.hidden = !walletDropdownOpen;
  els.walletButton.setAttribute("aria-expanded", String(walletDropdownOpen));
}

function closeWalletDropdown() {
  setWalletDropdownOpen(false);
}

function renderAuthState() {
  if (authSession?.address) {
    els.walletButton.textContent = shortAddress(authSession.address);
    els.walletButton.title = authSession.address;
    els.signOutButton.hidden = false;
    setAuthStatus("Signed in. Walrus uploads will be saved to My Snapshots.", "success");
  } else {
    els.walletButton.textContent = "Connect Wallet";
    els.walletButton.removeAttribute("title");
    els.signOutButton.hidden = true;
    closeWalletDropdown();
    setAuthStatus("Connect wallet to save Walrus snapshots.");
  }
  renderSnapshotList();
}

function snapshotTime(record) {
  return record.uploaded_at || (record.created_at_ms ? new Date(Number(record.created_at_ms)).toISOString() : "");
}

function recordDisplayTime(record) {
  const value = snapshotTime(record);
  if (!value) return "No time";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? reportDate(timestamp) : "No time";
}

function recordShortQuilt(record) {
  return record.quilt_id ? shortAddress(record.quilt_id) : "No quilt";
}

function stopSnapshotClick(event) {
  event.stopPropagation();
}

async function restoreSnapshotRecord(record) {
  if (!record?.snapshot_url) return;
  const confirmed = window.confirm("Restore this snapshot to the workspace? Current unsaved graph state will be replaced.");
  if (!confirmed) return;

  setAuthStatus("Restoring snapshot from Walrus...");
  try {
    const response = await fetch(`/api/walrus/read-json?url=${encodeURIComponent(record.snapshot_url)}`);
    const snapshot = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(snapshot.error || "Could not read snapshot from Walrus.");
    restoreCaseSnapshot(snapshot, record);
    setAuthStatus("Snapshot restored to workspace.", "success");
    closeWalletDropdown();
  } catch (error) {
    setAuthStatus(error.message, "error");
  }
}

function snapshotNodeToGraphNode(node, seedAddress) {
  const id = node.id || node.address;
  const address = node.address || id;
  const labels = normalizeNodeLabels(id, node.labels || []);
  if (id === seedAddress && !labels.includes("seed")) labels.push("seed");
  return {
    id,
    address,
    shortAddress: node.shortAddress || shortAddress(address),
    labels,
  };
}

function snapshotItemToEdge(item, index) {
  return {
    id: `snapshot:${item.txDigest || index}:${item.coinType || "unknown"}:${item.from}:${item.to}:${index}`,
    from: item.from,
    to: item.to,
    coinType: item.coinType || "unknown",
    coinSymbol: item.coinSymbol || coinSymbol(item.coinType || "unknown"),
    coinDecimals: item.coinDecimals,
    amount: String(item.amount ?? "0"),
    txDigest: item.txDigest || `snapshot-${index}`,
    timestampMs: item.timestampMs,
    confidence: item.confidence || "snapshot",
  };
}

function snapshotFlowToEdges(flow, offset) {
  const items = flow.items?.length ? flow.items : [{
    txDigest: (flow.txDigests || [])[0],
    from: flow.from,
    to: flow.to,
    coinType: flow.coinType || "unknown",
    coinSymbol: flow.coinSymbol,
    amount: flow.amount || "0",
  }];
  return items.map((item, index) => snapshotItemToEdge(item, offset + index));
}

function snapshotTransactions(edges) {
  const byDigest = new Map();
  for (const edge of edges) {
    if (!edge.txDigest || byDigest.has(edge.txDigest)) continue;
    byDigest.set(edge.txDigest, {
      digest: edge.txDigest,
      timestampMs: edge.timestampMs,
      status: "snapshot",
      balanceChanges: [],
      objectChanges: [],
      events: [],
    });
  }
  return Array.from(byDigest.values()).sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0));
}

function restoreCaseSnapshot(snapshot, record = {}) {
  if (snapshot?.kind !== "sui-caseflow/evidence-snapshot") throw new Error("This Walrus file is not a Sui CaseFlow snapshot.");
  if (!isSuiAddress(snapshot.seedAddress)) throw new Error("Snapshot seed address is invalid.");
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.flows)) throw new Error("Snapshot graph data is incomplete.");

  pushUndoState();
  const seedAddress = snapshot.seedAddress;
  const nodes = snapshot.nodes.map((node) => snapshotNodeToGraphNode(node, seedAddress));
  const edges = snapshot.flows.flatMap((flow, flowIndex) => snapshotFlowToEdges(flow, flowIndex * 1000));
  const transactions = snapshotTransactions(edges);

  trace = {
    seedAddress,
    txCount: transactions.length,
    hasNextPage: false,
    restoredFromSnapshot: true,
    restoredRecord: record,
    transactions,
    probableEdges: edges,
    graphSnapshot: {
      seedAddress,
      generatedAt: new Date(snapshot.createdAtMs || Date.now()).toISOString(),
      nodes,
      edges,
      timeline: transactions.map((tx) => ({
        id: tx.digest,
        txDigest: tx.digest,
        timestampMs: tx.timestampMs,
        status: tx.status,
        edgeCount: edges.filter((edge) => edge.txDigest === tx.digest).length,
      })),
    },
  };

  selectedNodeId = seedAddress;
  selectedFlowKey = null;
  resetHiddenItems();
  resetExpandedNodes();
  resetGraphLayout();
  dustFilterEnabled = Boolean(snapshot.filters?.dustFilterEnabled);
  hydrateLabels();

  for (const node of snapshot.nodes) {
    if (node.position) manualPositions.set(node.id || node.address, cloneValue(node.position));
  }
  initializeLayoutLineage(trace.graphSnapshot);
  viewportState = cloneValue(snapshot.viewport) || null;
  expandedNodeIds.add(seedAddress);
  els.addressInput.value = seedAddress;
  render();
}

function renderSnapshotList() {
  els.snapshotList.textContent = "";
  if (!authSession?.address) {
    els.snapshotList.textContent = "Connect wallet to load snapshots.";
    return;
  }
  if (!mySnapshots.length) {
    els.snapshotList.textContent = "No saved snapshots yet.";
    return;
  }

  for (const record of mySnapshots.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "snapshot-item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.addEventListener("click", () => restoreSnapshotRecord(record));
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      restoreSnapshotRecord(record);
    });

    const title = document.createElement("strong");
    title.textContent = shortAddress(record.seed_address || record.quilt_id || "snapshot");

    const meta = document.createElement("span");
    meta.textContent = `${record.tx_count || 0} txs · ${record.visible_node_count || 0} nodes · ${record.visible_flow_count || 0} flows`;

    const submeta = document.createElement("span");
    submeta.textContent = `${recordDisplayTime(record)} · quilt ${recordShortQuilt(record)}`;

    const hint = document.createElement("span");
    hint.className = "snapshot-restore-hint";
    hint.textContent = "Click to restore workspace";

    item.append(title, meta, submeta, hint);
    els.snapshotList.append(item);
  }
}

async function loadMySnapshots() {
  if (!authSession?.token) return;
  try {
    const response = await fetch("/api/snapshots", { headers: authHeaders() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load snapshots.");
    mySnapshots = result.snapshots || [];
    renderSnapshotList();
  } catch (error) {
    mySnapshots = [];
    renderSnapshotList();
    setAuthStatus(error.message, "error");
  }
}

async function signInWithWallet() {
  if (authSession?.address) {
    setWalletDropdownOpen(true);
    return;
  }

  els.walletButton.disabled = true;
  setAuthStatus("Opening wallet for sign-in...");
  try {
    const nonceResponse = await fetch("/api/auth/nonce", { method: "POST" });
    const nonceResult = await nonceResponse.json().catch(() => ({}));
    if (!nonceResponse.ok) throw new Error(nonceResult.error || "Could not start wallet sign-in.");

    const { signInWithSuiWallet } = await import("./src/wallet-auth.js");
    const signed = await signInWithSuiWallet({ message: nonceResult.message });

    const verifyResponse = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: signed.address,
        nonce: nonceResult.nonce,
        bytes: signed.bytes,
        signature: signed.signature,
      }),
    });
    const verifyResult = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok) throw new Error(verifyResult.error || "Wallet sign-in failed.");

    saveAuthSession(verifyResult);
    await loadMySnapshots();
    setWalletDropdownOpen(true);
  } catch (error) {
    setAuthStatus(error.message, "error");
    setWalletDropdownOpen(true);
  } finally {
    els.walletButton.disabled = false;
  }
}

function signOutWallet() {
  clearAuthSession();
  closeWalletDropdown();
}

function toggleWalletMenu(event) {
  event.stopPropagation();
  if (!authSession?.address) {
    signInWithWallet();
    return;
  }
  setWalletDropdownOpen(!walletDropdownOpen);
}

function closeWalletMenuOnOutsideClick(event) {
  if (!walletDropdownOpen || els.walletMenu.contains(event.target)) return;
  closeWalletDropdown();
}

function initializeAuth() {
  authSession = storedAuthSession();
  renderAuthState();
  if (authSession?.token) loadMySnapshots();
}

function isSuiAddress(address) {
  return /^0x[a-fA-F0-9]{64}$/.test(address || "");
}

function coinSymbol(coinType) {
  return coinType.split("::").at(-1) || coinType;
}

function fallbackDecimals(coinType, symbol) {
  const normalizedSymbol = symbol?.toUpperCase();
  if (coinType === "0x2::sui::SUI" || normalizedSymbol === "SUI") return 9;
  if (normalizedSymbol === "MIST") return 0;
  if (normalizedSymbol === "USDC" || normalizedSymbol === "USDT") return 6;
  return 9;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (abs > 0 && abs < 0.01) return value.toPrecision(3);
  return value.toLocaleString("en", {
    maximumFractionDigits: 4,
  });
}

function displayAmount(rawAmount, decimals, coinType, symbol) {
  const resolvedDecimals = Number.isInteger(decimals) ? decimals : fallbackDecimals(coinType, symbol);
  if (!Number.isInteger(resolvedDecimals)) return compactNumber(Number(rawAmount));

  const raw = BigInt(rawAmount);
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  const divisor = 10n ** BigInt(resolvedDecimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const trimmedFraction = fraction
    .toString()
    .padStart(resolvedDecimals, "0")
    .replace(/0+$/, "")
    .slice(0, 4);

  if (whole >= 1000n) return compactNumber(Number(raw) / 10 ** resolvedDecimals);
  if (!trimmedFraction) return `${sign}${whole.toString()}`;
  return `${sign}${whole.toString()}.${trimmedFraction}`;
}

function displayEdgeAmount(edge) {
  if (edge.confidence === "possible" && edge.amount === "0") return "same tx";
  return displayAmount(edge.amount, edge.coinDecimals, edge.coinType, edgeSymbol(edge));
}

function edgeSymbol(edge) {
  return edge.coinSymbol || coinSymbol(edge.coinType);
}

function sameTransactionOnly(edge) {
  return edge.confidence === "possible" && edge.amount === "0";
}

function isSuiEdge(edge) {
  return edge.coinType === SUI_COIN_TYPE || edgeSymbol(edge).toUpperCase() === "SUI";
}

function isDustEdge(edge) {
  if (sameTransactionOnly(edge)) return true;
  if (edge.amount === "0") return true;
  if (!isSuiEdge(edge)) return false;

  try {
    const amount = BigInt(edge.amount);
    const abs = amount < 0n ? -amount : amount;
    return abs < DUST_SUI_THRESHOLD;
  } catch {
    return false;
  }
}

function assetKey(edge) {
  return [
    edge.coinType,
    edge.coinSymbol || "",
    edge.coinDecimals ?? "",
  ].join("|");
}

function edgeLabel(edge) {
  if (edge.isBidirectional) {
    const txCount = edge.txCount || new Set((edge.items || []).map((item) => item.txDigest)).size;
    return `2 directions / ${txCount} tx${txCount === 1 ? "" : "s"}`;
  }
  if (sameTransactionOnly(edge)) return "same tx";
  if (edge.assetCount > 1) {
    const txSuffix = edge.txCount > 1 ? ` / ${edge.txCount} txs` : "";
    return `${edge.assetCount} assets${txSuffix}`;
  }

  const suffix = edge.txCount > 1 ? ` / ${edge.txCount} txs` : "";
  return `${displayEdgeAmount(edge)} ${edgeSymbol(edge)}${suffix}`;
}

function aggregateDisplayEdges(edges) {
  const byKey = new Map();

  for (const edge of edges) {
    const key = [edge.from, edge.to].join("|");
    const existing = byKey.get(key);

    if (existing) {
      const itemKey = edgeMergeKey(edge);
      if (existing.itemKeys.has(itemKey)) continue;
      existing.itemKeys.add(itemKey);
      if (existing.coinType === edge.coinType && !sameTransactionOnly(existing) && !sameTransactionOnly(edge)) {
        existing.amount = (BigInt(existing.amount) + BigInt(edge.amount)).toString();
      }
      existing.txDigests.push(edge.txDigest);
      existing.items.push(edge);
      existing.assetKeys.add(assetKey(edge));
      existing.txDigestKeys.add(edge.txDigest);
      existing.txCount = existing.txDigestKeys.size;
      existing.assetCount = existing.assetKeys.size;
    } else {
      byKey.set(key, {
        ...edge,
        key,
        assetKeys: new Set([assetKey(edge)]),
        txDigestKeys: new Set([edge.txDigest]),
        itemKeys: new Set([edgeMergeKey(edge)]),
        assetCount: 1,
        txCount: 1,
        txDigests: [edge.txDigest],
        items: [edge],
      });
    }
  }

  return Array.from(byKey.values()).map((edge) => {
    const { assetKeys, txDigestKeys, itemKeys, ...rest } = edge;
    return rest;
  });
}

function displayEdgePairKey(edge) {
  return [edge.from, edge.to].sort().join("|");
}

function edgeDirectionKey(edge) {
  return `${edge.from}->${edge.to}`;
}

function isBidirectionalGroup(group) {
  return new Set(group.map(edgeDirectionKey)).size > 1;
}

function withDisplayLanes(edges) {
  const groups = new Map();

  for (const edge of edges) {
    const key = displayEdgePairKey(edge);
    const group = groups.get(key) || [];
    group.push(edge);
    groups.set(key, group);
  }

  return edges.map((edge) => {
    const group = groups.get(displayEdgePairKey(edge)) || [edge];
    const sortedGroup = [...group].sort((a, b) => a.key.localeCompare(b.key));
    const index = sortedGroup.findIndex((item) => item.key === edge.key);
    const signedOffset = group.length > 1 ? (index - (group.length - 1) / 2) * 140 : 0;
    return {
      ...edge,
      displayLaneCount: group.length,
      displayOffset: signedOffset,
    };
  });
}

function visualDisplayEdges(edges) {
  const byPair = new Map();

  for (const edge of edges) {
    const key = displayEdgePairKey(edge);
    const group = byPair.get(key) || [];
    group.push(edge);
    byPair.set(key, group);
  }

  const visualEdges = [];
  for (const [pairKey, group] of byPair.entries()) {
    if (!isBidirectionalGroup(group)) {
      visualEdges.push(...group);
      continue;
    }

    const items = group.flatMap((edge) => edge.items || [edge]);
    const txDigestKeys = new Set(items.map((item) => item.txDigest));
    const assetKeys = new Set(items.map(assetKey));
    const [left, right] = pairKey.split("|");
    const first = group[0];

    visualEdges.push({
      ...first,
      key: `bidirectional:${pairKey}`,
      from: left,
      to: right,
      amount: "0",
      coinType: first.coinType,
      coinSymbol: first.coinSymbol,
      coinDecimals: first.coinDecimals,
      items,
      txDigests: Array.from(txDigestKeys),
      txCount: txDigestKeys.size,
      assetCount: assetKeys.size,
      directionCount: 2,
      isBidirectional: true,
      displayLaneCount: 1,
      displayOffset: 0,
    });
  }

  return visualEdges;
}

function edgeId(edge) {
  return edge.id || `${edge.txDigest}:${edge.coinType}:${edge.from}:${edge.to}`;
}

function edgeMergeKey(edge) {
  return [
    edge.txDigest,
    edge.coinType,
    edge.from,
    edge.to,
  ].join("|");
}

function edgePriority(edge) {
  if (edge.id?.startsWith("backfill:")) return 0;
  if (edge.confidence === "possible") return 1;
  return 2;
}

function mergeEdgeIntoMap(edgeMap, edge) {
  const key = edgeMergeKey(edge);
  const existing = edgeMap.get(key);
  if (!existing || edgePriority(edge) >= edgePriority(existing)) {
    edgeMap.set(key, edge);
  }
}

function visibleEdges(graph) {
  return graph.edges.filter((edge) => {
    if (hiddenEdgeIds.has(edgeId(edge))) return false;
    if (hiddenNodeIds.has(edge.from) || hiddenNodeIds.has(edge.to)) return false;
    if (dustFilterEnabled && isDustEdge(edge)) return false;
    return true;
  });
}

function formatDate(timestampMs) {
  if (!timestampMs) return "No timestamp";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(timestampMs)));
}

function nodeLabels(node) {
  const stored = labelState.get(node.id) || [];
  return normalizeNodeLabels(node.id, [...(node.labels || []), ...stored]);
}

function normalizeNodeLabels(nodeId, labels) {
  const caseSeed = trace?.graphSnapshot?.seedAddress || trace?.seedAddress;
  return Array.from(new Set(labels)).filter((label) => label !== "seed" || nodeId === caseSeed);
}

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function mapToEntries(map) {
  return Array.from(map.entries()).map(([key, value]) => [key, cloneValue(value)]);
}

function restoreMap(map, entries) {
  map.clear();
  for (const [key, value] of entries || []) {
    map.set(key, cloneValue(value));
  }
}

function captureState() {
  return {
    trace: cloneValue(trace),
    selectedNodeId,
    selectedFlowKey,
    viewportState: cloneValue(viewportState),
    dustFilterEnabled,
    manualPositions: mapToEntries(manualPositions),
    labelState: mapToEntries(labelState),
    hiddenNodeIds: Array.from(hiddenNodeIds),
    hiddenEdgeIds: Array.from(hiddenEdgeIds),
    expandedNodeIds: Array.from(expandedNodeIds),
    nodeDepthById: mapToEntries(nodeDepthById),
    nodeParentById: mapToEntries(nodeParentById),
  };
}

function restoreState(snapshot) {
  trace = cloneValue(snapshot.trace);
  selectedNodeId = snapshot.selectedNodeId;
  selectedFlowKey = snapshot.selectedFlowKey;
  viewportState = cloneValue(snapshot.viewportState);
  dustFilterEnabled = Boolean(snapshot.dustFilterEnabled);

  restoreMap(manualPositions, snapshot.manualPositions);
  restoreMap(labelState, snapshot.labelState);
  restoreMap(nodeDepthById, snapshot.nodeDepthById);
  restoreMap(nodeParentById, snapshot.nodeParentById);

  hiddenNodeIds.clear();
  for (const nodeId of snapshot.hiddenNodeIds || []) hiddenNodeIds.add(nodeId);

  hiddenEdgeIds.clear();
  for (const edgeIdValue of snapshot.hiddenEdgeIds || []) hiddenEdgeIds.add(edgeIdValue);

  expandedNodeIds.clear();
  for (const nodeId of snapshot.expandedNodeIds || []) expandedNodeIds.add(nodeId);
}

function pushUndoState() {
  if (!trace) return false;
  undoStack.push(captureState());
  if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  updateUndoButton();
  return true;
}

function discardLastUndoState() {
  undoStack.pop();
  updateUndoButton();
}

function undoLastAction() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  restoreState(snapshot);
  updateUndoButton();
  render();
}

function updateUndoButton() {
  els.undoButton.disabled = undoStack.length === 0;
}

async function loadTrace() {
  pushUndoState();
  const response = await fetch("./data/sample-trace.json");
  if (!response.ok) throw new Error("Could not load sample trace");
  trace = await response.json();
  selectedNodeId = trace.seedAddress;
  selectedFlowKey = null;
  resetHiddenItems();
  resetGraphLayout();
  resetGraphViewport();
  resetExpandedNodes();
  expandedNodeIds.add(trace.seedAddress);
  initializeLayoutLineage(trace.graphSnapshot);
  els.addressInput.value = trace.seedAddress;
  hydrateLabels();
  render();
}

async function traceAddress() {
  const address = els.addressInput.value.trim();
  if (!address) return;
  const limit = els.limitSelect.value;

  const undoPushed = pushUndoState();
  setLoading(true);
  try {
    const response = await fetch(`/api/trace?address=${encodeURIComponent(address)}&network=mainnet&limit=${encodeURIComponent(limit)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Trace failed");

    trace = payload;
    selectedNodeId = trace.seedAddress;
    selectedFlowKey = null;
    resetHiddenItems();
    resetGraphLayout();
    resetGraphViewport();
    resetExpandedNodes();
    expandedNodeIds.add(trace.seedAddress);
    initializeLayoutLineage(trace.graphSnapshot);
    hydrateLabels();
    render();
  } catch (error) {
    if (undoPushed) discardLastUndoState();
    els.caseTitle.textContent = "Trace failed";
    els.flowTitle.textContent = "Trace failed";
    els.flowSummary.textContent = error.message;
    els.flowList.innerHTML = "";
  } finally {
    setLoading(false);
  }
}

async function expandSelectedNode() {
  if (!trace || !selectedNodeId || selectedNodeId.startsWith("protocol:")) return;

  const address = selectedNodeId;
  if (expandedNodeIds.has(address)) {
    selectedFlowKey = null;
    render();
    return;
  }

  const limit = els.limitSelect.value;

  const undoPushed = pushUndoState();
  setLoading(true, "Expanding");
  try {
    const response = await fetch(`/api/trace?address=${encodeURIComponent(address)}&network=mainnet&limit=${encodeURIComponent(limit)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Expand failed");

    mergeTrace(payload);
    applyExpansionLineage(address, payload);
    expandedNodeIds.add(address);
    selectedNodeId = address;
    selectedFlowKey = null;
    hydrateLabels();
    render();
  } catch (error) {
    if (undoPushed) discardLastUndoState();
    els.flowTitle.textContent = "Expand failed";
    els.flowSummary.textContent = error.message;
    els.flowList.innerHTML = "";
  } finally {
    setLoading(false);
  }
}

function mergeTrace(nextTrace) {
  const graph = trace.graphSnapshot;
  const nextGraph = nextTrace.graphSnapshot;
  const existingNodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeMap = new Map();
  const txMap = new Map((trace.transactions || []).map((tx) => [tx.digest, tx]));
  const timelineMap = new Map((graph.timeline || []).map((item) => [item.id, item]));

  for (const edge of graph.edges) {
    mergeEdgeIntoMap(edgeMap, edge);
  }

  for (const node of nextGraph.nodes) {
    const existing = nodeMap.get(node.id);
    const incomingLabels = normalizeNodeLabels(node.id, node.labels || []);
    if (existing) {
      existing.labels = normalizeNodeLabels(node.id, [...(existing.labels || []), ...incomingLabels]);
      existing.stats = {
        txCount: (existing.stats?.txCount || 0) + (node.stats?.txCount || 0),
        inboundCount: (existing.stats?.inboundCount || 0) + (node.stats?.inboundCount || 0),
        outboundCount: (existing.stats?.outboundCount || 0) + (node.stats?.outboundCount || 0),
      };
    } else {
      nodeMap.set(node.id, {
        ...node,
        labels: incomingLabels,
      });
    }
  }

  for (const edge of nextGraph.edges) {
    mergeEdgeIntoMap(edgeMap, edge);
  }

  for (const edge of inferBackfillEdges(nextTrace, existingNodeIds)) {
    mergeEdgeIntoMap(edgeMap, edge);
  }

  for (const tx of nextTrace.transactions || []) {
    txMap.set(tx.digest, tx);
  }

  for (const item of nextGraph.timeline || []) {
    timelineMap.set(item.id, item);
  }

  trace = {
    ...trace,
    txCount: txMap.size,
    hasNextPage: Boolean(trace.hasNextPage || nextTrace.hasNextPage),
    transactions: Array.from(txMap.values())
      .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0)),
    probableEdges: Array.from(edgeMap.values()),
    graphSnapshot: {
      ...graph,
      generatedAt: new Date().toISOString(),
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      timeline: Array.from(timelineMap.values())
        .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0)),
    },
  };
}

function inferBackfillEdges(nextTrace, existingNodeIds) {
  const addedAddress = nextTrace.seedAddress;
  const edges = [];
  const seen = new Set();

  for (const tx of nextTrace.transactions || []) {
    const changes = tx.balanceChanges || [];
    const addedChanges = changes.filter((change) => change.owner === addedAddress);
    const existingChanges = changes.filter((change) => existingNodeIds.has(change.owner) && change.owner !== addedAddress);

    if (addedChanges.length === 0 || existingChanges.length === 0) continue;

    const directEdges = inferDirectBackfillEdges({ tx, addedAddress, addedChanges, existingChanges });
    const candidateEdges = directEdges.length > 0
      ? directEdges
      : inferSameTransactionLinks({ tx, addedAddress, existingChanges });

    for (const edge of candidateEdges) {
      const key = edgeMergeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }

  return edges.slice(0, 25);
}

function inferDirectBackfillEdges({ tx, addedAddress, addedChanges, existingChanges }) {
  const edges = [];

  for (const addedChange of addedChanges) {
    for (const existingChange of existingChanges) {
      if (addedChange.coinType !== existingChange.coinType) continue;

      const addedAmount = BigInt(addedChange.amount);
      const existingAmount = BigInt(existingChange.amount);
      if (addedAmount === 0n || existingAmount === 0n) continue;
      if ((addedAmount > 0n && existingAmount > 0n) || (addedAmount < 0n && existingAmount < 0n)) continue;

      const addedIsSender = addedAmount < 0n;
      const amount = (addedIsSender ? -addedAmount : -existingAmount).toString();
      edges.push({
        id: `backfill:${tx.digest}:${addedChange.coinType}:${addedChange.owner}:${existingChange.owner}`,
        from: addedIsSender ? addedAddress : existingChange.owner,
        to: addedIsSender ? existingChange.owner : addedAddress,
        coinType: addedChange.coinType,
        coinSymbol: addedChange.coinSymbol,
        coinDecimals: addedChange.coinDecimals,
        amount,
        txDigest: tx.digest,
        timestampMs: tx.timestampMs,
        confidence: "probable",
        reason: "backfilled from a shared transaction between added address and existing graph node",
      });
    }
  }

  return edges;
}

function inferSameTransactionLinks({ tx, addedAddress, existingChanges }) {
  return existingChanges.slice(0, 3).map((change) => ({
    id: `same-tx:${tx.digest}:${addedAddress}:${change.owner}`,
    from: addedAddress,
    to: change.owner,
    coinType: "same_tx",
    coinSymbol: "same tx",
    coinDecimals: 0,
    amount: "0",
    txDigest: tx.digest,
    timestampMs: tx.timestampMs,
    confidence: "possible",
    reason: "added address and existing graph node both appear in this transaction, but token attribution is unclear",
  }));
}

function setLoading(isLoading, label = "Tracing") {
  els.traceButton.disabled = isLoading;
  els.expandNodeButton.disabled = isLoading;
  els.loadSampleButton.disabled = isLoading;
  els.dustFilterButton.disabled = isLoading;
  els.traceButton.textContent = isLoading ? label : "Trace";
  els.expandNodeButton.textContent = isLoading && label === "Expanding" ? "Expanding" : "Expand node";
  if (!isLoading && trace?.graphSnapshot) renderSelected(trace.graphSnapshot);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function hydrateLabels() {
  labelState.clear();
  for (const node of trace.graphSnapshot.nodes) {
    const labels = normalizeNodeLabels(node.id, node.labels || []);
    node.labels = labels;
    labelState.set(node.id, labels);
  }
}

function resetGraphLayout() {
  manualPositions.clear();
  nodeDepthById.clear();
  nodeParentById.clear();
}

function resetGraphViewport() {
  viewportState = null;
}

function resetHiddenItems() {
  hiddenNodeIds.clear();
  hiddenEdgeIds.clear();
}

function resetExpandedNodes() {
  expandedNodeIds.clear();
}

function connectedNodeIds(graph) {
  const ids = new Set([graph.seedAddress]);
  for (const edge of visibleEdges(graph)) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  return ids;
}

function visibleGraphNodes(graph) {
  const ids = connectedNodeIds(graph);
  return graph.nodes.filter((node) => ids.has(node.id));
}

function initializeLayoutLineage(graph) {
  nodeDepthById.clear();
  nodeParentById.clear();
  nodeDepthById.set(graph.seedAddress, 0);

  const adjacency = new Map();
  for (const edge of visibleEdges(graph)) {
    if (edge.from === graph.seedAddress) {
      const state = adjacency.get(edge.to) || { inbound: false, outbound: false };
      state.outbound = true;
      adjacency.set(edge.to, state);
    }

    if (edge.to === graph.seedAddress) {
      const state = adjacency.get(edge.from) || { inbound: false, outbound: false };
      state.inbound = true;
      adjacency.set(edge.from, state);
    }
  }

  for (const [nodeId, state] of adjacency.entries()) {
    if (state.inbound && state.outbound) {
      nodeParentById.set(nodeId, graph.seedAddress);
      continue;
    }

    nodeDepthById.set(nodeId, state.outbound ? 1 : -1);
    nodeParentById.set(nodeId, graph.seedAddress);
  }
}

function lineageDirection(nodeId, graph) {
  if (nodeId === graph.seedAddress) return 1;
  const depth = nodeDepthById.get(nodeId);
  if (depth) return Math.sign(depth);

  for (const edge of visibleEdges(graph)) {
    if (edge.from === graph.seedAddress && edge.to === nodeId) return 1;
    if (edge.to === graph.seedAddress && edge.from === nodeId) return -1;
  }

  return 1;
}

function applyExpansionLineage(parentId, nextTrace) {
  if (!trace?.graphSnapshot || parentId.startsWith("protocol:")) return;
  const graph = trace.graphSnapshot;
  const parentDepth = nodeDepthById.get(parentId) ?? lineageDirection(parentId, graph);
  const direction = parentDepth < 0 ? -1 : 1;

  nodeDepthById.set(parentId, parentDepth);

  const nextNodeIds = new Set((nextTrace.graphSnapshot?.nodes || []).map((node) => node.id));
  const adjacency = new Map();

  for (const edge of nextTrace.graphSnapshot?.edges || []) {
    if (!nextNodeIds.has(edge.from) || !nextNodeIds.has(edge.to)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }

  const visited = new Set([parentId]);
  const queue = [{ nodeId: parentId, hop: 0 }];

  while (queue.length) {
    const current = queue.shift();
    for (const nodeId of adjacency.get(current.nodeId) || []) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const nextHop = current.hop + 1;
      const isRealAddress = nodeId !== graph.seedAddress && !nodeId.startsWith("protocol:");
      if (isRealAddress && !nodeDepthById.has(nodeId)) {
        nodeDepthById.set(nodeId, parentDepth + direction * nextHop);
        nodeParentById.set(nodeId, current.nodeId);
      }

      queue.push({ nodeId, hop: nextHop });
    }
  }
}

function render() {
  const graph = trace.graphSnapshot;
  const edges = visibleEdges(graph);
  els.nodeCount.textContent = visibleGraphNodes(graph).length;
  els.edgeCount.textContent = edges.length;
  els.txCount.textContent = trace.txCount;
  els.caseTitle.textContent = shortAddress(trace.seedAddress);
  renderHistoryHint();

  renderGraph(graph);
  renderLabelList(graph);
  renderSelected(graph);
  renderFlowDetails(graph);
  renderDustFilterButton();
  updateUndoButton();
  els.mintSnapshotButton.disabled = false;
}

function renderDustFilterButton() {
  els.dustFilterButton.textContent = dustFilterEnabled ? "Dust hidden" : "Hide dust";
  els.dustFilterButton.classList.toggle("active", dustFilterEnabled);
  els.dustFilterButton.setAttribute("aria-pressed", String(dustFilterEnabled));
}

function renderHistoryHint() {
  if (!trace?.hasNextPage) {
    els.historyHint.textContent = "";
    return;
  }

  const limit = Number(els.limitSelect.value);
  if (limit < 50) {
    els.historyHint.textContent = "More history exists. Switch to Last 50 or 100 to include older activity.";
  } else if (limit < 100) {
    els.historyHint.textContent = "More history exists. Switch to Last 100 to include older activity.";
  } else {
    els.historyHint.textContent = "More history exists beyond the current 100 transaction window.";
  }
}

function layoutGraph(graph) {
  const width = Math.max(740, els.flowGraph.clientWidth || 740);
  const height = Math.max(540, els.flowGraph.clientHeight || 540);
  const seed = graph.seedAddress;
  const peers = visibleGraphNodes(graph).filter((node) => node.id !== seed);
  const edges = visibleEdges(graph);
  const positions = new Map();
  const columnGap = 220;
  const centerX = width / 2;

  positions.set(seed, { x: centerX, y: height / 2 });

  const columns = new Map();
  const topPeers = [];
  const fallback = [];

  for (const node of peers) {
    let depth = nodeDepthById.get(node.id);
    if (!depth) {
      const relation = seedAdjacentRelation(node.id, seed, edges);
      if (relation === "bidirectional") {
        topPeers.push(node);
        continue;
      }

      depth = relation === "outbound" ? 1 : relation === "inbound" ? -1 : 0;
      if (depth) nodeDepthById.set(node.id, depth);
    }

    if (depth) {
      const existing = columns.get(depth) || [];
      existing.push(node);
      columns.set(depth, existing);
    } else {
      fallback.push(node);
    }
  }

  for (const [depth, nodes] of columns.entries()) {
    placeColumn(nodes, centerX + depth * columnGap, height);
  }

  placeTopRow(topPeers, centerX, height);
  placeColumn(fallback, centerX, height, height * 0.18);

  function seedAdjacentRelation(nodeId, seedAddress, graphEdges) {
    const outbound = graphEdges.some((edge) => edge.from === seedAddress && edge.to === nodeId);
    const inbound = graphEdges.some((edge) => edge.to === seedAddress && edge.from === nodeId);
    if (outbound && inbound) return "bidirectional";
    if (outbound) return "outbound";
    if (inbound) return "inbound";
    return "none";
  }

  function placeColumn(nodes, x, surfaceHeight, startY) {
    const gap = Math.min(150, surfaceHeight / Math.max(nodes.length + 1, 2));
    const top = startY ?? (surfaceHeight - gap * (nodes.length - 1)) / 2;
    nodes.forEach((node, index) => positions.set(node.id, { x, y: top + index * gap }));
  }

  function placeTopRow(nodes, x, surfaceHeight) {
    const gap = 150;
    const left = x - (gap * (nodes.length - 1)) / 2;
    const y = Math.max(86, surfaceHeight / 2 - 190);
    nodes.forEach((node, index) => positions.set(node.id, { x: left + index * gap, y }));
  }

  for (const [nodeId, position] of manualPositions.entries()) {
    if (positions.has(nodeId)) positions.set(nodeId, position);
  }

  return { width, height, positions };
}

function edgeGeometry(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return null;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const hasParallelFlow = !edge.isBidirectional && edge.displayLaneCount > 1;
  const curve = hasParallelFlow ? 0 : Math.max(-100, Math.min(100, dx * 0.18));
  const offset = edge.displayOffset || 0;
  const normalX = hasParallelFlow ? (-dy / distance) * offset : 0;
  const normalY = hasParallelFlow ? (dx / distance) * offset : 0;
  const midX = (from.x + to.x) / 2 + normalX;
  const midY = (from.y + to.y) / 2 + normalY;
  const path = edge.isBidirectional
    ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
    : hasParallelFlow
    ? `M ${from.x} ${from.y} Q ${midX} ${midY}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`;

  return { from, to, midX, midY, path };
}

function visualLabelPosition(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return { x: 0, y: 0 };

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const normalSign = normalY > 0 ? -1 : 1;
  const labelGap = 14;

  return {
    x: (from.x + to.x) / 2 + normalX * normalSign * labelGap,
    y: (from.y + to.y) / 2 + normalY * normalSign * labelGap,
  };
}

function renderGraph(graph) {
  const { width, height, positions } = layoutGraph(graph);
  const displayEdges = visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(visibleEdges(graph))));
  currentPositions = positions;
  if (!viewportState) resetViewportToPositions(width, height, positions);
  applyViewport();
  els.flowGraph.innerHTML = "";

  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: "8",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  marker.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#146c94" }));
  defs.append(marker);
  els.flowGraph.append(defs);

  for (const edge of displayEdges) {
    const geometry = edgeGeometry(edge, positions);
    if (!geometry) continue;
    const line = svgEl("path", {
      class: `edge-line ${edgeDirectionClass(edge, graph.seedAddress)} ${edge.key === selectedFlowKey ? "selected" : ""}`,
      d: geometry.path,
      role: "button",
      tabindex: "0",
    });
    line.addEventListener("click", () => selectFlow(edge.key));
    els.flowGraph.append(line);
  }

  for (const edge of displayEdges) {
    const labelPosition = visualLabelPosition(edge, positions);
    const label = svgEl("text", {
      class: `edge-label ${edge.key === selectedFlowKey ? "selected" : ""}`,
      x: labelPosition.x,
      y: labelPosition.y,
      "text-anchor": "middle",
      role: "button",
      tabindex: "0",
    });
    label.textContent = edgeLabel(edge);
    label.addEventListener("click", () => selectFlow(edge.key));
    els.flowGraph.append(label);
  }

  for (const node of visibleGraphNodes(graph)) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const group = svgEl("g", {
      class: `node ${node.id === graph.seedAddress ? "seed" : node.labels.includes("protocol") ? "protocol" : "peer"} ${node.id === selectedNodeId ? "selected" : ""}`,
      role: "button",
      tabindex: "0",
    });
    group.addEventListener("pointerdown", (event) => startNodeDrag(event, node.id));

    group.append(svgEl("circle", { cx: pos.x, cy: pos.y, r: node.id === graph.seedAddress ? 34 : 28 }));

    const name = svgEl("text", { x: pos.x, y: pos.y + 50 });
    name.textContent = node.id === graph.seedAddress ? "Seed" : node.shortAddress || shortAddress(node.address);
    group.append(name);

    const labels = nodeLabels(node).filter((label) => label !== "seed");
    if (labels.length > 0) {
      const badge = svgEl("text", { x: pos.x, y: pos.y + 68 });
      badge.textContent = labels[0];
      group.append(badge);
    }

    els.flowGraph.append(group);
  }
}

function edgeDirectionClass(edge, seedAddress) {
  if (edge.isBidirectional) return "bidirectional";
  if (edge.to === seedAddress) return "inbound";
  if (edge.from === seedAddress) return "outbound";
  return "neutral";
}

function resetViewport(width, height) {
  viewportState = {
    x: 0,
    y: 0,
    width,
    height,
    baseWidth: width,
    baseHeight: height,
  };
}

function applyViewport() {
  if (!viewportState) return;
  const { x, y, width, height } = viewportState;
  els.flowGraph.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
}

function resetCurrentViewport() {
  if (!trace) return;
  pushUndoState();
  const { width, height, positions } = layoutGraph(trace.graphSnapshot);
  resetViewportToPositions(width, height, positions);
  render();
}

function resetViewportToPositions(width, height, positions) {
  const xs = Array.from(positions.values()).map((position) => position.x);
  const ys = Array.from(positions.values()).map((position) => position.y);
  const padding = 140;
  const minX = Math.min(0, ...xs) - padding;
  const maxX = Math.max(width, ...xs) + padding;
  const minY = Math.min(0, ...ys) - padding;
  const maxY = Math.max(height, ...ys) + padding;

  viewportState = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    baseWidth: Math.max(740, els.flowGraph.clientWidth || 740),
    baseHeight: Math.max(540, els.flowGraph.clientHeight || 540),
  };
}

function zoomGraph(event) {
  if (!viewportState) return;
  event.preventDefault();

  const zoomFactor = Math.exp(event.deltaY * 0.001);
  const minWidth = viewportState.baseWidth / 4;
  const maxWidth = viewportState.baseWidth * 2;
  const nextWidth = Math.max(minWidth, Math.min(maxWidth, viewportState.width * zoomFactor));
  const nextHeight = nextWidth * (viewportState.baseHeight / viewportState.baseWidth);
  const pointer = svgPointFromEvent(event);
  const xRatio = (pointer.x - viewportState.x) / viewportState.width;
  const yRatio = (pointer.y - viewportState.y) / viewportState.height;

  viewportState = {
    ...viewportState,
    x: pointer.x - xRatio * nextWidth,
    y: pointer.y - yRatio * nextHeight,
    width: nextWidth,
    height: nextHeight,
  };
  applyViewport();
}

function isGraphBackgroundEvent(event) {
  return event.target === els.flowGraph;
}

function startGraphPan(event) {
  if (!trace || event.button !== 0 || !isGraphBackgroundEvent(event) || !viewportState) return;
  event.preventDefault();
  panState = {
    pointerStart: { x: event.clientX, y: event.clientY },
    viewportStart: { ...viewportState },
  };
  els.flowGraph.classList.add("panning");
  window.addEventListener("pointermove", panGraph);
  window.addEventListener("pointerup", stopGraphPan, { once: true });
}

function panGraph(event) {
  if (!panState || !viewportState) return;
  const clientWidth = Math.max(1, els.flowGraph.clientWidth || 1);
  const clientHeight = Math.max(1, els.flowGraph.clientHeight || 1);
  const dx = (event.clientX - panState.pointerStart.x) * (panState.viewportStart.width / clientWidth);
  const dy = (event.clientY - panState.pointerStart.y) * (panState.viewportStart.height / clientHeight);

  viewportState = {
    ...viewportState,
    x: panState.viewportStart.x - dx,
    y: panState.viewportStart.y - dy,
  };
  applyViewport();
}

function stopGraphPan() {
  window.removeEventListener("pointermove", panGraph);
  panState = null;
  els.flowGraph.classList.remove("panning");
}

function svgPointFromEvent(event) {
  const point = els.flowGraph.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(els.flowGraph.getScreenCTM().inverse());
}

function clampPosition(point) {
  const viewBox = els.flowGraph.viewBox.baseVal;
  return {
    x: Math.max(viewBox.x + 64, Math.min(viewBox.x + viewBox.width - 64, point.x)),
    y: Math.max(viewBox.y + 64, Math.min(viewBox.y + viewBox.height - 92, point.y)),
  };
}

function startNodeDrag(event, nodeId) {
  event.preventDefault();
  event.stopPropagation();
  const position = currentPositions.get(nodeId);
  if (!position) return;

  selectedNodeId = nodeId;
  selectedFlowKey = null;
  const start = svgPointFromEvent(event);
  dragState = {
    nodeId,
    pointerStart: start,
    nodeStart: position,
    didMove: false,
    undoCaptured: false,
  };

  window.addEventListener("pointermove", dragNode);
  window.addEventListener("pointerup", stopNodeDrag, { once: true });
}

function dragNode(event) {
  if (!dragState || !trace) return;

  const point = svgPointFromEvent(event);
  const dx = point.x - dragState.pointerStart.x;
  const dy = point.y - dragState.pointerStart.y;
  const moved = Math.abs(dx) + Math.abs(dy) > 3;
  if (!moved) return;
  if (moved && !dragState.undoCaptured) {
    pushUndoState();
    dragState.undoCaptured = true;
  }
  dragState.didMove = true;

  manualPositions.set(dragState.nodeId, clampPosition({
    x: dragState.nodeStart.x + dx,
    y: dragState.nodeStart.y + dy,
  }));
  selectedNodeId = dragState.nodeId;
  selectedFlowKey = null;
  renderGraph(trace.graphSnapshot);
}

function stopNodeDrag() {
  window.removeEventListener("pointermove", dragNode);
  const didMove = Boolean(dragState?.didMove);
  dragState = null;
  render();

  if (!didMove) selectNode(selectedNodeId);
}

function renderFlowDetails(graph) {
  const edge = visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(visibleEdges(graph))))
    .find((item) => item.key === selectedFlowKey);
  els.hideFlowButton.disabled = !edge;

  if (!edge) {
    els.flowTitle.textContent = "Select a flow";
    els.flowSummary.textContent = "Click a line in the graph to inspect every transaction inside that aggregated flow.";
    els.flowList.innerHTML = "";
    return;
  }

  const direction = edge.isBidirectional
    ? `${shortAddress(edge.from)} <-> ${shortAddress(edge.to)}`
    : `${shortAddress(edge.from)} -> ${shortAddress(edge.to)}`;
  els.flowTitle.textContent = edge.isBidirectional
    ? edgeLabel(edge)
    : edge.assetCount > 1
    ? `${edge.assetCount} assets`
    : edgeLabel(edge);
  els.flowSummary.textContent = `${direction} · ${edge.txCount} transaction${edge.txCount === 1 ? "" : "s"}`;
  els.flowList.innerHTML = "";

  const sortedItems = [...edge.items].sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0));
  for (const item of sortedItems) {
    const row = document.createElement("article");
    row.className = "flow-item";

    const hideButton = document.createElement("button");
    hideButton.className = "inline-close-button";
    hideButton.type = "button";
    hideButton.title = "Hide this transaction flow";
    hideButton.setAttribute("aria-label", "Hide this transaction flow");
    hideButton.textContent = "×";
    hideButton.addEventListener("click", () => hideSingleEdge(item));

    const amount = document.createElement("strong");
    amount.textContent = edge.isBidirectional
      ? `${shortAddress(item.from)} -> ${shortAddress(item.to)} · ${edgeLabel(item)}`
      : edgeLabel(item);

    const meta = document.createElement("p");
    meta.textContent = `${formatDate(item.timestampMs)} · ${shortAddress(item.txDigest)}`;

    const digest = document.createElement("a");
    digest.className = "digest-text";
    digest.href = txUrl(item.txDigest);
    digest.target = "_blank";
    digest.rel = "noreferrer";
    digest.textContent = item.txDigest;

    row.append(hideButton, amount, meta, digest);
    els.flowList.append(row);
  }
}

function renderLabelList(graph) {
  els.labelList.innerHTML = "";
  for (const node of graph.nodes) {
    const labels = nodeLabels(node);
    if (labels.length === 0) continue;

    const chip = document.createElement("button");
    chip.className = "label-chip active";
    chip.textContent = `${shortAddress(node.address)} · ${labels.join(", ")}`;
    chip.addEventListener("click", () => selectNode(node.id));
    els.labelList.append(chip);
  }
}

function renderSelected(graph) {
  const node = graph.nodes.find((item) => item.id === selectedNodeId) || graph.nodes[0];
  const labels = nodeLabels(node);
  const isProtocolNode = node.id.startsWith("protocol:");
  const isExpanded = expandedNodeIds.has(node.id);
  els.hideNodeButton.disabled = node.id === graph.seedAddress;
  els.expandNodeButton.disabled = isProtocolNode || isExpanded;
  els.expandNodeButton.textContent = isExpanded ? "Expanded" : "Expand node";
  els.expandNodeButton.title = isProtocolNode
    ? "Protocol nodes cannot be expanded by address"
    : isExpanded
    ? "This address has already been expanded"
    : "Trace this address and merge the next hop into the graph";

  els.selectedTitle.textContent = labels.includes("seed") ? "Seed address" : shortAddress(node.address);
  els.selectedAddress.innerHTML = "";
  if (isSuiAddress(node.address)) {
    const addressLink = document.createElement("a");
    addressLink.className = "address-link";
    addressLink.href = accountUrl(node.address);
    addressLink.target = "_blank";
    addressLink.rel = "noreferrer";
    addressLink.textContent = node.address;
    els.selectedAddress.append(addressLink);
  } else {
    els.selectedAddress.textContent = node.address;
  }
  els.labelControls.innerHTML = "";

  for (const label of LABELS) {
    const chip = document.createElement("button");
    chip.className = `label-chip ${labels.includes(label) ? "active" : ""}`;
    chip.textContent = label;
    chip.addEventListener("click", () => toggleLabel(node.id, label));
    els.labelControls.append(chip);
  }
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  selectedFlowKey = null;
  render();
}

function selectFlow(flowKey) {
  selectedFlowKey = flowKey;
  render();
}

function hideSelectedNode() {
  if (!trace || selectedNodeId === trace.graphSnapshot.seedAddress) return;
  pushUndoState();
  hiddenNodeIds.add(selectedNodeId);
  selectedNodeId = trace.graphSnapshot.seedAddress;
  selectedFlowKey = null;
  render();
}

function hideSelectedFlow() {
  if (!trace || !selectedFlowKey) return;
  const edge = visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(visibleEdges(trace.graphSnapshot))))
    .find((item) => item.key === selectedFlowKey);
  if (!edge) return;

  pushUndoState();
  for (const item of edge.items) {
    hiddenEdgeIds.add(edgeId(item));
  }

  selectedFlowKey = null;
  render();
}

function hideSingleEdge(edge) {
  if (!trace) return;
  pushUndoState();
  hiddenEdgeIds.add(edgeId(edge));
  render();
}

function showAllHiddenItems() {
  if (!trace || (hiddenNodeIds.size === 0 && hiddenEdgeIds.size === 0)) return;
  pushUndoState();
  resetHiddenItems();
  selectedFlowKey = null;
  render();
}

function selectedFlowIsVisible() {
  if (!trace || !selectedFlowKey) return false;
  return visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(visibleEdges(trace.graphSnapshot))))
    .some((edge) => edge.key === selectedFlowKey);
}

function toggleDustFilter() {
  if (!trace) return;
  pushUndoState();
  dustFilterEnabled = !dustFilterEnabled;
  if (selectedFlowKey && !selectedFlowIsVisible()) {
    selectedFlowKey = null;
  }
  render();
}

function toggleLabel(nodeId, label) {
  if (!trace) return;
  pushUndoState();
  const labels = new Set(labelState.get(nodeId) || []);
  if (labels.has(label)) labels.delete(label);
  else labels.add(label);
  labelState.set(nodeId, Array.from(labels));
  render();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function svgDataUrl(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

function snapshotStyleText() {
  return `
    .edge-line{fill:none;stroke:#146c94;stroke-width:2.5}
    .edge-line.inbound{stroke:#146c94}.edge-line.outbound{stroke:#b23a48}.edge-line.neutral{stroke:#146c94}
    .edge-line.bidirectional,.edge-line.selected{stroke:#FFDC35;stroke-width:3.5}
    .edge-label{paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round;fill:#1d252c;font:800 12px Inter,Arial,sans-serif}
    .node circle{stroke:#fff;stroke-width:4;filter:drop-shadow(0 8px 14px rgba(29,37,44,.18))}
    .node.seed circle{fill:#b23a48}.node.peer circle{fill:#1f8a70}.node.protocol circle{fill:#635bff}
    .node.selected circle{stroke:#FFDC35;stroke-width:6}
    .node text{fill:#1d252c;font:850 12px Inter,Arial,sans-serif;text-anchor:middle}
  `;
}

function currentGraphSvgText() {
  const clone = els.flowGraph.cloneNode(true);
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = snapshotStyleText();
  clone.insertBefore(style, clone.firstChild);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(els.flowGraph.clientWidth || 1200)));
  clone.setAttribute("height", String(Math.round(els.flowGraph.clientHeight || 800)));
  return new XMLSerializer().serializeToString(clone);
}

function snapshotDownloadName(extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `caseflow-${shortAddress(trace?.seedAddress || "snapshot").replace("...", "-")}-${stamp}.${extension}`;
}

function downloadTextFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function txDigestsFromEdges(edges) {
  return Array.from(new Set(edges.flatMap((edge) => edge.items || [edge]).map((edge) => edge.txDigest))).filter(Boolean);
}

async function createEvidenceSnapshot() {
  if (!trace?.graphSnapshot) throw new Error("Trace a case before minting a snapshot.");
  renderGraph(trace.graphSnapshot);

  const graph = trace.graphSnapshot;
  const visibleNodes = visibleGraphNodes(graph).map((node) => ({
    id: node.id,
    address: node.address,
    shortAddress: node.shortAddress || shortAddress(node.address),
    labels: nodeLabels(node),
    position: currentPositions.get(node.id) || null,
  }));
  const rawVisibleEdges = visibleEdges(graph);
  const displayEdges = visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(rawVisibleEdges))).map((edge) => ({
    key: edge.key,
    from: edge.from,
    to: edge.to,
    label: edgeLabel(edge),
    isBidirectional: Boolean(edge.isBidirectional),
    txCount: edge.txCount || 1,
    assetCount: edge.assetCount || 1,
    txDigests: edge.txDigests || txDigestsFromEdges([edge]),
    items: (edge.items || [edge]).map((item) => ({
      txDigest: item.txDigest,
      from: item.from,
      to: item.to,
      coinType: item.coinType,
      coinSymbol: item.coinSymbol,
      amount: item.amount,
      displayAmount: edgeLabel(item),
      timestampMs: item.timestampMs,
      confidence: item.confidence,
    })),
  }));

  const svgText = currentGraphSvgText();
  const imageHash = await sha256Hex(svgText);
  const createdAtMs = Date.now();
  const snapshotCore = {
    kind: "sui-caseflow/evidence-snapshot",
    version: 1,
    createdAtMs,
    network: "sui:mainnet-source/testnet-mint",
    seedAddress: trace.seedAddress,
    sourceTxCount: trace.txCount,
    visibleNodeCount: visibleNodes.length,
    visibleFlowCount: rawVisibleEdges.length,
    visibleDisplayFlowCount: displayEdges.length,
    txDigests: txDigestsFromEdges(rawVisibleEdges),
    filters: {
      dustFilterEnabled,
    },
    nodes: visibleNodes,
    flows: displayEdges,
    viewport: cloneValue(viewportState),
    image: {
      format: "svg",
      sha256: imageHash,
    },
  };
  const caseMemoryBase = {
    kind: "sui-caseflow/case-memory",
    version: 1,
    createdAtMs,
    seedAddress: trace.seedAddress,
    summary: {
      sourceTxCount: trace.txCount,
      visibleNodeCount: visibleNodes.length,
      visibleFlowCount: rawVisibleEdges.length,
      visibleDisplayFlowCount: displayEdges.length,
      txCount: txDigestsFromEdges(rawVisibleEdges).length,
      dustFilterEnabled,
    },
    labels: visibleNodes
      .filter((node) => (node.labels || []).length > 0)
      .map((node) => ({
        id: node.id,
        address: node.address,
        shortAddress: node.shortAddress,
        labels: node.labels,
      })),
    keyFlows: displayEdges.map((flow) => ({
      key: flow.key,
      from: flow.from,
      to: flow.to,
      label: flow.label,
      isBidirectional: flow.isBidirectional,
      txCount: flow.txCount,
      assetCount: flow.assetCount,
      txDigests: flow.txDigests,
    })),
    txDigests: txDigestsFromEdges(rawVisibleEdges),
    report: {
      imageHash,
    },
    suggestedNextActions: [],
  };
  const caseMemoryJsonBase = `${JSON.stringify(canonicalize(caseMemoryBase), null, 2)}
`;
  const caseMemoryHashBase = await sha256Hex(caseMemoryJsonBase);

  const snapshotWithMemory = {
    ...snapshotCore,
    caseMemory: {
      kind: caseMemoryBase.kind,
      hash: caseMemoryHashBase,
      suggestedNextActions: [],
    },
  };
  const snapshotJson = `${JSON.stringify(canonicalize(snapshotWithMemory), null, 2)}
`;
  const snapshotHash = await sha256Hex(snapshotJson);
  const caseMemory = {
    ...caseMemoryBase,
    report: {
      ...caseMemoryBase.report,
      snapshotHash,
    },
  };
  const caseMemoryJson = `${JSON.stringify(canonicalize(caseMemory), null, 2)}
`;
  const caseMemoryHash = await sha256Hex(caseMemoryJson);
  const snapshotFinal = {
    ...snapshotCore,
    caseMemory: {
      kind: caseMemory.kind,
      hash: caseMemoryHash,
      suggestedNextActions: [],
    },
  };
  const snapshotFinalJson = `${JSON.stringify(canonicalize(snapshotFinal), null, 2)}
`;
  const snapshotFinalHash = await sha256Hex(snapshotFinalJson);
  const metadata = {
    name: `Sui CaseFlow Snapshot ${shortAddress(trace.seedAddress)}`,
    description: `Case snapshot for seed ${trace.seedAddress}. This is a testnet artifact, not a legal attestation.`,
    image_url: `local://caseflow/${snapshotFinalHash}.svg`,
    snapshot_url: `local://caseflow/${snapshotFinalHash}.json`,
    snapshot_hash: snapshotFinalHash,
    seed_address: trace.seedAddress,
    created_at_ms: createdAtMs,
  };

  return {
    svgText,
    svgDataUrl: svgDataUrl(svgText),
    snapshot: { ...snapshotFinal, snapshotHash: snapshotFinalHash, caseMemoryHash, metadata },
    snapshotJson: snapshotFinalJson,
    snapshotHash: snapshotFinalHash,
    caseMemory,
    caseMemoryJson,
    caseMemoryHash,
    metadata,
  };

}

function setMintStatus(message, state = "") {
  els.mintStatus.textContent = message;
  els.mintStatus.className = `mint-status ${state}`.trim();
}

async function openMintPreview() {
  if (!trace?.graphSnapshot) return;
  els.mintSnapshotButton.disabled = true;
  setMintStatus("Preparing case snapshot...");
  try {
    pendingSnapshot = await createEvidenceSnapshot();
    els.snapshotPreview.src = pendingSnapshot.svgDataUrl;
    els.snapshotSeed.textContent = pendingSnapshot.metadata.seed_address;
    els.snapshotStats.textContent = `${pendingSnapshot.snapshot.visibleNodeCount} nodes · ${pendingSnapshot.snapshot.visibleDisplayFlowCount} visual flows · ${pendingSnapshot.snapshot.txDigests.length} txs`;
    els.snapshotHash.textContent = pendingSnapshot.snapshotHash;
    setMintStatus("Preview ready. Download a report, export JSON, or mint on Sui testnet.");
    els.mintDialog.showModal();
  } catch (error) {
    pendingSnapshot = null;
    setMintStatus(error.message, "error");
  } finally {
    els.mintSnapshotButton.disabled = false;
  }
}

function closeMintPreview() {
  els.mintDialog.close();
}

function reportEscape(value) {
  return escapeHtml(String(value ?? ""));
}

function reportDate(timestampMs) {
  if (!timestampMs) return "No timestamp";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(timestampMs)));
}

function reportAddressHtml(address) {
  const label = reportEscape(shortAddress(address));
  if (!isSuiAddress(address)) return label;
  return `<a href="${reportEscape(accountUrl(address))}" target="_blank" rel="noreferrer">${label}</a>`;
}

function reportFullAddressHtml(address) {
  if (!isSuiAddress(address)) return reportEscape(address);
  return `<a href="${reportEscape(accountUrl(address))}" target="_blank" rel="noreferrer">${reportEscape(address)}</a>`;
}

function reportTxHtml(txDigest) {
  if (!txDigest) return "";
  return `<a href="${reportEscape(txUrl(txDigest))}" target="_blank" rel="noreferrer">${reportEscape(shortAddress(txDigest))}</a>`;
}

function buildCaseReportHtml(snapshotBundle) {
  const { snapshot, svgText, snapshotHash } = snapshotBundle;
  const generatedAt = reportDate(snapshot.createdAtMs);
  const labeledNodes = snapshot.nodes.filter((node) => (node.labels || []).length > 0);
  const flowTime = (flow) => Math.min(...(flow.items || [])
    .map((item) => Number(item.timestampMs || 0))
    .filter((timestamp) => timestamp > 0));
  const sortedFlows = [...snapshot.flows].sort((a, b) => {
    const left = flowTime(a);
    const right = flowTime(b);
    const leftTime = Number.isFinite(left) ? left : Number.POSITIVE_INFINITY;
    const rightTime = Number.isFinite(right) ? right : Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  });
  const labelRows = labeledNodes.length
    ? labeledNodes.map((node) => `
      <tr>
        <td>${reportFullAddressHtml(node.address || node.id)}</td>
        <td>${(node.labels || []).map((label) => `<span class="tag">${reportEscape(label)}</span>`).join(" ")}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="muted">No labels in the visible graph.</td></tr>`;

  const flowRows = sortedFlows.length
    ? sortedFlows.map((flow) => {
      const direction = flow.isBidirectional ? "<->" : "->";
      return `
        <tr>
          <td>${reportAddressHtml(flow.from)}</td>
          <td class="direction">${direction}</td>
          <td>${reportAddressHtml(flow.to)}</td>
          <td>${reportEscape(flow.label)}</td>
          <td>${reportEscape(flow.txCount || 0)}</td>
          <td>${reportTxHtml((flow.txDigests || [])[0])}</td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="6" class="muted">No visible flows.</td></tr>`;

  const evidenceSections = sortedFlows.map((flow) => {
    const items = [...(flow.items || [])].sort((a, b) => {
      const left = Number(a.timestampMs || 0) || Number.POSITIVE_INFINITY;
      const right = Number(b.timestampMs || 0) || Number.POSITIVE_INFINITY;
      return left - right;
    });
    const visibleItems = items.slice(0, 5);
    const extraCount = Math.max(0, items.length - visibleItems.length);
    const itemRows = visibleItems.map((item) => `
      <tr>
        <td>${reportEscape(item.displayAmount || "")}</td>
        <td>${reportDate(item.timestampMs)}</td>
        <td>${reportAddressHtml(item.from)} <span class="direction">-></span> ${reportAddressHtml(item.to)}</td>
        <td>${reportTxHtml(item.txDigest)}</td>
      </tr>`).join("");
    return `
      <section class="flow-evidence">
        <h3>${reportAddressHtml(flow.from)} ${flow.isBidirectional ? "<->" : "->"} ${reportAddressHtml(flow.to)}</h3>
        <p class="muted">${reportEscape(flow.label)} · ${reportEscape(flow.txCount || 0)} transaction${flow.txCount === 1 ? "" : "s"}</p>
        <table>
          <thead><tr><th>Amount</th><th>Time</th><th>Direction</th><th>Tx</th></tr></thead>
          <tbody>${itemRows || `<tr><td colspan="4" class="muted">No transaction items.</td></tr>`}</tbody>
        </table>
        ${extraCount ? `<p class="muted">+ ${extraCount} more transaction${extraCount === 1 ? "" : "s"} in the snapshot JSON.</p>` : ""}
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sui CaseFlow Investigation Report</title>
  <style>
    :root{color-scheme:light;--ink:#1d252c;--muted:#66727f;--line:#d5ddd8;--paper:#f7f5ef;--card:#fff;--blue:#146c94;--red:#b23a48;--gold:#ffdc35;--green:#1f8a70}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,Arial,sans-serif;line-height:1.45}.page{max-width:1180px;margin:0 auto;padding:32px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}h1{font-size:34px;margin:0 0 8px}h2{font-size:22px;margin:28px 0 12px}h3{font-size:16px;margin:0 0 6px}.eyebrow{letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:var(--muted);font-size:13px;margin:0 0 6px}.muted{color:var(--muted)}a{color:var(--blue);font-weight:750;text-decoration:none}a:hover{text-decoration:underline}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.stat,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}.stat strong{display:block;font-size:28px}.snapshot{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto}.snapshot svg{width:100%;height:auto;display:block;max-height:720px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:0 0 14px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px 12px;vertical-align:top}th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;background:#fbfaf6}tr:last-child td{border-bottom:0}.tag{display:inline-block;border:1px solid var(--green);color:#11624f;background:#edf8f3;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800;margin:0 4px 4px 0}.direction{color:var(--muted);font-weight:800}.flow-evidence{break-inside:avoid;margin-bottom:18px}.hash{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}.footer{margin-top:28px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:14px}@media print{body{background:#fff}.page{max-width:none;padding:18px}.stats{grid-template-columns:repeat(4,1fr)}a{color:inherit;text-decoration:underline}}
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <p class="eyebrow">Sui CaseFlow</p>
        <h1>Investigation Report</h1>
        <p class="muted">Generated ${reportEscape(generatedAt)} · Network: Sui Mainnet</p>
      </div>
      <div class="card">
        <p class="eyebrow">Seed address</p>
        <p class="hash">${reportFullAddressHtml(snapshot.seedAddress)}</p>
      </div>
    </header>

    <section class="stats" aria-label="Case overview">
      <div class="stat"><strong>${reportEscape(snapshot.visibleNodeCount)}</strong><span>Visible nodes</span></div>
      <div class="stat"><strong>${reportEscape(snapshot.visibleDisplayFlowCount)}</strong><span>Visual flows</span></div>
      <div class="stat"><strong>${reportEscape(snapshot.txDigests.length)}</strong><span>Transactions</span></div>
      <div class="stat"><strong>${snapshot.filters?.dustFilterEnabled ? "On" : "Off"}</strong><span>Dust filter</span></div>
    </section>

    <section>
      <h2>Visual Snapshot</h2>
      <div class="snapshot">${svgText}</div>
    </section>

    <section>
      <h2>Address Labels</h2>
      <table><thead><tr><th>Address</th><th>Labels</th></tr></thead><tbody>${labelRows}</tbody></table>
    </section>

    <section>
      <h2>Key Fund Flows</h2>
      <table><thead><tr><th>From</th><th></th><th>To</th><th>Flow</th><th>Tx Count</th><th>Evidence</th></tr></thead><tbody>${flowRows}</tbody></table>
    </section>

    <section>
      <h2>Transaction Evidence</h2>
      ${evidenceSections || `<p class="muted">No visible transaction evidence.</p>`}
    </section>

    <section>
      <h2>Data Integrity</h2>
      <div class="card">
        <p><strong>Snapshot hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotHash)}</p>
        <p><strong>Image hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshot.image?.sha256 || "")}</p>
        <p><strong>Case memory hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotBundle.caseMemoryHash || "")}</p>
      </div>
    </section>

    <p class="footer">This report is generated from the visible Sui CaseFlow graph. Hidden nodes and hidden flows are excluded. The HTML report is for human review and is backed by machine-readable snapshot and case memory artifacts.</p>
  </main>
</body>
</html>`;
}

function downloadCaseReport() {
  if (!pendingSnapshot) return;
  downloadTextFile(snapshotDownloadName("html"), buildCaseReportHtml(pendingSnapshot), "text/html;charset=utf-8");
}

function downloadSnapshotJson() {
  if (!pendingSnapshot) return;
  downloadTextFile(snapshotDownloadName("json"), pendingSnapshot.snapshotJson, "application/json;charset=utf-8");
}

function walrusLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

async function uploadCaseToWalrus() {
  if (!pendingSnapshot) return;

  if (!authSession?.token) {
    setMintStatus("Sign in with a Sui wallet before uploading to Walrus.", "error");
    await signInWithWallet();
    if (!authSession?.token) return;
  }

  const shouldUpload = window.confirm(
    "Walrus uploads are public and persistent for the selected storage period. Do not upload private notes, unpublished identity details, or sensitive personal information. Upload this case snapshot?",
  );
  if (!shouldUpload) return;

  els.uploadWalrusButton.disabled = true;
  setMintStatus("Uploading case package to Walrus...");

  try {
    const reportHtml = buildCaseReportHtml(pendingSnapshot);
    const response = await fetch("/api/walrus/upload-case", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        seedAddress: pendingSnapshot.metadata.seed_address,
        snapshotHash: pendingSnapshot.snapshotHash,
        caseMemoryHash: pendingSnapshot.caseMemoryHash,
        visibleNodeCount: pendingSnapshot.snapshot.visibleNodeCount,
        visibleFlowCount: pendingSnapshot.snapshot.visibleDisplayFlowCount,
        txCount: pendingSnapshot.snapshot.txDigests.length,
        createdAtMs: pendingSnapshot.snapshot.createdAtMs,
        artifacts: {
          "report.html": reportHtml,
          "snapshot.json": pendingSnapshot.snapshotJson,
          "case-memory.json": pendingSnapshot.caseMemoryJson,
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Walrus upload failed.");

    setMintStatus("", "success");
    els.mintStatus.append(`Uploaded to Walrus quilt ${shortAddress(result.quiltId)} · `);
    els.mintStatus.append(walrusLink("report", result.files?.["report.html"]?.url || result.reportUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("snapshot", result.files?.["snapshot.json"]?.url || result.snapshotUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("memory", result.files?.["case-memory.json"]?.url || result.caseMemoryUrl));
    els.mintStatus.append(" · Saved to My Snapshots");
    await loadMySnapshots();
  } catch (error) {
    setMintStatus(error.message, "error");
  } finally {
    els.uploadWalrusButton.disabled = false;
  }
}

function mintedObjectId(result) {
  const objectChange = result?.objectChanges?.find((change) => change.type === "created" && change.objectType?.includes("::snapshot_nft::CaseSnapshotNFT"));
  return objectChange?.objectId || result?.effects?.created?.[0]?.reference?.objectId || "";
}

async function confirmMintSnapshot() {
  if (!pendingSnapshot) return;
  els.confirmMintButton.disabled = true;
  setMintStatus("Opening Sui wallet for testnet mint...");
  try {
    const { mintSnapshot } = await import("./src/mint-snapshot.js");
    const result = await mintSnapshot({ metadata: pendingSnapshot.metadata });
    const objectId = mintedObjectId(result);
    const digest = result?.digest || result?.effects?.transactionDigest || "";
    if (objectId) {
      setMintStatus("", "success");
      els.mintStatus.append("Minted snapshot object ");
      const objectLink = document.createElement("a");
      objectLink.href = testnetObjectUrl(objectId);
      objectLink.target = "_blank";
      objectLink.rel = "noreferrer";
      objectLink.textContent = shortAddress(objectId);
      els.mintStatus.append(objectLink);
      if (digest) els.mintStatus.append(` · tx ${shortAddress(digest)}`);
    } else {
      setMintStatus(`Mint submitted${digest ? ` · tx ${shortAddress(digest)}` : ""}. Check your testnet wallet for the created object.`, "success");
    }
  } catch (error) {
    setMintStatus(error.message, "error");
  } finally {
    els.confirmMintButton.disabled = false;
  }
}


function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function isEditableTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || Boolean(target?.isContentEditable);
}

function handleKeyboardShortcut(event) {
  if (event.key === "Escape" && walletDropdownOpen) {
    closeWalletDropdown();
    return;
  }
  if (event.key.toLowerCase() !== "z") return;
  if (!event.metaKey && !event.ctrlKey) return;
  if (event.shiftKey || event.altKey || isEditableTarget(event.target)) return;

  event.preventDefault();
  undoLastAction();
}

els.walletButton.addEventListener("click", toggleWalletMenu);
els.signOutButton.addEventListener("click", signOutWallet);
document.addEventListener("click", closeWalletMenuOnOutsideClick);
els.loadSampleButton.addEventListener("click", loadTrace);
els.traceButton.addEventListener("click", traceAddress);
els.expandNodeButton.addEventListener("click", expandSelectedNode);
els.undoButton.addEventListener("click", undoLastAction);
els.showAllButton.addEventListener("click", showAllHiddenItems);
els.dustFilterButton.addEventListener("click", toggleDustFilter);
els.fitButton.addEventListener("click", resetCurrentViewport);
els.mintSnapshotButton.addEventListener("click", openMintPreview);
els.closeMintButton.addEventListener("click", closeMintPreview);
els.downloadReportButton.addEventListener("click", downloadCaseReport);
els.downloadSnapshotButton.addEventListener("click", downloadSnapshotJson);
els.uploadWalrusButton.addEventListener("click", uploadCaseToWalrus);
els.confirmMintButton.addEventListener("click", confirmMintSnapshot);
els.hideNodeButton.addEventListener("click", hideSelectedNode);
els.hideFlowButton.addEventListener("click", hideSelectedFlow);
els.flowGraph.addEventListener("wheel", zoomGraph, { passive: false });
els.flowGraph.addEventListener("pointerdown", startGraphPan);
document.addEventListener("keydown", handleKeyboardShortcut);

initializeAuth();

loadTrace().catch((error) => {
  els.caseTitle.textContent = "Trace unavailable";
  els.flowSummary.textContent = error.message;
});
