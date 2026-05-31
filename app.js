const SAMPLE_ADDRESS = "0x27bc7a3c4f406cfa91551c32490ad7f5029414578c0649ab4ddbd232e76ef44e";
const EXPLORER_BASE_URL = "https://suivision.xyz";
const LABELS = ["hacker", "funder", "intermediate", "bridge", "exchange_suspect", "known_entity", "watch"];
const MAX_UNDO_STEPS = 20;
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DUST_SUI_THRESHOLD = 20_000_000n;
const AUTH_STORAGE_KEY = "sui-caseflow-auth-session";
const WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space";

let trace = null;
let selectedNodeId = SAMPLE_ADDRESS;
let selectedFlowKey = null;
let dragState = null;
let panState = null;
let viewportState = null;
let pendingSnapshot = null;
let restoredSuggestedActions = [];
let restoredAiNotes = null;
let dustFilterEnabled = false;
let authSession = null;
let mySnapshots = [];
let reputationProfile = null;
let lastXpMessage = "";
let walletDropdownOpen = false;
let memwalAssistantOpen = false;
let memwalChatMessages = [];
let memwalChatMessageId = 0;
let currentWalrusCaseId = "";
let currentSnapshotUrl = "";
let currentSnapshotHash = "";
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
  reputationPanel: document.querySelector("#reputationPanel"),
  reputationLevel: document.querySelector("#reputationLevel"),
  reputationXp: document.querySelector("#reputationXp"),
  reputationProgress: document.querySelector("#reputationProgress"),
  reputationNext: document.querySelector("#reputationNext"),
  xpToast: document.querySelector("#xpToast"),
  snapshotList: document.querySelector("#snapshotList"),
  walrusRestoreInput: document.querySelector("#walrusRestoreInput"),
  walrusRestoreButton: document.querySelector("#walrusRestoreButton"),
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
  generateAiNotesButton: document.querySelector("#generateAiNotesButton"),
  downloadReportButton: document.querySelector("#downloadReportButton"),
  downloadSnapshotButton: document.querySelector("#downloadSnapshotButton"),
  uploadWalrusButton: document.querySelector("#uploadWalrusButton"),
  confirmMintButton: document.querySelector("#confirmMintButton"),
  memwalAssistant: document.querySelector("#memwalAssistant"),
  memwalAssistantToggle: document.querySelector("#memwalAssistantToggle"),
  memwalAssistantIcon: document.querySelector("#memwalAssistantIcon"),
  memwalAssistantBody: document.querySelector("#memwalAssistantBody"),
  memwalCurrentSummary: document.querySelector("#memwalCurrentSummary"),
  memwalCurrentNext: document.querySelector("#memwalCurrentNext"),
  memwalRecallStatus: document.querySelector("#memwalRecallStatus"),
  memwalChatTimeline: document.querySelector("#memwalChatTimeline"),
  memwalAskForm: document.querySelector("#memwalAskForm"),
  memwalAskInput: document.querySelector("#memwalAskInput"),
  memwalAskButton: document.querySelector("#memwalAskButton"),
  memwalAskStatus: document.querySelector("#memwalAskStatus"),
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
  reputationProfile = null;
  lastXpMessage = "";
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
    setAuthStatus("Signed in. Walrus uploads and XP are saved to your profile.", "success");
  } else {
    els.walletButton.textContent = "Connect Wallet";
    els.walletButton.removeAttribute("title");
    els.signOutButton.hidden = true;
    closeWalletDropdown();
    setAuthStatus("Connect wallet to save Walrus snapshots and Analyst XP.");
  }
  renderReputation();
  renderSnapshotList();
}

function fallbackReputationProfile() {
  return {
    levelName: "Observer",
    xpTotal: 0,
    nextLevel: 2,
    nextLevelName: "Analyst",
    currentThreshold: 0,
    nextThreshold: 50,
    progress: 0,
  };
}


function setCurrentWalrusRefs(record = {}) {
  currentWalrusCaseId = record.quilt_id || record.quiltId || "";
  currentSnapshotUrl = snapshotUrlForRecord(record) || record.snapshot_url || record.snapshotUrl || "";
  currentSnapshotHash = record.snapshot_hash || record.snapshotHash || currentSnapshotHash || "";
}

function clearCurrentWalrusRefs() {
  currentWalrusCaseId = "";
  currentSnapshotUrl = "";
  currentSnapshotHash = "";
}

function memwalAssistantStatus(message, state = "") {
  if (!els.memwalRecallStatus) return;
  els.memwalRecallStatus.textContent = message;
  els.memwalRecallStatus.className = `memwal-recall-status ${state}`.trim();
}

function memwalAskStatus(message, state = "") {
  if (!els.memwalAskStatus) return;
  els.memwalAskStatus.textContent = message;
  els.memwalAskStatus.className = `memwal-recall-status ${state}`.trim();
}

function setMemwalAssistantOpen(open) {
  memwalAssistantOpen = Boolean(open);
  if (!els.memwalAssistant) return;
  els.memwalAssistant.classList.toggle("is-collapsed", !memwalAssistantOpen);
  els.memwalAssistantToggle.setAttribute("aria-expanded", String(memwalAssistantOpen));
  els.memwalAssistantBody.hidden = !memwalAssistantOpen;
  els.memwalAssistantIcon.textContent = memwalAssistantOpen ? "▾" : "▴";
  if (memwalAssistantOpen) renderMemwalAssistant();
}

function currentMemwalStatusLabel() {
  const record = trace?.restoredRecord || null;
  const status = record?.memwal_status || "";
  if (status === "saved") return "Saved to MemWal";
  if (status === "queued") return "MemWal queued";
  if (status === "failed") return "MemWal save failed";
  if (status === "skipped") return "MemWal not configured";
  if (currentWalrusCaseId) return "Walrus case available";
  return "Memory query ready";
}

function recallBoundaryLabel(boundary) {
  return `${boundary.address_short || shortAddress(boundary.address || "boundary")} (${boundary.boundary_type || "boundary"})`;
}

function memwalInputDisabledReason() {
  if (!trace?.graphSnapshot) return "Start a trace or restore a snapshot before asking MemWal.";
  if (!authSession?.token) return "Connect Wallet to ask MemWal.";
  return "";
}

function clearMemwalChatTimeline() {
  memwalChatMessages = [];
  memwalChatMessageId = 0;
}

function appendMemwalChatMessage(message) {
  const item = { id: ++memwalChatMessageId, ...message };
  memwalChatMessages.push(item);
  renderMemwalChatTimeline();
  return item.id;
}

function updateMemwalChatMessage(id, patch) {
  const index = memwalChatMessages.findIndex((message) => message.id === id);
  if (index < 0) return;
  memwalChatMessages[index] = { ...memwalChatMessages[index], ...patch };
  renderMemwalChatTimeline();
}

function renderMemwalAssistant() {
  if (!els.memwalAssistant) return;
  const hasCase = Boolean(trace?.graphSnapshot);
  const disabledReason = memwalInputDisabledReason();
  if (els.memwalAskButton) els.memwalAskButton.disabled = Boolean(disabledReason);
  for (const button of document.querySelectorAll("[data-memwal-prompt]")) {
    button.disabled = Boolean(disabledReason);
  }

  if (!hasCase) {
    els.memwalCurrentSummary.textContent = "No active case. Start a trace or restore a snapshot.";
    els.memwalCurrentNext.textContent = "Next: none";
    memwalAssistantStatus("");
    memwalAskStatus("Start a trace or restore a snapshot before asking MemWal.", "error");
    renderMemwalChatTimeline();
    return;
  }

  const actions = currentMemoryAgentActions(trace.graphSnapshot);
  const topAction = actions.find((action) => action.priority === "high") || actions[0] || null;
  const root = shortAddress(trace.seedAddress || trace.graphSnapshot.seedAddress || "");
  els.memwalCurrentSummary.textContent = `Current case · ${root} · Ready · ${currentMemwalStatusLabel()}`;
  els.memwalCurrentNext.textContent = `Next: ${topAction?.title || "Review current investigation leads"}`;

  memwalAssistantStatus("");
  memwalAskStatus(disabledReason, disabledReason ? "error" : "");
  renderMemwalChatTimeline();
}

function confidenceLabel(score) {
  return score >= 70 ? "High match" : "Medium match";
}

function restoreMemwalSource(source) {
  const value = source?.snapshotUrl || source?.walrusCaseId || "";
  if (!value) return;
  els.walrusRestoreInput.value = value;
  void restoreWalrusInput();
}

function appendMemwalSourceActions(parent, source) {
  if (!source?.walrusCaseId && !source?.snapshotUrl) return;
  const actions = document.createElement("div");
  actions.className = "memwal-result-actions";

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.textContent = "Restore";
  restoreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    restoreMemwalSource(source);
  });
  actions.append(restoreButton);

  const copyCaseButton = document.createElement("button");
  copyCaseButton.type = "button";
  copyCaseButton.textContent = "Copy Case ID";
  copyCaseButton.disabled = !source.walrusCaseId;
  copyCaseButton.addEventListener("click", (event) => {
    void copySnapshotValue(event, source.walrusCaseId, "Walrus Case ID copied.");
  });

  const copySnapshotButton = document.createElement("button");
  copySnapshotButton.type = "button";
  copySnapshotButton.textContent = "Copy Snapshot URL";
  copySnapshotButton.disabled = !source.snapshotUrl;
  copySnapshotButton.addEventListener("click", (event) => {
    void copySnapshotValue(event, source.snapshotUrl, "Snapshot URL copied.");
  });

  actions.append(copyCaseButton, copySnapshotButton);
  parent.append(actions);
}

function splitDecimalSafeSentences(text) {
  const sentences = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (![".", "!", "?"].includes(char)) continue;
    if (char === "." && /\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) continue;
    const rest = text.slice(index + 1);
    const match = rest.match(/^(?:["')\]]+)?\s+/);
    if (!match) continue;
    const next = text[index + 1 + match[0].length] || "";
    if (next && !/[A-Z0-9"'“‘]/.test(next)) continue;
    sentences.push(text.slice(start, index + 1).trim());
    start = index + 1 + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter(Boolean);
}

function splitAskAnswerParagraphs(text) {
  const normalized = String(text || "No answer returned.").replace(/\r\n/g, "\n").trim();
  if (!normalized) return ["No answer returned."];
  const explicit = normalized.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 3);

  const transitionMatch = normalized.match(/\s+(Also,|However,|In recalled memory,|That label\b|If you are checking memory history,)/);
  if (transitionMatch && transitionMatch.index && transitionMatch.index > 40) {
    const first = normalized.slice(0, transitionMatch.index).trim();
    const second = normalized.slice(transitionMatch.index).trim();
    if (first && second) return [first, second];
  }

  const sentences = splitDecimalSafeSentences(normalized);
  if (sentences.length <= 2) return [normalized];
  const splitAt = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, splitAt).join(" "), sentences.slice(splitAt).join(" ")].filter(Boolean);
}

function renderAskAnswerParagraphs(answer) {
  const container = document.createElement("div");
  container.className = "memwal-ask-answer-paragraphs";
  for (const paragraph of splitAskAnswerParagraphs(answer)) {
    const p = document.createElement("p");
    p.className = "memwal-ask-answer-text";
    p.textContent = paragraph;
    container.append(p);
  }
  return container;
}

function renderMemoryResultBubble(message, bubble) {
  const results = message.results || [];
  if (message.status === "loading") {
    bubble.textContent = message.text || "Recalling related memories...";
    return;
  }
  if (message.status === "error") {
    bubble.textContent = message.error || "MemWal recall failed.";
    bubble.classList.add("is-error");
    return;
  }
  if (!results.length) {
    const title = document.createElement("strong");
    title.textContent = "No strong related memory found.";
    const detail = document.createElement("p");
    detail.textContent = "MemWal did not find a recalled memory with the same address or a meaningful analyst-label match.";
    bubble.append(title, detail);
    return;
  }

  const result = results[0];
  const title = document.createElement("strong");
  title.textContent = result.rootAddressShort || result.walrusCaseIdShort || "Strongest related memory";

  const confidence = document.createElement("span");
  confidence.className = "memwal-confidence";
  confidence.textContent = result.confidence || confidenceLabel(Number(result.score || 0));

  const summary = document.createElement("p");
  summary.textContent = result.summary || "No summary available.";

  const reasons = document.createElement("p");
  reasons.className = "memwal-match-reasons";
  reasons.textContent = (result.matchReasons || []).length ? `Match: ${result.matchReasons.join(" · ")}` : "Match: related memory";

  const notice = document.createElement("p");
  notice.className = "memwal-match-reasons";
  notice.textContent = result.referenceNotice || "";

  const next = document.createElement("p");
  next.className = "memwal-next-action";
  next.textContent = result.nextBestAction ? `Next: ${result.nextBestAction}` : "Next: review restored case memory";

  bubble.append(title, confidence, summary, reasons);
  if (result.referenceNotice) bubble.append(notice);
  bubble.append(next);
  appendMemwalSourceActions(bubble, result);
}

function renderAskAnswerBubble(message, bubble) {
  if (message.status === "loading") {
    bubble.textContent = message.text || "Recalling MemWal memories, preparing a grounded AI answer...";
    return;
  }
  if (message.status === "error") {
    bubble.textContent = message.error || "Ask MemWal failed.";
    bubble.classList.add("is-error");
    return;
  }

  const answerText = renderAskAnswerParagraphs(message.answer?.answer || "No answer returned.");

  const meta = document.createElement("p");
  meta.className = "memwal-ask-meta";
  meta.textContent = `Confidence: ${message.answer?.confidence || "low"}`;

  const chips = document.createElement("div");
  chips.className = "memwal-source-chips";
  for (const source of message.sources || []) {
    const chip = document.createElement("span");
    chip.className = "memwal-source-chip";
    chip.textContent = source.label || source.type || "Source";
    chips.append(chip);
  }

  const caution = document.createElement("p");
  caution.className = "memwal-ask-caution";
  caution.textContent = message.answer?.caution || "Answers are based only on current case memory and recalled MemWal memories.";

  bubble.append(answerText, meta, chips, caution);
  for (const source of message.sources || []) appendMemwalSourceActions(bubble, source);
}

function renderMemwalChatTimeline() {
  if (!els.memwalChatTimeline) return;
  els.memwalChatTimeline.innerHTML = "";
  if (!memwalChatMessages.length) return;

  const lastIndex = memwalChatMessages.length - 1;
  const lastMessage = memwalChatMessages[lastIndex];
  const focusUserIndex = lastMessage?.role === "assistant" && lastMessage.status !== "loading" && memwalChatMessages[lastIndex - 1]?.role === "user"
    ? lastIndex - 1
    : -1;
  let focusRow = null;

  for (const [index, message] of memwalChatMessages.entries()) {
    const row = document.createElement("div");
    row.className = `memwal-chat-row is-${message.role}`;
    const bubble = document.createElement("article");
    bubble.className = `memwal-chat-bubble is-${message.role}`;

    if (message.role === "user") {
      bubble.textContent = message.text || "";
    } else if (message.kind === "memory_result") {
      renderMemoryResultBubble(message, bubble);
    } else {
      renderAskAnswerBubble(message, bubble);
    }

    row.append(bubble);
    els.memwalChatTimeline.append(row);
    if (index === focusUserIndex) focusRow = row;
  }

  if (focusRow) {
    els.memwalChatTimeline.scrollTop = Math.max(0, focusRow.offsetTop - els.memwalChatTimeline.offsetTop);
  } else {
    els.memwalChatTimeline.scrollTop = els.memwalChatTimeline.scrollHeight;
  }
}

function compactMemwalQuery(bundle) {
  const memory = bundle.memwalMemory || {};
  return {
    searchText: memory.search_text || memory.summary || "",
    rootAddress: memory.root_address || bundle.snapshot?.seedAddress || trace?.seedAddress || "",
    currentWalrusCaseId,
    currentSnapshotHash: currentSnapshotHash || bundle.snapshotHash || "",
    labels: memory.metadata?.labels || [],
    boundaryTypes: memory.metadata?.boundary_types || [],
    patternTypes: memory.metadata?.pattern_types || [],
    nextActionType: memory.metadata?.next_action_type || "",
    nextBestAction: memory.next_best_action || null,
    traceBoundaries: memory.trace_boundaries || [],
    visibleNodes: memory.metadata?.visible_nodes || [],
    labeledNodes: memory.metadata?.labeled_nodes || [],
  };
}

async function recallStrongestMemory(question = "What is the strongest related memory?") {
  if (!trace?.graphSnapshot) {
    memwalAskStatus("Start a trace or restore a snapshot before asking MemWal.", "error");
    renderMemwalAssistant();
    return;
  }
  if (!authSession?.token) {
    memwalAskStatus("Connect Wallet to ask MemWal.", "error");
    renderMemwalAssistant();
    return;
  }

  appendMemwalChatMessage({ role: "user", text: question });
  const assistantId = appendMemwalChatMessage({
    role: "assistant",
    kind: "memory_result",
    status: "loading",
    text: "Recalling the strongest related MemWal memory...",
  });
  memwalAskStatus("Recalling related MemWal memories...");
  try {
    const bundle = await createEvidenceSnapshot();
    const response = await fetch("/api/memwal/recall", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(compactMemwalQuery(bundle)),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "MemWal recall failed.");
    const results = result.results || [];
    const statusText = result.status === "skipped"
      ? "MemWal is not configured on this server."
      : results.length
        ? "Found " + results.length + " related memor" + (results.length === 1 ? "y" : "ies") + "."
        : (result.message || "No strong related memory found.");
    updateMemwalChatMessage(assistantId, {
      status: result.status === "skipped" ? "error" : "done",
      text: statusText,
      results,
      error: result.status === "skipped" ? statusText : "",
    });
    memwalAskStatus(statusText, result.status === "skipped" ? "error" : results.length ? "success" : "");
  } catch (error) {
    updateMemwalChatMessage(assistantId, { status: "error", error: error.message || "MemWal recall failed." });
    memwalAskStatus(error.message || "MemWal recall failed.", "error");
  } finally {
    renderMemwalAssistant();
  }
}

async function askMemwal(questionOverride = "") {
  const question = String(questionOverride || els.memwalAskInput?.value || "").trim();
  if (!trace?.graphSnapshot) {
    memwalAskStatus("Start a trace or restore a snapshot before asking MemWal.", "error");
    renderMemwalAssistant();
    return;
  }
  if (!authSession?.token) {
    memwalAskStatus("Connect Wallet to ask MemWal.", "error");
    renderMemwalAssistant();
    return;
  }
  if (!question) {
    memwalAskStatus("Type a question for Ask MemWal.", "error");
    return;
  }

  appendMemwalChatMessage({ role: "user", text: question });
  const assistantId = appendMemwalChatMessage({
    role: "assistant",
    kind: "ask_answer",
    status: "loading",
    text: "Recalling MemWal memories, preparing a grounded AI answer...",
  });
  els.memwalAskButton.disabled = true;
  if (els.memwalAskInput) els.memwalAskInput.value = "";
  memwalAskStatus("Recalling MemWal memories, preparing a grounded AI answer...");
  try {
    const bundle = await createEvidenceSnapshot();
    const response = await fetch("/api/memwal/ask", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question, ...compactMemwalQuery(bundle) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Ask MemWal failed.");
    updateMemwalChatMessage(assistantId, {
      status: "done",
      answer: result.answer,
      sources: result.sources || [],
    });
    memwalAskStatus(result.message || "Ask MemWal answered from current case memory.", result.status === "refused" ? "error" : "success");
  } catch (error) {
    updateMemwalChatMessage(assistantId, { status: "error", error: error.message || "Ask MemWal failed." });
    memwalAskStatus(error.message || "Ask MemWal failed.", "error");
  } finally {
    els.memwalAskButton.disabled = Boolean(memwalInputDisabledReason());
    renderMemwalAssistant();
  }
}

function renderReputation() {
  if (!els.reputationPanel) return;
  if (!authSession?.address) {
    els.reputationPanel.hidden = true;
    if (els.xpToast) els.xpToast.hidden = true;
    return;
  }

  const profile = reputationProfile || fallbackReputationProfile();
  els.reputationPanel.hidden = false;
  els.reputationLevel.textContent = profile.levelName || "Observer";
  els.reputationXp.textContent = `${Number(profile.xpTotal || 0).toLocaleString("en")} XP`;

  const percent = Math.round(Number(profile.progress || 0) * 100);
  els.reputationProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;

  if (profile.nextLevel) {
    const xpTotal = Math.max(0, Number(profile.xpTotal || 0));
    const nextThreshold = Math.max(0, Number(profile.nextThreshold || 0));
    els.reputationNext.textContent = `${xpTotal.toLocaleString("en")} / ${nextThreshold.toLocaleString("en")} XP to ${profile.nextLevelName}`;
  } else {
    els.reputationNext.textContent = "Max level reached";
  }

  if (lastXpMessage) {
    els.xpToast.textContent = lastXpMessage;
    els.xpToast.hidden = false;
  } else {
    els.xpToast.hidden = true;
  }
}

async function loadReputation() {
  if (!authSession?.token) return;
  try {
    const response = await fetch("/api/reputation/me", { headers: authHeaders() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load Analyst XP.");
    reputationProfile = result.profile || null;
    renderReputation();
  } catch {
    reputationProfile = null;
    renderReputation();
  }
}

async function recordXpEvent(eventType, actionKey, metadata = {}) {
  if (!authSession?.token || !actionKey) return;
  try {
    const response = await fetch("/api/reputation/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ eventType, actionKey, metadata }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "XP event failed.");
    reputationProfile = result.profile || reputationProfile;
    if (result.awarded && result.event?.xpDelta) {
      lastXpMessage = `+${result.event.xpDelta} XP · ${result.event.label}`;
    }
    renderReputation();
  } catch {
    // XP should never block the investigation workflow.
  }
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
  return record.quilt_id ? shortAddress(record.quilt_id) : "No Walrus ID";
}

function walrusSnapshotUrlFromQuiltId(quiltId) {
  if (!quiltId) return "";
  return `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${encodeURIComponent(quiltId)}/snapshot.json`;
}

function snapshotUrlForRecord(record) {
  return record?.snapshot_url || walrusSnapshotUrlFromQuiltId(record?.quilt_id || "");
}

function stopSnapshotClick(event) {
  event.stopPropagation();
}

async function copyTextToClipboard(value, successMessage) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Nothing to copy.");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  setAuthStatus(successMessage, "success");
}

async function copySnapshotValue(event, value, successMessage) {
  stopSnapshotClick(event);
  try {
    await copyTextToClipboard(value, successMessage);
  } catch (error) {
    setAuthStatus(error.message, "error");
  }
}

function walrusReadQueryForInput(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Paste a Walrus Case ID or snapshot URL first.");
  if (/^https?:\/\//i.test(value)) return `url=${encodeURIComponent(value)}`;
  return `quiltId=${encodeURIComponent(value)}`;
}

async function restoreWalrusInput() {
  const value = els.walrusRestoreInput.value.trim();
  let query;
  try {
    query = walrusReadQueryForInput(value);
  } catch (error) {
    setAuthStatus(error.message, "error");
    return;
  }

  const confirmed = window.confirm("Restore this Walrus snapshot to the workspace? Current graph will be replaced.");
  if (!confirmed) return;

  els.walrusRestoreButton.disabled = true;
  setAuthStatus("Restoring Walrus snapshot...");
  try {
    const response = await fetch(`/api/walrus/read-json?${query}`);
    const snapshot = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(snapshot.error || "Could not read snapshot from Walrus.");
    const record = /^https?:\/\//i.test(value)
      ? { snapshot_url: value }
      : { quilt_id: value, snapshot_url: walrusSnapshotUrlFromQuiltId(value) };
    restoreCaseSnapshot(snapshot, record);
    setAuthStatus("Walrus snapshot restored to workspace.", "success");
    els.walrusRestoreInput.value = "";
    closeWalletDropdown();
  } catch (error) {
    setAuthStatus(error.message, "error");
  } finally {
    els.walrusRestoreButton.disabled = false;
  }
}

async function restoreSnapshotRecord(record) {
  const snapshotUrl = snapshotUrlForRecord(record);
  if (!snapshotUrl) {
    setAuthStatus("Snapshot URL unavailable.", "error");
    return;
  }
  const confirmed = window.confirm("Restore this snapshot to the workspace? Current unsaved graph state will be replaced.");
  if (!confirmed) return;

  setAuthStatus("Restoring snapshot from Walrus...");
  try {
    const response = await fetch(`/api/walrus/read-json?url=${encodeURIComponent(snapshotUrl)}`);
    const snapshot = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(snapshot.error || "Could not read snapshot from Walrus.");
    restoreCaseSnapshot(snapshot, { ...record, snapshot_url: snapshotUrl });
    setAuthStatus("Snapshot restored to workspace.", "success");
    void recordXpEvent("restore_snapshot", record.snapshot_hash || record.id, {
      seedAddress: record.seed_address,
      snapshotRecordId: record.id,
      quiltId: record.quilt_id,
    });
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

  clearMemwalChatTimeline();
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
  restoredSuggestedActions = Array.isArray(snapshot.caseMemory?.suggestedNextActions)
    ? cloneValue(snapshot.caseMemory.suggestedNextActions)
    : [];
  restoredAiNotes = snapshot.aiNotes && typeof snapshot.aiNotes === "object"
    ? cloneValue(snapshot.aiNotes)
    : null;
  setCurrentWalrusRefs({
    ...record,
    snapshotHash: snapshot.snapshotHash || snapshot.metadata?.snapshot_hash || snapshot.aiNotes?.source_artifacts?.input_snapshot_hash || "",
  });
  console.debug("[CaseFlow] Restored AI notes", {
    generatedBy: restoredAiNotes?.generated_by || "rule_fallback",
    aiNotesHash: snapshot.aiNotesHash || "",
  });
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
  renderMemwalAssistant();
}

function renderSnapshotList() {
  els.snapshotList.textContent = "";
  if (!authSession?.address) {
    els.snapshotList.textContent = "Connect wallet to load snapshots.";
    return;
  }
  if (!mySnapshots.length) {
    els.snapshotList.textContent = "No active snapshots yet.";
    return;
  }

  for (const record of mySnapshots.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "snapshot-item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.addEventListener("click", () => restoreSnapshotRecord(record));
    item.addEventListener("keydown", (event) => {
      if (event.target?.closest?.("button")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      restoreSnapshotRecord(record);
    });

    const title = document.createElement("strong");
    title.textContent = shortAddress(record.seed_address || record.quilt_id || "snapshot");

    const meta = document.createElement("span");
    meta.textContent = `${record.tx_count || 0} txs · ${record.visible_node_count || 0} nodes · ${record.visible_flow_count || 0} flows`;

    const submeta = document.createElement("span");
    submeta.textContent = `${recordDisplayTime(record)} · Walrus Case ${recordShortQuilt(record)}`;

    const hint = document.createElement("span");
    hint.className = "snapshot-restore-hint";
    hint.textContent = "Click to restore workspace";

    const actions = document.createElement("div");
    actions.className = "snapshot-actions";

    const copyCaseIdButton = document.createElement("button");
    copyCaseIdButton.type = "button";
    copyCaseIdButton.textContent = "Copy Walrus Case ID";
    copyCaseIdButton.disabled = !record.quilt_id;
    copyCaseIdButton.title = "Used to restore this case from Walrus";
    copyCaseIdButton.addEventListener("click", (event) => {
      void copySnapshotValue(event, record.quilt_id, "Walrus Case ID copied.");
    });

    const snapshotUrl = snapshotUrlForRecord(record);
    const copySnapshotUrlButton = document.createElement("button");
    copySnapshotUrlButton.type = "button";
    copySnapshotUrlButton.textContent = snapshotUrl ? "Copy Snapshot URL" : "Snapshot URL unavailable";
    copySnapshotUrlButton.disabled = !snapshotUrl;
    copySnapshotUrlButton.title = "Direct URL for snapshot.json";
    copySnapshotUrlButton.addEventListener("click", (event) => {
      void copySnapshotValue(event, snapshotUrl, "Snapshot URL copied.");
    });

    actions.append(copyCaseIdButton, copySnapshotUrlButton);
    item.append(title, meta, submeta, hint, actions);
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
    await Promise.all([loadMySnapshots(), loadReputation()]);
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
  if (authSession?.token) {
    loadMySnapshots();
    loadReputation();
  }
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

function clearRestoredAiNotes() {
  restoredAiNotes = null;
}

function invalidateCaseMemoryRefs() {
  restoredSuggestedActions = [];
  clearRestoredAiNotes();
  clearCurrentWalrusRefs();
  renderMemwalAssistant();
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
    restoredSuggestedActions: cloneValue(restoredSuggestedActions),
    restoredAiNotes: cloneValue(restoredAiNotes),
    currentWalrusCaseId,
    currentSnapshotUrl,
    currentSnapshotHash,
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
  restoredSuggestedActions = cloneValue(snapshot.restoredSuggestedActions || []);
  restoredAiNotes = cloneValue(snapshot.restoredAiNotes || null);
  currentWalrusCaseId = snapshot.currentWalrusCaseId || "";
  currentSnapshotUrl = snapshot.currentSnapshotUrl || "";
  currentSnapshotHash = snapshot.currentSnapshotHash || "";

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
  clearMemwalChatTimeline();
  selectedNodeId = trace.seedAddress;
  selectedFlowKey = null;
  invalidateCaseMemoryRefs();
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
    clearMemwalChatTimeline();
    selectedNodeId = trace.seedAddress;
    selectedFlowKey = null;
    invalidateCaseMemoryRefs();
    resetHiddenItems();
    resetGraphLayout();
    resetGraphViewport();
    resetExpandedNodes();
    expandedNodeIds.add(trace.seedAddress);
    initializeLayoutLineage(trace.graphSnapshot);
    hydrateLabels();
    render();
    void recordXpEvent("trace_case", trace.seedAddress, { seedAddress: trace.seedAddress, limit: Number(limit) });
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
    invalidateCaseMemoryRefs();
    applyExpansionLineage(address, payload);
    expandedNodeIds.add(address);
    selectedNodeId = address;
    selectedFlowKey = null;
    hydrateLabels();
    render();
    void recordXpEvent("expand_node", `${trace.seedAddress}:${address}`, {
      seedAddress: trace.seedAddress,
      nodeAddress: address,
      limit: Number(limit),
    });
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
  if (memwalAssistantOpen) renderMemwalAssistant();
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
  invalidateCaseMemoryRefs();
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
  invalidateCaseMemoryRefs();
  for (const item of edge.items) {
    hiddenEdgeIds.add(edgeId(item));
  }

  selectedFlowKey = null;
  render();
}

function hideSingleEdge(edge) {
  if (!trace) return;
  pushUndoState();
  invalidateCaseMemoryRefs();
  hiddenEdgeIds.add(edgeId(edge));
  render();
}

function showAllHiddenItems() {
  if (!trace || (hiddenNodeIds.size === 0 && hiddenEdgeIds.size === 0)) return;
  pushUndoState();
  invalidateCaseMemoryRefs();
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
  invalidateCaseMemoryRefs();
  dustFilterEnabled = !dustFilterEnabled;
  if (selectedFlowKey && !selectedFlowIsVisible()) {
    selectedFlowKey = null;
  }
  render();
}

function toggleLabel(nodeId, label) {
  if (!trace) return;
  pushUndoState();
  invalidateCaseMemoryRefs();
  const labels = new Set(labelState.get(nodeId) || []);
  if (labels.has(label)) labels.delete(label);
  else labels.add(label);
  labelState.set(nodeId, Array.from(labels));
  render();
}


function parseDisplayMagnitude(label) {
  const text = String(label || "").replace(/,/g, "");
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "B") return value * 1_000_000_000;
  if (suffix === "M") return value * 1_000_000;
  if (suffix === "K") return value * 1_000;
  return value;
}

function memoryFlowLabel(flow) {
  if (flow?.label) return flow.label;
  try {
    return edgeLabel(flow);
  } catch {
    return flow?.assetCount > 1 ? `${flow.assetCount} assets` : "flow";
  }
}

function memoryFlowMagnitude(flow) {
  return parseDisplayMagnitude(memoryFlowLabel(flow));
}

function actionPriorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 3;
}

function actionTypeRank(type) {
  return {
    stop_boundary: 0,
    expand_node: 1,
    inspect_bridge: 2,
    inspect_flow: 3,
    verify_entity: 4,
    keep_filter: 5,
    export_report: 6,
  }[type] ?? 7;
}

function memoryAction(id, type, priority, title, rationale, extra = {}) {
  return { id, type, priority, title, rationale, ...extra };
}

function memoryActionType(action) {
  return action?.action_type || action?.type || "";
}

function isBoundaryAction(action) {
  return ["stop_boundary", "verify_entity"].includes(memoryActionType(action));
}

function nodeHasAnyLabel(node, labels) {
  const activeLabels = nodeLabels(node);
  return labels.some((label) => activeLabels.includes(label));
}

function nodeTraceDepth(nodeId, graph) {
  if (!nodeId || nodeId === graph.seedAddress) return 0;

  const visited = new Set([nodeId]);
  let current = nodeId;
  let depth = 0;
  while (nodeParentById.has(current)) {
    const parentId = nodeParentById.get(current);
    if (!parentId || visited.has(parentId)) break;
    depth += 1;
    if (parentId === graph.seedAddress) return depth;
    visited.add(parentId);
    current = parentId;
  }

  const layoutDepth = nodeDepthById.get(nodeId);
  if (Number.isFinite(layoutDepth) && layoutDepth !== 0) return Math.abs(layoutDepth);

  for (const edge of visibleEdges(graph)) {
    if ((edge.from === graph.seedAddress && edge.to === nodeId) || (edge.to === graph.seedAddress && edge.from === nodeId)) return 1;
  }

  return Number.POSITIVE_INFINITY;
}

function isTerminalEntityNode(node) {
  return nodeHasAnyLabel(node, ["exchange_suspect", "known_entity", "known_exchange"]);
}

function isBridgeLikeNode(node) {
  return String(node?.id || "").startsWith("protocol:") || nodeHasAnyLabel(node, ["bridge", "bridge_contract"]);
}

function canSuggestExpandNode({ node, flow, value, graph }) {
  if (!node || !isSuiAddress(node.id) || node.id === graph.seedAddress || expandedNodeIds.has(node.id)) return false;
  if (isTerminalEntityNode(node) || isBridgeLikeNode(node)) return false;
  const depth = nodeTraceDepth(node.id, graph);
  if (Number.isFinite(depth) && depth > 2) return false;

  const labels = nodeLabels(node).filter((label) => label !== "seed");
  if (labels.length === 0 || labels.includes("intermediate")) return true;
  if (labels.includes("watch")) return value >= 1_000 || (flow.txCount || 0) >= 2 || depth <= 1;
  return false;
}

function memoryAgentActionsForGraph(graph, displayEdges = null, visibleNodes = null) {
  if (!graph) return [];
  const nodes = visibleNodes || visibleGraphNodes(graph);
  const edges = displayEdges || visualDisplayEdges(withDisplayLanes(aggregateDisplayEdges(visibleEdges(graph))));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const actions = new Map();

  function add(action) {
    if (!action?.id || actions.has(action.id)) return;
    actions.set(action.id, action);
  }

  for (const node of nodes) {
    const labels = nodeLabels(node);
    const entityLabel = labels.find((label) => ["exchange_suspect", "known_entity", "known_exchange"].includes(label));
    if (entityLabel) {
      add(memoryAction(
        `boundary:${node.id}:${entityLabel}`,
        "stop_boundary",
        "high",
        `Stop at ${shortAddress(node.address || node.id)}`,
        `This node is analyst-labeled ${entityLabel}. Treat it as an investigation boundary and verify context before following unrelated downstream activity.`,
        { targetNodeId: node.id },
      ));
      add(memoryAction(
        `verify:${node.id}:${entityLabel}`,
        "verify_entity",
        "medium",
        `Verify ${shortAddress(node.address || node.id)}`,
        `Cross-check the account activity and entity context before relying on the analyst-provided ${entityLabel} label.`,
        { targetNodeId: node.id },
      ));
    }

    const bridgeLabel = labels.find((label) => ["bridge", "bridge_contract"].includes(label));
    if (bridgeLabel) {
      add(memoryAction(
        `inspect-bridge:${node.id}:${bridgeLabel}`,
        "inspect_bridge",
        "medium",
        `Inspect bridge ${shortAddress(node.address || node.id)}`,
        "This bridge-labeled node is a transition point. Check bridge event details, amount, timestamp, and continuation evidence instead of expanding service-side noise by default.",
        { targetNodeId: node.id },
      ));
    }
  }

  const inspectFlow = edges.find((flow) => flow.isBidirectional || flow.from.startsWith("protocol:") || flow.to.startsWith("protocol:") || /directions|assets/i.test(memoryFlowLabel(flow)));
  if (inspectFlow) {
    const bridgeFlow = inspectFlow.from.startsWith("protocol:bridge") || inspectFlow.to.startsWith("protocol:bridge");
    add(memoryAction(
      `inspect:${inspectFlow.key}`,
      bridgeFlow ? "inspect_bridge" : "inspect_flow",
      "medium",
      bridgeFlow ? "Inspect bridge flow" : "Inspect protocol or bidirectional flow",
      bridgeFlow
        ? "This flow may represent a cross-chain transition. Review bridge event details, amount, timestamp, and counterparties before extending the graph."
        : "This aggregated flow may contain multiple assets, directions, or protocol interactions. Review the transaction list before drawing conclusions.",
      { targetFlowKey: inspectFlow.key, txDigests: inspectFlow.txDigests || [] },
    ));
  }

  const highValueFlows = [...edges]
    .map((flow) => ({ flow, value: memoryFlowMagnitude(flow) }))
    .filter(({ flow, value }) => value >= 1_000 || flow.txCount >= 2)
    .sort((a, b) => b.value - a.value || (b.flow.txCount || 0) - (a.flow.txCount || 0));

  for (const { flow, value } of highValueFlows) {
    const candidates = [flow.to, flow.from]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node) => canSuggestExpandNode({ node, flow, value, graph }));
    const targetNode = candidates[0];
    if (!targetNode) continue;
    add(memoryAction(
      `expand:${targetNode.id}`,
      "expand_node",
      "high",
      `Expand ${shortAddress(targetNode.id)}`,
      `This visible flow carries ${memoryFlowLabel(flow)} and the address remains a plausible continuation point within the current trace depth.`,
      { targetNodeId: targetNode.id, targetFlowKey: flow.key, txDigests: flow.txDigests || [] },
    ));
    if (Array.from(actions.values()).filter((action) => memoryActionType(action) === "expand_node").length >= 2) break;
  }

  if (!dustFilterEnabled && (nodes.length >= 12 || edges.length >= 20)) {
    add(memoryAction(
      "filter:dust",
      "keep_filter",
      "low",
      "Enable dust filter",
      "The visible graph is getting dense. Hiding low-value and same-transaction noise can make the investigation path easier to read.",
    ));
  }

  const importantLabels = nodes.flatMap((node) => nodeLabels(node)).filter((label) => ["hacker", "funder", "exchange_suspect", "known_entity", "known_exchange", "bridge", "bridge_contract"].includes(label));
  if (importantLabels.length > 0) {
    add(memoryAction(
      "export:case-memory",
      "export_report",
      "low",
      "Store this case memory on Walrus",
      "The case has analyst labels. Exporting or uploading preserves the current investigation state for later review or agent handoff.",
    ));
  }

  return Array.from(actions.values())
    .sort((a, b) => actionPriorityRank(a.priority) - actionPriorityRank(b.priority) || actionTypeRank(memoryActionType(a)) - actionTypeRank(memoryActionType(b)) || a.title.localeCompare(b.title))
    .slice(0, 6);
}

function currentMemoryAgentActions(graph) {
  if (restoredSuggestedActions.length > 0) return cloneValue(restoredSuggestedActions);
  return memoryAgentActionsForGraph(graph);
}

function renderMemoryAgentSuggestions(graph) {
  const actions = currentMemoryAgentActions(graph);
  els.flowTitle.textContent = actions.length ? "Investigation Leads" : "Select a flow";
  els.flowSummary.textContent = actions.length
    ? "Deterministic leads from the current case memory. Boundary labels stop normal expansion and shift the task to verification or flow inspection."
    : "Click a line in the graph to inspect every transaction inside that aggregated flow.";
  els.flowList.innerHTML = "";

  for (const action of actions) {
    const row = document.createElement("article");
    row.className = "flow-item suggestion-item";

    const title = document.createElement("strong");
    title.textContent = action.title;

    const meta = document.createElement("p");
    meta.textContent = `${action.priority} priority · ${memoryActionType(action).replace(/_/g, " ")}`;

    const rationale = document.createElement("p");
    rationale.className = "suggestion-rationale";
    rationale.textContent = action.rationale;

    row.append(title, meta, rationale);
    if (action.targetNodeId && graph.nodes.some((node) => node.id === action.targetNodeId)) {
      row.addEventListener("click", () => selectNode(action.targetNodeId));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
    } else if (action.targetFlowKey) {
      row.addEventListener("click", () => selectFlow(action.targetFlowKey));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
    }
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      row.click();
    });
    els.flowList.append(row);
  }
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


function textByteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function flowEndpointNodeIds(flow) {
  return [flow.from, flow.to].filter((nodeId) => nodeId && !String(nodeId).startsWith("protocol:"));
}

function rulesSummaryForGraph({ graph, visibleNodes, rawVisibleEdges, displayEdges, caseMemory, suggestedNextActions, createdAtMs }) {
  const nodeMetrics = new Map(visibleNodes.map((node) => [node.id, {
    inDegree: 0,
    outDegree: 0,
    flowCount: 0,
    incomingTxCount: 0,
    outgoingTxCount: 0,
    counterparties: new Set(),
    flowKeys: new Set(),
    txDigests: new Set(),
  }]));

  for (const flow of displayEdges) {
    const txCount = Number(flow.txCount || 0);
    const fromMetrics = nodeMetrics.get(flow.from);
    const toMetrics = nodeMetrics.get(flow.to);
    if (fromMetrics) {
      fromMetrics.outDegree += 1;
      fromMetrics.flowCount += 1;
      fromMetrics.outgoingTxCount += txCount;
      fromMetrics.counterparties.add(flow.to);
      fromMetrics.flowKeys.add(flow.key);
      for (const digest of flow.txDigests || []) fromMetrics.txDigests.add(digest);
    }
    if (toMetrics) {
      toMetrics.inDegree += 1;
      toMetrics.flowCount += 1;
      toMetrics.incomingTxCount += txCount;
      toMetrics.counterparties.add(flow.from);
      toMetrics.flowKeys.add(flow.key);
      for (const digest of flow.txDigests || []) toMetrics.txDigests.add(digest);
    }
  }

  const importantNodes = visibleNodes
    .map((node) => {
      const metrics = nodeMetrics.get(node.id);
      const score = (metrics?.flowCount || 0) + (metrics?.incomingTxCount || 0) + (metrics?.outgoingTxCount || 0) + (node.labels || []).length * 2;
      const reasons = [];
      if (node.id === graph.seedAddress) reasons.push("case seed address");
      if ((metrics?.inDegree || 0) >= 2) reasons.push("multiple incoming visual flows");
      if ((metrics?.outDegree || 0) >= 2) reasons.push("multiple outgoing visual flows");
      if ((node.labels || []).length) reasons.push(`analyst label: ${(node.labels || []).join(", ")}`);
      return {
        address: node.address || node.id,
        shortAddress: node.shortAddress || shortAddress(node.address || node.id),
        labels: node.labels || [],
        reason: reasons.join("; ") || "connected visible node",
        metrics: {
          in_degree: metrics?.inDegree || 0,
          out_degree: metrics?.outDegree || 0,
          flow_count: metrics?.flowCount || 0,
          incoming_tx_count: metrics?.incomingTxCount || 0,
          outgoing_tx_count: metrics?.outgoingTxCount || 0,
          distinct_counterparties: metrics?.counterparties.size || 0,
        },
        evidence: {
          flowKeys: Array.from(metrics?.flowKeys || []).slice(0, 8),
          txDigests: Array.from(metrics?.txDigests || []).slice(0, 12),
        },
        score,
      };
    })
    .filter((node) => node.score > 0 || node.address === graph.seedAddress)
    .sort((a, b) => b.score - a.score || b.metrics.flow_count - a.metrics.flow_count)
    .slice(0, 10)
    .map(({ score, ...node }) => node);

  const importantFlows = [...displayEdges]
    .map((flow) => ({
      key: flow.key,
      from: flow.from,
      to: flow.to,
      label: memoryFlowLabel(flow),
      isBidirectional: Boolean(flow.isBidirectional),
      txCount: Number(flow.txCount || 0),
      assetCount: Number(flow.assetCount || 1),
      magnitudeEstimate: memoryFlowMagnitude(flow),
      evidence: {
        flowKey: flow.key,
        txDigests: flow.txDigests || txDigestsFromEdges([flow]),
      },
    }))
    .sort((a, b) => b.magnitudeEstimate - a.magnitudeEstimate || b.txCount - a.txCount)
    .slice(0, 10);

  const patterns = [];
  const seedOut = displayEdges.filter((flow) => flow.from === graph.seedAddress).length;
  const seedIn = displayEdges.filter((flow) => flow.to === graph.seedAddress).length;
  if (seedOut >= 3) {
    patterns.push({
      type: "seed_fan_out",
      description: `The seed address has ${seedOut} outgoing visual flows in the current visible graph.`,
      evidence_edges: displayEdges.filter((flow) => flow.from === graph.seedAddress).map((flow) => flow.key).slice(0, 10),
      txDigests: uniqueList(displayEdges.filter((flow) => flow.from === graph.seedAddress).flatMap((flow) => flow.txDigests || [])).slice(0, 12),
    });
  }
  if (seedIn >= 3) {
    patterns.push({
      type: "seed_fan_in",
      description: `The seed address has ${seedIn} incoming visual flows in the current visible graph.`,
      evidence_edges: displayEdges.filter((flow) => flow.to === graph.seedAddress).map((flow) => flow.key).slice(0, 10),
      txDigests: uniqueList(displayEdges.filter((flow) => flow.to === graph.seedAddress).flatMap((flow) => flow.txDigests || [])).slice(0, 12),
    });
  }
  const convergenceNodes = importantNodes.filter((node) => node.metrics.in_degree >= 2 && node.address !== graph.seedAddress);
  for (const node of convergenceNodes.slice(0, 3)) {
    patterns.push({
      type: "possible_convergence_node",
      description: `${node.shortAddress} receives multiple visible flows and may be worth reviewing as a convergence point in this graph.`,
      targetNodeId: node.address,
      evidence_edges: node.evidence.flowKeys,
      txDigests: node.evidence.txDigests,
    });
  }
  const protocolFlows = displayEdges.filter((flow) => flow.isBidirectional || String(flow.from).startsWith("protocol:") || String(flow.to).startsWith("protocol:"));
  if (protocolFlows.length) {
    patterns.push({
      type: "protocol_or_bidirectional_activity",
      description: `${protocolFlows.length} visible flow(s) involve protocol nodes or bidirectional interactions and should be inspected before interpretation.`,
      evidence_edges: protocolFlows.map((flow) => flow.key).slice(0, 10),
      txDigests: uniqueList(protocolFlows.flatMap((flow) => flow.txDigests || [])).slice(0, 12),
    });
  }

  const analystLabels = visibleNodes
    .filter((node) => (node.labels || []).length > 0)
    .map((node) => ({
      address: node.address || node.id,
      shortAddress: node.shortAddress || shortAddress(node.address || node.id),
      labels: node.labels,
    }));

  return {
    kind: "sui-caseflow/rules-summary",
    schema_version: "0.1",
    generated_at: new Date(createdAtMs).toISOString(),
    generated_at_ms: createdAtMs,
    seedAddress: graph.seedAddress,
    graph_stats: {
      visible_node_count: visibleNodes.length,
      visible_display_flow_count: displayEdges.length,
      visible_raw_flow_count: rawVisibleEdges.length,
      tx_count: txDigestsFromEdges(rawVisibleEdges).length,
      source_tx_count: trace?.txCount || graph.timeline?.length || 0,
      dust_filter_enabled: dustFilterEnabled,
    },
    visible_nodes: visibleNodes.map((node) => ({
      address: node.address || node.id,
      shortAddress: node.shortAddress || shortAddress(node.address || node.id),
      labels: node.labels || [],
    })).slice(0, 40),
    important_nodes: importantNodes,
    important_flows: importantFlows,
    patterns,
    analyst_labels: analystLabels,
    suggested_next_actions: suggestedNextActions,
    case_memory_reference: {
      kind: caseMemory.kind,
      summary: caseMemory.summary,
    },
  };
}


function firstUsefulAiText(aiNotes, field) {
  const value = aiNotes?.[field];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    if (first) return first.trim();
    const claim = value.find((item) => item && typeof item.claim === "string" && item.claim.trim());
    if (claim) return claim.claim.trim();
  }
  return "";
}

function topSuggestedAction(caseMemory) {
  const actions = Array.isArray(caseMemory?.suggestedNextActions) ? caseMemory.suggestedNextActions : [];
  return actions.find((action) => action.priority === "high") || actions[0] || null;
}

function memwalImportantNodes(rulesSummary, limit = 6) {
  return (rulesSummary?.important_nodes || []).slice(0, limit).map((node) => ({
    address: node.address,
    address_short: node.shortAddress || shortAddress(node.address),
    labels: node.labels || [],
    reason: node.reason || "important visible node",
    metrics: node.metrics || {},
    evidence: node.evidence || {},
  }));
}

function memwalVisibleNodes(rulesSummary, caseMemory, nextAction = null, limit = 50) {
  const seedAddress = rulesSummary?.seedAddress || caseMemory?.seedAddress || "";
  const targetNodeId = nextAction?.targetNodeId || "";
  const importantAddresses = new Set((rulesSummary?.important_nodes || []).map((node) => node.address).filter(Boolean));
  const labeledAddresses = new Set([
    ...(rulesSummary?.analyst_labels || []),
    ...(caseMemory?.labels || []),
  ].map((node) => node.address || node.id).filter(Boolean));
  return (rulesSummary?.visible_nodes || [])
    .map((node, index) => ({
      address: node.address,
      address_short: node.shortAddress || node.address_short || shortAddress(node.address),
      labels: node.labels || [],
      index,
      priority: (labeledAddresses.has(node.address) ? 1000 : 0)
        + (node.address === seedAddress ? 900 : 0)
        + (node.address === targetNodeId ? 800 : 0)
        + (importantAddresses.has(node.address) ? 500 : 0),
    }))
    .filter((node) => node.address)
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, limit)
    .map(({ index, priority, ...node }) => node);
}

function memwalLabeledNodes(rulesSummary, caseMemory, limit = 20) {
  const nodes = [
    ...(rulesSummary?.analyst_labels || []),
    ...(caseMemory?.labels || []),
  ];
  const byAddress = new Map();
  for (const node of nodes) {
    const address = node.address || node.id;
    if (!address) continue;
    const existing = byAddress.get(address) || {
      address,
      address_short: node.shortAddress || node.address_short || shortAddress(address),
      labels: [],
    };
    existing.labels = uniqueList([...(existing.labels || []), ...(node.labels || [])]);
    byAddress.set(address, existing);
  }
  return Array.from(byAddress.values())
    .filter((node) => node.labels.length > 0)
    .slice(0, limit);
}

function memwalTraceBoundaries(rulesSummary) {
  const boundaryLabels = new Map([
    ["exchange_suspect", {
      reason: "Analyst-provided exchange_suspect label. Further normal expansion may introduce unrelated service or exchange flows.",
      recommended_action: "verify_before_expanding",
    }],
    ["known_entity", {
      reason: "Analyst-provided known_entity label. Treat this as a verification boundary before following unrelated entity flows.",
      recommended_action: "verify_before_expanding",
    }],
    ["known_exchange", {
      reason: "Analyst-provided known_exchange label. Treat this as an exchange boundary and verify context before expanding service-side activity.",
      recommended_action: "verify_before_expanding",
    }],
    ["bridge", {
      reason: "Analyst-provided bridge label. Inspect bridge event details, amount, timestamp, and continuation evidence before expanding service-side flows.",
      recommended_action: "inspect_bridge_evidence",
    }],
    ["bridge_contract", {
      reason: "Analyst-provided bridge_contract label. Inspect bridge event details, amount, timestamp, and continuation evidence before expanding service-side flows.",
      recommended_action: "inspect_bridge_evidence",
    }],
  ]);
  return (rulesSummary?.analyst_labels || [])
    .flatMap((node) => (node.labels || [])
      .filter((label) => boundaryLabels.has(label))
      .map((label) => ({
        address: node.address,
        address_short: node.shortAddress || shortAddress(node.address),
        boundary_type: label,
        source: "analyst_label",
        reason: boundaryLabels.get(label).reason,
        recommended_action: boundaryLabels.get(label).recommended_action,
      })))
    .slice(0, 6);
}

function memwalPatternTypes(rulesSummary) {
  const patterns = (rulesSummary?.patterns || []).map((pattern) => pattern.type).filter(Boolean);
  const actions = (rulesSummary?.suggested_next_actions || []).map((action) => memoryActionType(action)).filter(Boolean);
  return uniqueList([...patterns, ...actions]).slice(0, 12);
}

function memwalTokenSymbols(rulesSummary) {
  return uniqueList((rulesSummary?.important_flows || [])
    .flatMap((flow) => String(flow.label || "").match(/\b[A-Z][A-Z0-9]{1,10}\b/g) || [])
    .filter((symbol) => !["TX", "TXS"].includes(symbol)))
    .slice(0, 12);
}

function memwalSearchText({ rulesSummary, aiNotes, boundaries, nextAction }) {
  const seed = shortAddress(rulesSummary?.seedAddress || "");
  const summary = firstUsefulAiText(aiNotes, "plain_language_summary")
    || `Sui investigation handoff for seed ${seed}.`;
  const topObservation = firstUsefulAiText(aiNotes, "key_observations");
  const boundaryText = boundaries.length
    ? `Trace boundaries include ${boundaries.map((boundary) => `${boundary.address_short} (${boundary.boundary_type})`).join(", ")}.`
    : "No labeled trace boundary is highlighted in the current visible graph.";
  const fallbackNextText = firstUsefulAiText(aiNotes, "next_steps") || "Review the highest-priority investigation lead.";
  const nextText = isBoundaryAction(nextAction)
    ? `${nextAction?.title || "Verify boundary"}. Treat this as a verification boundary before expanding through service or entity flows.`
    : (nextAction?.title || fallbackNextText);
  return [
    summary,
    topObservation,
    boundaryText,
    `Next best action: ${nextText}`,
  ].filter(Boolean).join(" ");
}

function memwalMemoryCardForBundle(bundle) {
  const rulesSummary = bundle.rulesSummary || {};
  const caseMemory = bundle.caseMemory || {};
  const aiNotes = bundle.aiNotes || aiNotesFromRulesSummary(rulesSummary);
  const boundaries = memwalTraceBoundaries(rulesSummary);
  const nextAction = topSuggestedAction(caseMemory) || (rulesSummary.suggested_next_actions || [])[0] || null;
  const importantNodes = memwalImportantNodes(rulesSummary);
  const visibleNodes = memwalVisibleNodes(rulesSummary, caseMemory, nextAction);
  const labeledNodes = memwalLabeledNodes(rulesSummary, caseMemory);
  const labels = uniqueList((rulesSummary.analyst_labels || []).flatMap((node) => node.labels || []));
  const summary = firstUsefulAiText(aiNotes, "plain_language_summary")
    || `Visible Sui fund-flow case for seed ${shortAddress(rulesSummary.seedAddress || caseMemory.seedAddress || "")}.`;
  const primaryLeadNode = importantNodes.find((node) => node.address !== rulesSummary.seedAddress) || importantNodes[0] || null;
  const primaryLead = isBoundaryAction(nextAction)
    ? `${nextAction?.title || "Verify boundary"}: verify this trace boundary before expanding through service or entity flows.`
    : (nextAction?.title
      || firstUsefulAiText(aiNotes, "next_steps")
      || (primaryLeadNode ? `Review ${primaryLeadNode.address_short}: ${primaryLeadNode.reason}` : "Review the visible graph and labels before expanding further."));
  const openQuestions = Array.isArray(aiNotes.open_questions) && aiNotes.open_questions.length
    ? aiNotes.open_questions.slice(0, 3).map((question) => String(question))
    : (caseMemory.suggestedNextActions || []).slice(0, 3).map((action) => action.rationale).filter(Boolean);
  const txDigests = uniqueList([
    ...(caseMemory.txDigests || []),
    ...((rulesSummary.important_flows || []).flatMap((flow) => flow.evidence?.txDigests || [])),
  ]).slice(0, 40);

  return {
    schema_version: "0.1",
    artifact_type: "memwal_memory",
    memory_type: "sui_investigation_handoff",
    intended_use: "future_memwal_remember_payload",
    generated_at: rulesSummary.generated_at || new Date(caseMemory.createdAtMs || Date.now()).toISOString(),
    generated_at_ms: rulesSummary.generated_at_ms || caseMemory.createdAtMs || Date.now(),
    root_address: rulesSummary.seedAddress || caseMemory.seedAddress || "",
    root_address_short: shortAddress(rulesSummary.seedAddress || caseMemory.seedAddress || ""),
    summary,
    primary_lead: primaryLead,
    trace_boundaries: boundaries,
    open_questions: openQuestions,
    next_best_action: nextAction ? {
      id: nextAction.id || "",
      type: memoryActionType(nextAction),
      priority: nextAction.priority || "medium",
      title: nextAction.title || "",
      rationale: nextAction.rationale || "",
      targetNodeId: nextAction.targetNodeId || "",
      targetFlowKey: nextAction.targetFlowKey || "",
      txDigests: nextAction.txDigests || [],
    } : null,
    search_text: memwalSearchText({ rulesSummary, aiNotes, boundaries, nextAction }),
    metadata: {
      network: "sui-mainnet",
      root_address: rulesSummary.seedAddress || caseMemory.seedAddress || "",
      labels,
      tokens: memwalTokenSymbols(rulesSummary),
      pattern_types: memwalPatternTypes(rulesSummary),
      boundary_types: uniqueList(boundaries.map((boundary) => boundary.boundary_type)),
      visible_nodes: visibleNodes,
      labeled_nodes: labeledNodes,
      important_nodes: importantNodes,
      tx_digests: txDigests,
      visible_counts: {
        node_count: rulesSummary.graph_stats?.visible_node_count || caseMemory.summary?.visibleNodeCount || 0,
        display_flow_count: rulesSummary.graph_stats?.visible_display_flow_count || caseMemory.summary?.visibleDisplayFlowCount || 0,
        raw_flow_count: rulesSummary.graph_stats?.visible_raw_flow_count || caseMemory.summary?.visibleFlowCount || 0,
        tx_count: rulesSummary.graph_stats?.tx_count || caseMemory.summary?.txCount || txDigests.length,
      },
      next_action_type: memoryActionType(nextAction),
    },
    source_artifacts: {
      snapshot: {
        filename: "snapshot.json",
        hash: bundle.snapshotHash || "",
      },
      report: {
        filename: "report.html",
        hash: null,
        note: "HTML report is generated from the active snapshot bundle at download or upload time.",
      },
      case_memory: {
        filename: "case_memory.json",
        hash: bundle.caseMemoryHash || "",
      },
      rules_summary: {
        filename: "rules_summary.json",
        hash: bundle.rulesSummaryHash || "",
      },
      ai_notes: {
        filename: "ai_notes.json",
        hash: bundle.aiNotesHash || "",
        generated_by: aiNotes.generated_by || "rule_template",
      },
    },
    package_manifest: "case_manifest.json",
    public_memory_boundary: "This memory card only summarizes case context, analyst labels, trace boundaries, open questions, and next actions intended for the public case package. It should not contain private analyst notes or sensitive off-chain claims.",
  };
}

async function refreshMemwalMemoryForSnapshotBundle(bundle) {
  const memwalMemory = memwalMemoryCardForBundle(bundle);
  const memwalMemoryJson = `${JSON.stringify(canonicalize(memwalMemory), null, 2)}\n`;
  const memwalMemoryHash = await sha256Hex(memwalMemoryJson);
  bundle.memwalMemory = memwalMemory;
  bundle.memwalMemoryJson = memwalMemoryJson;
  bundle.memwalMemoryHash = memwalMemoryHash;
}

function aiNotesFromRulesSummary(rulesSummary) {
  const stats = rulesSummary.graph_stats || {};
  const importantNodes = rulesSummary.important_nodes || [];
  const importantFlows = rulesSummary.important_flows || [];
  const patterns = rulesSummary.patterns || [];
  const labels = rulesSummary.analyst_labels || [];
  const actions = rulesSummary.suggested_next_actions || [];
  const topNode = importantNodes.find((node) => node.address !== rulesSummary.seedAddress) || importantNodes[0];
  const topFlow = importantFlows[0];

  const keyObservations = [
    `The visible graph currently contains ${stats.visible_node_count || 0} node(s), ${stats.visible_display_flow_count || 0} visual flow(s), and ${stats.tx_count || 0} transaction digest(s).`,
  ];
  if (topFlow) {
    keyObservations.push(`The largest highlighted visible flow is ${topFlow.label} from ${shortAddress(topFlow.from)} to ${shortAddress(topFlow.to)}.`);
  }
  if (topNode) {
    keyObservations.push(`${shortAddress(topNode.address)} is prominent in the current rules summary because ${topNode.reason}.`);
  }
  if (patterns[0]) {
    keyObservations.push(patterns[0].description);
  }
  if (labels.length) {
    keyObservations.push(`${labels.length} visible node(s) carry analyst labels that should be treated as investigation context rather than confirmed identity.`);
  }

  const hypotheses = [];
  if (topNode && topNode.address !== rulesSummary.seedAddress) {
    hypotheses.push({
      claim: `${shortAddress(topNode.address)} may be a useful lead based on visible graph structure.`,
      confidence: "medium",
      supporting_evidence: uniqueList([...(topNode.evidence?.flowKeys || []), ...(topNode.evidence?.txDigests || [])]).slice(0, 8),
    });
  }
  for (const pattern of patterns.slice(0, 2)) {
    hypotheses.push({
      claim: `${pattern.type.replace(/_/g, " ")} may be relevant to the next investigation step.`,
      confidence: "low",
      supporting_evidence: uniqueList([...(pattern.evidence_edges || []), ...(pattern.txDigests || [])]).slice(0, 8),
    });
  }

  const openQuestions = [];
  if (topNode?.address && topNode.address !== rulesSummary.seedAddress) {
    openQuestions.push(`What happens if outgoing and incoming flows around ${shortAddress(topNode.address)} are expanded further?`);
  }
  if (patterns.some((pattern) => pattern.type.includes("convergence"))) {
    openQuestions.push("Do the visible convergence patterns continue into another address or protocol interaction?");
  }
  if (labels.length) {
    openQuestions.push("Do analyst labels remain consistent after checking the linked explorer activity and additional hops?");
  }
  if (!openQuestions.length) openQuestions.push("Which visible address or flow should be expanded next to improve the investigation context?");

  const nextSteps = actions.length
    ? actions.slice(0, 5).map((action) => action.title)
    : ["Inspect the highest-value visible flow in Flow Details.", "Expand one unexpanded address connected to the seed or a labeled node."];

  return {
    schema_version: "0.1",
    generated_by: "rule_template",
    generated_at: rulesSummary.generated_at,
    plain_language_summary: `This rule-generated note summarizes visible fund-flow patterns for seed ${shortAddress(rulesSummary.seedAddress)}. Based on the current graph, the case has ${stats.visible_node_count || 0} visible node(s), ${stats.visible_display_flow_count || 0} visual flow(s), and ${stats.tx_count || 0} transaction digest(s). The observations below are deterministic investigation notes and should be used as context for continued review.`,
    key_observations: keyObservations.slice(0, 6),
    hypotheses: hypotheses.slice(0, 4),
    open_questions: openQuestions.slice(0, 5),
    next_steps: nextSteps,
    caution: "These notes describe fund-flow patterns only. They do not assert real-world identity, ownership, criminal intent, or legal conclusions.",
  };
}

function artifactManifestEntry({ filename, type, contentType, hash, content, description, generator, aiReady }) {
  return {
    filename,
    type,
    content_type: contentType,
    hash,
    size_bytes: textByteLength(content),
    description,
    ...(generator ? { generator } : {}),
    ...(typeof aiReady === "boolean" ? { ai_ready: aiReady } : {}),
  };
}

function snapshotArtifactForJson(snapshot) {
  const { snapshotHash, caseMemoryHash, metadata, ...artifact } = snapshot || {};
  return artifact;
}

async function refreshSnapshotArtifactForSnapshotBundle(bundle) {
  const snapshotArtifact = snapshotArtifactForJson(bundle.snapshot);
  const snapshotJson = `${JSON.stringify(canonicalize(snapshotArtifact), null, 2)}
`;
  const snapshotHash = await sha256Hex(snapshotJson);
  bundle.snapshotJson = snapshotJson;
  bundle.snapshotHash = snapshotHash;
  bundle.snapshot = {
    ...snapshotArtifact,
    snapshotHash,
    caseMemoryHash: bundle.caseMemoryHash,
    metadata: {
      ...bundle.metadata,
      image_url: `local://caseflow/${snapshotHash}.svg`,
      snapshot_url: `local://caseflow/${snapshotHash}.json`,
      snapshot_hash: snapshotHash,
    },
  };
  bundle.metadata = bundle.snapshot.metadata;
}

function sourceArtifactsForSnapshotBundle(bundle) {
  return {
    input_snapshot_hash: bundle?.inputSnapshotHash || bundle?.snapshotHash || "",
    rules_summary_hash: bundle?.rulesSummaryHash || "",
    case_memory_hash: bundle?.caseMemoryHash || "",
  };
}

function manifestArtifactEntriesForBundle(bundle) {
  return {
    report: {
      filename: "report.html",
      type: "report_html",
      content_type: "text/html;charset=utf-8",
      hash: null,
      size_bytes: null,
      description: "Human-readable investigation report generated from this package",
    },
    snapshot: artifactManifestEntry({
      filename: "snapshot.json",
      type: "snapshot_json",
      contentType: "application/json;charset=utf-8",
      hash: bundle.snapshotHash,
      content: bundle.snapshotJson,
      description: "Recoverable visible graph state",
    }),
    caseMemory: artifactManifestEntry({
      filename: "case_memory.json",
      type: "case_memory_json",
      contentType: "application/json;charset=utf-8",
      hash: bundle.caseMemoryHash,
      content: bundle.caseMemoryJson,
      description: "Persistent investigation memory and suggested next actions",
    }),
    rulesSummary: artifactManifestEntry({
      filename: "rules_summary.json",
      type: "rules_summary_json",
      contentType: "application/json;charset=utf-8",
      hash: bundle.rulesSummaryHash,
      content: bundle.rulesSummaryJson,
      description: "Deterministic graph summary used as AI-ready notes input",
      generator: "deterministic_rules",
      aiReady: true,
    }),
    aiNotes: artifactManifestEntry({
      filename: "ai_notes.json",
      type: "ai_notes_json",
      contentType: "application/json;charset=utf-8",
      hash: bundle.aiNotesHash,
      content: bundle.aiNotesJson,
      description: bundle.aiNotes?.generated_by === "openai"
        ? "OpenAI-generated investigation notes using the AI notes schema"
        : "Rule-generated investigation notes using the future AI notes schema",
      generator: bundle.aiNotes?.generated_by || "rule_template",
      aiReady: true,
    }),
    memwalMemory: artifactManifestEntry({
      filename: "memwal_memory.json",
      type: "agent_memory_card",
      contentType: "application/json;charset=utf-8",
      hash: bundle.memwalMemoryHash,
      content: bundle.memwalMemoryJson,
      description: "MemWal-ready compact investigation memory card for future agent recall",
      generator: "deterministic_memory_card",
      aiReady: true,
    }),
  };
}

async function refreshCaseManifestForSnapshotBundle(bundle) {
  const caseManifest = {
    kind: "sui-caseflow/case-manifest",
    version: 1,
    caseId: `case-${bundle.snapshotHash.slice(0, 12)}`,
    createdAtMs: bundle.snapshot.createdAtMs,
    network: bundle.snapshot.network,
    seedAddress: bundle.snapshot.seedAddress,
    artifacts: manifestArtifactEntriesForBundle(bundle),
    hashes: {
      snapshotHash: bundle.snapshotHash,
      caseMemoryHash: bundle.caseMemoryHash,
      rulesSummaryHash: bundle.rulesSummaryHash,
      aiNotesHash: bundle.aiNotesHash,
      memwalMemoryHash: bundle.memwalMemoryHash,
      imageHash: bundle.snapshot.image?.sha256 || "",
    },
    restore: {
      canRestoreGraph: true,
      canRestoreLabels: true,
      canRestoreViewport: true,
      canRestoreSuggestedActions: true,
      entryArtifact: "snapshot.json",
    },
  };
  const caseManifestJson = `${JSON.stringify(canonicalize(caseManifest), null, 2)}
`;
  const caseManifestHash = await sha256Hex(caseManifestJson);
  bundle.caseManifest = caseManifest;
  bundle.caseManifestJson = caseManifestJson;
  bundle.caseManifestHash = caseManifestHash;
}

async function replacePendingAiNotes(aiNotes) {
  if (!pendingSnapshot) return;
  const nextNotes = cloneValue(aiNotes);
  const aiNotesJson = `${JSON.stringify(canonicalize(nextNotes), null, 2)}
`;
  const aiNotesHash = await sha256Hex(aiNotesJson);
  pendingSnapshot.aiNotes = nextNotes;
  pendingSnapshot.aiNotesJson = aiNotesJson;
  pendingSnapshot.aiNotesHash = aiNotesHash;
  pendingSnapshot.snapshot.aiNotes = nextNotes;
  pendingSnapshot.snapshot.aiNotesHash = aiNotesHash;
  await refreshSnapshotArtifactForSnapshotBundle(pendingSnapshot);
  await refreshMemwalMemoryForSnapshotBundle(pendingSnapshot);
  await refreshCaseManifestForSnapshotBundle(pendingSnapshot);
}

async function markRuleNotesFallback(reason) {
  if (!pendingSnapshot || pendingSnapshot.aiNotes?.generated_by !== "rule_template") return;
  await replacePendingAiNotes({ ...pendingSnapshot.aiNotes, fallback_reason: reason });
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

  const suggestedNextActions = memoryAgentActionsForGraph(graph, displayEdges, visibleNodes);
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
    suggestedNextActions,
  };
  const caseMemoryJsonBase = `${JSON.stringify(canonicalize(caseMemoryBase), null, 2)}
`;
  const caseMemoryHashBase = await sha256Hex(caseMemoryJsonBase);

  const snapshotWithMemory = {
    ...snapshotCore,
    caseMemory: {
      kind: caseMemoryBase.kind,
      hash: caseMemoryHashBase,
      suggestedNextActions,
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
  const rulesSummary = rulesSummaryForGraph({
    graph,
    visibleNodes,
    rawVisibleEdges,
    displayEdges,
    caseMemory,
    suggestedNextActions,
    createdAtMs,
  });
  const rulesSummaryJson = `${JSON.stringify(canonicalize(rulesSummary), null, 2)}
`;
  const rulesSummaryHash = await sha256Hex(rulesSummaryJson);
  const snapshotInput = {
    ...snapshotCore,
    caseMemory: {
      kind: caseMemory.kind,
      hash: caseMemoryHash,
      suggestedNextActions,
    },
  };
  const snapshotInputJson = `${JSON.stringify(canonicalize(snapshotInput), null, 2)}
`;
  const inputSnapshotHash = await sha256Hex(snapshotInputJson);
  const aiNotes = restoredAiNotes && typeof restoredAiNotes === "object"
    ? cloneValue(restoredAiNotes)
    : aiNotesFromRulesSummary(rulesSummary);
  const aiNotesJson = `${JSON.stringify(canonicalize(aiNotes), null, 2)}
`;
  const aiNotesHash = await sha256Hex(aiNotesJson);
  const snapshotFinal = {
    ...snapshotInput,
    aiNotes,
    aiNotesHash,
  };
  const snapshotFinalJson = `${JSON.stringify(canonicalize(snapshotFinal), null, 2)}
`;
  const snapshotFinalHash = await sha256Hex(snapshotFinalJson);
  const caseManifestStubBundle = {
    snapshot: snapshotFinal,
    snapshotJson: snapshotFinalJson,
    snapshotHash: snapshotFinalHash,
    inputSnapshotHash,
    caseMemory,
    caseMemoryJson,
    caseMemoryHash,
    rulesSummary,
    rulesSummaryJson,
    rulesSummaryHash,
    aiNotes,
    aiNotesJson,
    aiNotesHash,
  };
  await refreshMemwalMemoryForSnapshotBundle(caseManifestStubBundle);
  await refreshCaseManifestForSnapshotBundle(caseManifestStubBundle);
  const { memwalMemory, memwalMemoryJson, memwalMemoryHash, caseManifest, caseManifestJson, caseManifestHash } = caseManifestStubBundle;
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
    inputSnapshotHash,
    caseMemory,
    caseMemoryJson,
    caseMemoryHash,
    rulesSummary,
    rulesSummaryJson,
    rulesSummaryHash,
    aiNotes,
    aiNotesJson,
    aiNotesHash,
    memwalMemory,
    memwalMemoryJson,
    memwalMemoryHash,
    caseManifest,
    caseManifestJson,
    caseManifestHash,
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
    setMintStatus("Preview ready. Generate AI notes, download files, upload to Walrus, or mint on Sui testnet.");
    els.mintDialog.showModal();
  } catch (error) {
    pendingSnapshot = null;
    const message = error.message || "Could not prepare case snapshot.";
    setMintStatus(message, "error");
    els.flowTitle.textContent = "Case Snapshot failed";
    els.flowSummary.textContent = message;
    els.flowList.innerHTML = "";
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

  const aiNotes = snapshotBundle.aiNotes || {};
  const memwalMemory = snapshotBundle.memwalMemory || {};
  const memwalBoundaries = Array.isArray(memwalMemory.trace_boundaries) ? memwalMemory.trace_boundaries : [];
  const memwalBoundaryList = memwalBoundaries.length
    ? `<ul>${memwalBoundaries.map((boundary) => `<li>${reportEscape(boundary.address_short || shortAddress(boundary.address || ""))} · ${reportEscape(boundary.boundary_type || "boundary")} · ${reportEscape(boundary.recommended_action || "verify_before_expanding")}</li>`).join("")}</ul>`
    : `<p class="muted">No trace boundaries recorded in the memory card.</p>`;
  const noteList = (items) => Array.isArray(items) && items.length
    ? `<ul>${items.map((item) => `<li>${reportEscape(typeof item === "string" ? item : item.claim || JSON.stringify(item))}</li>`).join("")}</ul>`
    : `<p class="muted">No entries.</p>`;
  const hypothesisList = Array.isArray(aiNotes.hypotheses) && aiNotes.hypotheses.length
    ? `<ul>${aiNotes.hypotheses.map((hypothesis) => `<li>${reportEscape(hypothesis.claim || "")}${hypothesis.confidence ? ` <span class="tag">${reportEscape(hypothesis.confidence)}</span>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">No hypotheses.</p>`;
  const suggestedActions = snapshot.caseMemory?.suggestedNextActions || snapshotBundle.caseMemory?.suggestedNextActions || [];
  const notesGeneratorDescription = aiNotes.generated_by === "openai"
    ? "These notes were generated by the configured OpenAI adapter from deterministic rules summary and case memory artifacts."
    : "These notes are currently generated from deterministic rules and are AI-ready. A future OpenAI adapter can produce the same schema without changing the Walrus package format.";
  const footerNotesDescription = aiNotes.generated_by === "openai"
    ? "The notes in this report were generated by the configured OpenAI adapter using the AI notes schema."
    : "The notes in v1 are rule-generated and may later be generated by an OpenAI adapter using the same schema.";
  const suggestionRows = suggestedActions.length
    ? suggestedActions.map((action) => `
      <tr>
        <td><span class="tag">${reportEscape(action.priority || "medium")}</span></td>
        <td>${reportEscape(action.title)}</td>
        <td>${reportEscape(String(memoryActionType(action)).replace(/_/g, " "))}</td>
        <td>${reportEscape(action.rationale)}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="muted">No suggested next actions.</td></tr>`;

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
      <h2>Investigation Notes</h2>
      <div class="card">
        <p class="eyebrow">${reportEscape(aiNotes.generated_by || "rule_template")} · AI-ready notes schema ${reportEscape(aiNotes.schema_version || "0.1")}</p>
        <p>${reportEscape(aiNotes.plain_language_summary || "No investigation notes were generated.")}</p>
        <h3>Key Observations</h3>
        ${noteList(aiNotes.key_observations)}
        <h3>Hypotheses</h3>
        ${hypothesisList}
        <h3>Open Questions</h3>
        ${noteList(aiNotes.open_questions)}
        <h3>Next Steps</h3>
        ${noteList(aiNotes.next_steps)}
        <p class="muted">${reportEscape(aiNotes.caution || "These notes describe fund-flow patterns only and do not assert identity, ownership, intent, or legal conclusions.")}</p>
      </div>
      <p class="muted">${reportEscape(notesGeneratorDescription)}</p>
    </section>

    <section>
      <h2>MemWal Memory Card</h2>
      <div class="card">
        <p class="eyebrow">MemWal memory · schema ${reportEscape(memwalMemory.schema_version || "0.1")}</p>
        <p>${reportEscape(memwalMemory.summary || aiNotes.plain_language_summary || "No memory card summary was generated.")}</p>
        <h3>Primary Lead</h3>
        <p>${reportEscape(memwalMemory.primary_lead || "No primary lead recorded.")}</p>
        <h3>Trace Boundaries</h3>
        ${memwalBoundaryList}
        <h3>Next Best Action</h3>
        <p>${reportEscape(memwalMemory.next_best_action?.title || memwalMemory.next_best_action || "No next action recorded.")}</p>
        <p class="muted">This compact memory card is designed for future agent recall. The full evidence remains in the case package artifacts.</p>
      </div>
    </section>

    <section>
      <h2>Suggested Next Actions</h2>
      <table><thead><tr><th>Priority</th><th>Action</th><th>Type</th><th>Rationale</th></tr></thead><tbody>${suggestionRows}</tbody></table>
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
        <p><strong>Rules summary hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotBundle.rulesSummaryHash || "")}</p>
        <p><strong>AI notes hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotBundle.aiNotesHash || "")}</p>
        <p><strong>Agent memory card hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotBundle.memwalMemoryHash || "")}</p>
        <p><strong>Case manifest hash</strong></p>
        <p class="hash">sha256:${reportEscape(snapshotBundle.caseManifestHash || "")}</p>
      </div>
    </section>

    <p class="footer">This report is generated from the visible Sui CaseFlow graph. Hidden nodes and hidden flows are excluded. The HTML report is for human review and is backed by a machine-readable Walrus case package: manifest, snapshot, case memory, rules summary, AI-ready notes, and MemWal memory artifacts. ${reportEscape(footerNotesDescription)}</p>
  </main>
</body>
</html>`;
}

async function generateAiNotesForSnapshot() {
  if (!pendingSnapshot) return;

  if (!authSession?.token) {
    setMintStatus("Connect Wallet before generating AI notes.", "error");
    await signInWithWallet();
    if (!authSession?.token) return;
  }

  els.generateAiNotesButton.disabled = true;
  setMintStatus("Generating AI investigation notes...");

  try {
    const response = await fetch("/api/ai-notes", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        rules_summary: pendingSnapshot.rulesSummary,
        case_memory: pendingSnapshot.caseMemory,
        source_artifacts: sourceArtifactsForSnapshotBundle(pendingSnapshot),
      }),
    });
    const result = await response.json().catch(() => ({}));

    if (result.fallback) {
      await markRuleNotesFallback(result.fallbackReason || "openai_unavailable");
      setMintStatus(result.message || "OpenAI provider is not configured. Using rule-generated notes.", "success");
      return;
    }

    if (!response.ok) throw new Error(result.error || "AI notes generation failed.");
    if (!result.aiNotes) throw new Error("AI notes response was empty.");

    await replacePendingAiNotes(result.aiNotes);
    setMintStatus(`AI notes generated${result.model ? ` with ${result.model}` : ""}. Download or upload when ready.`, "success");
  } catch (error) {
    await markRuleNotesFallback("openai_generation_failed");
    setMintStatus(`${error.message || "AI notes generation failed."} Using rule-generated notes.`, "error");
  } finally {
    els.generateAiNotesButton.disabled = false;
  }
}

function downloadCaseReport() {
  if (!pendingSnapshot) return;
  downloadTextFile(snapshotDownloadName("html"), buildCaseReportHtml(pendingSnapshot), "text/html;charset=utf-8");
  void recordXpEvent("download_report", pendingSnapshot.snapshotHash, {
    seedAddress: pendingSnapshot.metadata.seed_address,
    visibleNodeCount: pendingSnapshot.snapshot.visibleNodeCount,
    visibleFlowCount: pendingSnapshot.snapshot.visibleDisplayFlowCount,
    txCount: pendingSnapshot.snapshot.txDigests.length,
  });
}

function downloadSnapshotJson() {
  if (!pendingSnapshot) return;
  downloadTextFile(snapshotDownloadName("json"), pendingSnapshot.snapshotJson, "application/json;charset=utf-8");
}

function readableClientError(error, fallback = "Request failed.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "object") {
    const parts = [];
    for (const key of ["message", "details", "hint", "code", "error"]) {
      const value = error[key];
      if (!value) continue;
      parts.push(typeof value === "string" ? value : readableClientError(value, ""));
    }
    const readable = parts.filter(Boolean).join(" · ");
    if (readable) return readable;
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return String(error);
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
    let uploadSnapshotGeneratedBy = "";
    let uploadAiNotesGeneratedBy = "";
    try {
      uploadSnapshotGeneratedBy = JSON.parse(pendingSnapshot.snapshotJson)?.aiNotes?.generated_by || "";
      uploadAiNotesGeneratedBy = JSON.parse(pendingSnapshot.aiNotesJson)?.generated_by || "";
    } catch {
      uploadSnapshotGeneratedBy = "parse_failed";
      uploadAiNotesGeneratedBy = "parse_failed";
    }
    console.debug("[CaseFlow] Upload AI notes", {
      pendingGeneratedBy: pendingSnapshot.aiNotes?.generated_by || "",
      aiNotesJsonGeneratedBy: uploadAiNotesGeneratedBy,
      snapshotAiNotesGeneratedBy: uploadSnapshotGeneratedBy,
      inputSnapshotHash: pendingSnapshot.inputSnapshotHash || "",
      snapshotHash: pendingSnapshot.snapshotHash || "",
      aiNotesHash: pendingSnapshot.aiNotesHash || "",
      caseManifestHash: pendingSnapshot.caseManifestHash || "",
      memwalMemoryHash: pendingSnapshot.memwalMemoryHash || "",
    });
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
          "case_memory.json": pendingSnapshot.caseMemoryJson,
          "case_manifest.json": pendingSnapshot.caseManifestJson,
          "rules_summary.json": pendingSnapshot.rulesSummaryJson,
          "ai_notes.json": pendingSnapshot.aiNotesJson,
          "memwal_memory.json": pendingSnapshot.memwalMemoryJson,
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readableClientError(result.error, "Walrus upload failed."));

    setMintStatus("", "success");
    els.mintStatus.append(`Uploaded to Walrus quilt ${shortAddress(result.quiltId)} · `);
    els.mintStatus.append(walrusLink("report", result.files?.["report.html"]?.url || result.reportUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("snapshot", result.files?.["snapshot.json"]?.url || result.snapshotUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("memory", result.files?.["case_memory.json"]?.url || result.caseMemoryUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("manifest", result.files?.["case_manifest.json"]?.url || result.caseManifestUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("rules", result.files?.["rules_summary.json"]?.url || result.rulesSummaryUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("notes", result.files?.["ai_notes.json"]?.url || result.aiNotesUrl));
    els.mintStatus.append(" · ");
    els.mintStatus.append(walrusLink("MemWal", result.files?.["memwal_memory.json"]?.url || result.memwalMemoryUrl));
    const memwalStatusLabels = {
      saved: "Saved to MemWal",
      queued: "MemWal queued",
      skipped: "MemWal not configured",
      failed: "MemWal save failed",
    };
    const memwalStatusLabel = memwalStatusLabels[result.memwal?.status] || "";
    if (memwalStatusLabel) els.mintStatus.append(` · ${memwalStatusLabel}`);
    els.mintStatus.append(" · Saved to My Snapshots");
    setCurrentWalrusRefs({
      quilt_id: result.quiltId,
      snapshot_url: result.snapshotUrl,
      snapshot_hash: pendingSnapshot.snapshotHash,
      memwal_status: result.memwal?.status || "",
    });
    renderMemwalAssistant();
    await loadMySnapshots();
    void recordXpEvent("upload_walrus", pendingSnapshot.snapshotHash || result.quiltId, {
      seedAddress: pendingSnapshot.metadata.seed_address,
      snapshotHash: pendingSnapshot.snapshotHash,
      quiltId: result.quiltId,
      txCount: pendingSnapshot.snapshot.txDigests.length,
    });
  } catch (error) {
    setMintStatus(readableClientError(error, "Walrus upload failed."), "error");
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
els.memwalAssistantToggle.addEventListener("click", () => setMemwalAssistantOpen(!memwalAssistantOpen));
els.memwalAskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void askMemwal();
});
for (const button of document.querySelectorAll("[data-memwal-prompt]")) {
  button.addEventListener("click", () => {
    const prompt = button.getAttribute("data-memwal-prompt") || "";
    const mode = button.getAttribute("data-memwal-mode") || "ask";
    if (els.memwalAskInput) els.memwalAskInput.value = "";
    if (mode === "recall") {
      void recallStrongestMemory(prompt);
    } else {
      void askMemwal(prompt);
    }
  });
}
els.walrusRestoreButton.addEventListener("click", restoreWalrusInput);
els.walrusRestoreInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void restoreWalrusInput();
});
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
els.generateAiNotesButton.addEventListener("click", generateAiNotesForSnapshot);
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

renderMemwalAssistant();
loadTrace().catch((error) => {
  els.caseTitle.textContent = "Trace unavailable";
  els.flowSummary.textContent = error.message;
});
