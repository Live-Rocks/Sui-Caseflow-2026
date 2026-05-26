#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

function loadLocalEnv() {
  try {
    const envText = readFileSync(join(root, ".env"), "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!key || process.env[key]) continue;
      process.env[key] = valueParts.join("=").replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Local .env is optional. Production hosts usually inject env vars directly.
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 5173);
const walrusPublisherUrl = process.env.WALRUS_PUBLISHER_URL || "https://publisher.walrus-testnet.walrus.space";
const walrusAggregatorUrl = process.env.WALRUS_AGGREGATOR_URL || "https://aggregator.walrus-testnet.walrus.space";
const walrusEpochs = Number(process.env.WALRUS_EPOCHS || 5);
const maxCaseUploadBytes = 10 * 1024 * 1024;
const authNonceTtlMs = 5 * 60 * 1000;
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || "dev-caseflow-session-secret-change-me";
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const authNonces = new Map();

const xpEventConfig = {
  trace_case: { xp: 5, label: "Case traced" },
  expand_node: { xp: 3, label: "Node expanded" },
  download_report: { xp: 10, label: "Report exported" },
  upload_walrus: { xp: 25, label: "Walrus snapshot saved" },
  restore_snapshot: { xp: 8, label: "Snapshot restored" },
};

const reputationLevels = [
  { level: 1, name: "Observer", threshold: 0 },
  { level: 2, name: "Analyst", threshold: 50 },
  { level: 3, name: "Investigator", threshold: 150 },
  { level: 4, name: "Senior Investigator", threshold: 350 },
  { level: 5, name: "Case Lead", threshold: 700 },
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function hmac(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSessionToken(payload) {
  const body = base64UrlJson(payload);
  return `${body}.${hmac(body)}`;
}

function verifySessionToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) throw new Error("Invalid session token.");
  const expected = hmac(body);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Invalid session token.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.address || !isSuiAddress(payload.address)) throw new Error("Invalid session wallet.");
  if (!payload.expiresAt || Date.now() > Number(payload.expiresAt)) throw new Error("Session expired.");
  return payload;
}

function requestBearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function requireSession(req) {
  return verifySessionToken(requestBearerToken(req));
}

function cleanupAuthNonces() {
  const now = Date.now();
  for (const [nonce, entry] of authNonces.entries()) {
    if (entry.expiresAt <= now) authNonces.delete(nonce);
  }
}

function authMessage({ nonce, issuedAt }) {
  return [
    "Sign in to Sui CaseFlow",
    "",
    "This signature proves wallet ownership and does not authorize a transaction.",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function supabaseConfigured() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

async function supabaseRequest(path, { method = "GET", body, prefer = "return=representation" } = {}) {
  if (!supabaseConfigured()) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before saving snapshots.");
  }

  const response = await fetch(`${trimTrailingSlash(supabaseUrl)}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      "content-type": "application/json",
      prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || text || `Supabase returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

function isSuiAddress(address) {
  return /^0x[a-fA-F0-9]{64}$/.test(address);
}

function runTrace({ address, limit, network }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["scripts/query-sui-address.mjs", address, "--limit", String(limit), "--network", network],
      {
        cwd: root,
        maxBuffer: 12 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`Trace output was not valid JSON: ${parseError.message}`));
        }
      },
    );
  });
}

async function handleApiTrace(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const address = url.searchParams.get("address")?.trim();
  const network = url.searchParams.get("network") || "mainnet";
  const limit = Number(url.searchParams.get("limit") || 10);

  if (!address || !isSuiAddress(address)) {
    sendJson(res, 400, { error: "Enter a valid 32-byte Sui address starting with 0x." });
    return;
  }

  if (!["mainnet", "testnet", "devnet"].includes(network)) {
    sendJson(res, 400, { error: "Network must be mainnet, testnet, or devnet." });
    return;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    sendJson(res, 400, { error: "Limit must be an integer from 1 to 100." });
    return;
  }

  try {
    const trace = await runTrace({ address, limit, network });
    sendJson(res, 200, trace);
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

function readRequestJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body is too large. Maximum is ${Math.round(maxBytes / 1024 / 1024)} MiB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function walrusQuiltId(responseBody) {
  return responseBody?.blobStoreResult?.newlyCreated?.blobObject?.blobId
    || responseBody?.blobStoreResult?.alreadyCertified?.blobObject?.blobId
    || responseBody?.blobStoreResult?.markedInvalid?.blobObject?.blobId
    || "";
}

function walrusQuiltObjectId(responseBody) {
  return responseBody?.blobStoreResult?.newlyCreated?.blobObject?.id
    || responseBody?.blobStoreResult?.alreadyCertified?.blobObject?.id
    || responseBody?.blobStoreResult?.markedInvalid?.blobObject?.id
    || "";
}

function quiltReadUrl(quiltId, identifier) {
  return `${trimTrailingSlash(walrusAggregatorUrl)}/v1/blobs/by-quilt-id/${encodeURIComponent(quiltId)}/${encodeURIComponent(identifier)}`;
}

function quiltPatchReadUrl(quiltPatchId) {
  return `${trimTrailingSlash(walrusAggregatorUrl)}/v1/blobs/by-quilt-patch-id/${encodeURIComponent(quiltPatchId)}`;
}

async function uploadWalrusQuilt(artifacts) {
  const form = new FormData();
  const contentTypes = {
    "report.html": "text/html;charset=utf-8",
    "snapshot.json": "application/json;charset=utf-8",
    "case-memory.json": "application/json;charset=utf-8",
  };

  for (const [identifier, content] of Object.entries(artifacts)) {
    form.append(identifier, new Blob([content], { type: contentTypes[identifier] || "text/plain;charset=utf-8" }), identifier);
  }

  const uploadUrl = `${trimTrailingSlash(walrusPublisherUrl)}/v1/quilts?epochs=${encodeURIComponent(String(walrusEpochs))}`;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: form,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(body?.error || body?.message || text || `Walrus publisher returned HTTP ${response.status}.`);
  }

  const quiltId = walrusQuiltId(body);
  if (!quiltId) {
    throw new Error("Walrus upload succeeded but did not return a quilt ID.");
  }

  return { quiltId, objectId: walrusQuiltObjectId(body), response: body };
}

async function handleWalrusUploadCase(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to upload a case package." });
    return;
  }

  let session;
  try {
    session = requireSession(req);
  } catch (error) {
    sendJson(res, 401, { error: "Sign in with a Sui wallet before uploading to Walrus." });
    return;
  }

  if (!supabaseConfigured()) {
    sendJson(res, 503, { error: "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before uploading to Walrus." });
    return;
  }

  try {
    const payload = await readRequestJson(req, maxCaseUploadBytes);
    const artifacts = payload?.artifacts || {};
    const identifiers = ["report.html", "snapshot.json", "case-memory.json"];

    for (const identifier of identifiers) {
      if (typeof artifacts[identifier] !== "string" || !artifacts[identifier].trim()) {
        sendJson(res, 400, { error: `Missing ${identifier} artifact.` });
        return;
      }
    }

    const { quiltId, objectId, response } = await uploadWalrusQuilt(Object.fromEntries(identifiers.map((identifier) => [identifier, artifacts[identifier]])));
    const patchByIdentifier = new Map((response.storedQuiltBlobs || []).map((entry) => [entry.identifier, entry.quiltPatchId]));
    const files = Object.fromEntries(identifiers.map((identifier) => {
      const quiltPatchId = patchByIdentifier.get(identifier) || "";
      return [identifier, {
        identifier,
        url: quiltReadUrl(quiltId, identifier),
        quiltPatchId,
        patchUrl: quiltPatchId ? quiltPatchReadUrl(quiltPatchId) : "",
      }];
    }));

    const recordPayload = {
      seedAddress: payload.seedAddress,
      quiltId,
      reportUrl: files["report.html"].url,
      snapshotUrl: files["snapshot.json"].url,
      caseMemoryUrl: files["case-memory.json"].url,
      snapshotHash: payload.snapshotHash,
      caseMemoryHash: payload.caseMemoryHash,
      visibleNodeCount: payload.visibleNodeCount,
      visibleFlowCount: payload.visibleFlowCount,
      txCount: payload.txCount,
      createdAtMs: payload.createdAtMs,
    };
    const savedRecord = await saveSnapshotRecord(recordPayload, session.address);

    sendJson(res, 200, {
      quiltId,
      objectId,
      epochs: walrusEpochs,
      publisherUrl: trimTrailingSlash(walrusPublisherUrl),
      aggregatorUrl: trimTrailingSlash(walrusAggregatorUrl),
      files,
      reportUrl: files["report.html"].url,
      snapshotUrl: files["snapshot.json"].url,
      caseMemoryUrl: files["case-memory.json"].url,
      savedRecord,
      raw: response,
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

function isAllowedWalrusReadUrl(value) {
  try {
    const requested = new URL(value);
    const allowed = new URL(trimTrailingSlash(walrusAggregatorUrl));
    return requested.origin === allowed.origin && requested.pathname.startsWith("/v1/blobs/");
  } catch {
    return false;
  }
}

async function handleWalrusReadJson(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Use GET to read Walrus JSON." });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const sourceUrl = url.searchParams.get("url") || "";
  if (!isAllowedWalrusReadUrl(sourceUrl)) {
    sendJson(res, 400, { error: "Only configured Walrus aggregator blob URLs can be read." });
    return;
  }

  try {
    const response = await fetch(sourceUrl);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Walrus aggregator returned HTTP ${response.status}.`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Walrus blob was not valid JSON.");
    }
    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function handleAuthNonce(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to create a sign-in nonce." });
    return;
  }

  cleanupAuthNonces();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const message = authMessage({ nonce, issuedAt });
  authNonces.set(nonce, { message, issuedAt, expiresAt: Date.now() + authNonceTtlMs });
  sendJson(res, 200, { nonce, message, expiresAt: Date.now() + authNonceTtlMs });
}

async function verifyWalletSignature({ address, message, signature }) {
  const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify");
  await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address });
}

async function handleAuthVerify(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to verify wallet sign-in." });
    return;
  }

  try {
    const payload = await readRequestJson(req, 128 * 1024);
    const address = String(payload.address || "").trim();
    const nonce = String(payload.nonce || "").trim();
    const signature = String(payload.signature || "").trim();
    const entry = authNonces.get(nonce);

    if (!address || !isSuiAddress(address)) {
      sendJson(res, 400, { error: "Wallet address is invalid." });
      return;
    }
    if (!entry || entry.expiresAt <= Date.now()) {
      authNonces.delete(nonce);
      sendJson(res, 400, { error: "Sign-in nonce expired. Please try again." });
      return;
    }
    if (!signature) {
      sendJson(res, 400, { error: "Wallet signature is required." });
      return;
    }

    await verifyWalletSignature({ address, message: entry.message, signature });
    authNonces.delete(nonce);

    const expiresAt = Date.now() + sessionTtlMs;
    const token = createSessionToken({ address: address.toLowerCase(), issuedAt: Date.now(), expiresAt });
    sendJson(res, 200, { token, address: address.toLowerCase(), expiresAt });
  } catch (error) {
    sendJson(res, 401, { error: error.message || "Wallet signature verification failed." });
  }
}

function snapshotRecordFromPayload(payload, ownerAddress) {
  return {
    wallet_address: ownerAddress,
    seed_address: String(payload.seedAddress || ""),
    quilt_id: String(payload.quiltId || ""),
    report_url: String(payload.reportUrl || ""),
    snapshot_url: String(payload.snapshotUrl || ""),
    case_memory_url: String(payload.caseMemoryUrl || ""),
    snapshot_hash: String(payload.snapshotHash || ""),
    case_memory_hash: String(payload.caseMemoryHash || ""),
    visible_node_count: Number(payload.visibleNodeCount || 0),
    visible_flow_count: Number(payload.visibleFlowCount || 0),
    tx_count: Number(payload.txCount || 0),
    created_at_ms: Number(payload.createdAtMs || Date.now()),
  };
}

function validateSnapshotRecord(record) {
  if (!isSuiAddress(record.seed_address)) return "Snapshot seed address is invalid.";
  if (!record.quilt_id) return "Walrus quilt ID is required.";
  if (!record.report_url || !record.snapshot_url || !record.case_memory_url) return "Walrus artifact URLs are required.";
  if (!record.snapshot_hash || !record.case_memory_hash) return "Snapshot and case memory hashes are required.";
  return "";
}

async function saveSnapshotRecord(payload, ownerAddress) {
  const record = snapshotRecordFromPayload(payload, ownerAddress);
  const validationError = validateSnapshotRecord(record);
  if (validationError) throw new Error(validationError);
  const rows = await supabaseRequest("snapshot_records", { method: "POST", body: record });
  return Array.isArray(rows) ? rows[0] : rows;
}

function reputationLevelForXp(xpTotal) {
  const xp = Math.max(0, Number(xpTotal || 0));
  let current = reputationLevels[0];
  for (const level of reputationLevels) {
    if (xp >= level.threshold) current = level;
  }
  const next = reputationLevels.find((level) => level.threshold > xp) || null;
  return {
    level: current.level,
    levelName: current.name,
    xpTotal: xp,
    currentThreshold: current.threshold,
    nextLevel: next?.level || null,
    nextLevelName: next?.name || "Max level",
    nextThreshold: next?.threshold || current.threshold,
    progress: next ? Math.min(1, Math.max(0, (xp - current.threshold) / (next.threshold - current.threshold))) : 1,
  };
}

function profileResponse(row) {
  const xpTotal = Number(row?.xp_total || 0);
  const levelInfo = reputationLevelForXp(xpTotal);
  return {
    walletAddress: row?.wallet_address || "",
    xpTotal,
    level: levelInfo.level,
    levelName: levelInfo.levelName,
    nextLevel: levelInfo.nextLevel,
    nextLevelName: levelInfo.nextLevelName,
    currentThreshold: levelInfo.currentThreshold,
    nextThreshold: levelInfo.nextThreshold,
    progress: levelInfo.progress,
    updatedAt: row?.updated_at || row?.created_at || null,
  };
}

async function profileRowForWallet(walletAddress) {
  const wallet = encodeURIComponent(`eq.${walletAddress}`);
  const rows = await supabaseRequest(`analyst_profiles?wallet_address=${wallet}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function ensureAnalystProfile(walletAddress) {
  const existing = await profileRowForWallet(walletAddress);
  if (existing) return existing;
  const rows = await supabaseRequest("analyst_profiles", {
    method: "POST",
    body: { wallet_address: walletAddress, xp_total: 0, level: 1 },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateAnalystProfile(walletAddress, xpTotal) {
  const levelInfo = reputationLevelForXp(xpTotal);
  const wallet = encodeURIComponent(`eq.${walletAddress}`);
  const rows = await supabaseRequest(`analyst_profiles?wallet_address=${wallet}`, {
    method: "PATCH",
    body: {
      xp_total: levelInfo.xpTotal,
      level: levelInfo.level,
      updated_at: new Date().toISOString(),
    },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function xpEventExists(walletAddress, eventType, actionKey) {
  const wallet = encodeURIComponent(`eq.${walletAddress}`);
  const type = encodeURIComponent(`eq.${eventType}`);
  const key = encodeURIComponent(`eq.${actionKey}`);
  const rows = await supabaseRequest(`xp_events?wallet_address=${wallet}&event_type=${type}&action_key=${key}&select=id&limit=1`);
  return Array.isArray(rows) && rows.length > 0;
}

async function handleReputationMe(req, res) {
  let session;
  try {
    session = requireSession(req);
  } catch (error) {
    sendJson(res, 401, { error: error.message });
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Use GET for reputation profile." });
    return;
  }

  try {
    const profile = await ensureAnalystProfile(session.address);
    sendJson(res, 200, { profile: profileResponse(profile), levels: reputationLevels });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function handleReputationEvent(req, res) {
  let session;
  try {
    session = requireSession(req);
  } catch (error) {
    sendJson(res, 401, { error: error.message });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to record XP events." });
    return;
  }

  try {
    const payload = await readRequestJson(req, 64 * 1024);
    const eventType = String(payload.eventType || "").trim();
    const actionKey = String(payload.actionKey || "").trim();
    const config = xpEventConfig[eventType];

    if (!config) {
      sendJson(res, 400, { error: "Unknown XP event type." });
      return;
    }
    if (!actionKey || actionKey.length > 500) {
      sendJson(res, 400, { error: "XP action key is required and must be 500 characters or fewer." });
      return;
    }

    let profile = await ensureAnalystProfile(session.address);
    const exists = await xpEventExists(session.address, eventType, actionKey);
    if (exists) {
      sendJson(res, 200, { awarded: false, profile: profileResponse(profile), event: { eventType, actionKey, xpDelta: 0, label: config.label } });
      return;
    }

    try {
      await supabaseRequest("xp_events", {
        method: "POST",
        body: {
          wallet_address: session.address,
          event_type: eventType,
          xp_delta: config.xp,
          action_key: actionKey,
          metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
        },
      });
    } catch (error) {
      if (/duplicate|unique/i.test(error.message)) {
        sendJson(res, 200, { awarded: false, profile: profileResponse(profile), event: { eventType, actionKey, xpDelta: 0, label: config.label } });
        return;
      }
      throw error;
    }

    profile = await updateAnalystProfile(session.address, Number(profile.xp_total || 0) + config.xp);
    sendJson(res, 200, {
      awarded: true,
      profile: profileResponse(profile),
      event: { eventType, actionKey, xpDelta: config.xp, label: config.label },
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function handleSnapshots(req, res) {
  let session;
  try {
    session = requireSession(req);
  } catch (error) {
    sendJson(res, 401, { error: error.message });
    return;
  }

  try {
    if (req.method === "GET") {
      const wallet = encodeURIComponent(`eq.${session.address}`);
      const rows = await supabaseRequest(`snapshot_records?wallet_address=${wallet}&select=*&order=uploaded_at.desc&limit=25`);
      sendJson(res, 200, { snapshots: rows || [] });
      return;
    }

    if (req.method === "POST") {
      const payload = await readRequestJson(req, 256 * 1024);
      const record = await saveSnapshotRecord(payload, session.address);
      sendJson(res, 200, { snapshot: record });
      return;
    }

    sendJson(res, 405, { error: "Use GET or POST for snapshots." });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, normalized);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/trace")) {
    await handleApiTrace(req, res);
    return;
  }

  if (req.url?.startsWith("/api/auth/nonce")) {
    await handleAuthNonce(req, res);
    return;
  }

  if (req.url?.startsWith("/api/auth/verify")) {
    await handleAuthVerify(req, res);
    return;
  }

  if (req.url?.startsWith("/api/snapshots")) {
    await handleSnapshots(req, res);
    return;
  }

  if (req.url?.startsWith("/api/reputation/me")) {
    await handleReputationMe(req, res);
    return;
  }

  if (req.url?.startsWith("/api/reputation/events")) {
    await handleReputationEvent(req, res);
    return;
  }

  if (req.url?.startsWith("/api/walrus/read-json")) {
    await handleWalrusReadJson(req, res);
    return;
  }

  if (req.url?.startsWith("/api/walrus/upload-case")) {
    await handleWalrusUploadCase(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sui CaseFlow running at http://127.0.0.1:${port}`);
});
