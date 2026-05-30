#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
const maxAiNotesBytes = 200 * 1024;
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiNotesModel = process.env.OPENAI_NOTES_MODEL || "gpt-5-nano";
const openaiNotesTimeoutMs = Number(process.env.OPENAI_NOTES_TIMEOUT_MS || 20_000);
const openaiNotesMaxOutputTokens = Math.max(300, Math.min(4000, Number(process.env.OPENAI_NOTES_MAX_OUTPUT_TOKENS || 1200)));
const openaiNotesReasoningEffort = process.env.OPENAI_NOTES_REASONING_EFFORT || "";
const authNonceTtlMs = 5 * 60 * 1000;
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || "dev-caseflow-session-secret-change-me";
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const memwalAccountId = process.env.MEMWAL_ACCOUNT_ID || "";
const memwalDelegatePrivateKey = process.env.MEMWAL_DELEGATE_PRIVATE_KEY || "";
const memwalServerUrl = process.env.MEMWAL_SERVER_URL || "";
const memwalNamespacePrefix = process.env.MEMWAL_NAMESPACE_PREFIX || "sui-caseflow";
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

function sha256Hex(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
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


const aiNotesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", enum: ["0.1"] },
    generated_by: { type: "string", enum: ["openai"] },
    model: { type: "string" },
    generated_at: { type: "string" },
    plain_language_summary: { type: "string" },
    key_observations: { type: "array", items: { type: "string" } },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          supporting_evidence: { type: "array", items: { type: "string" } },
        },
        required: ["claim", "confidence", "supporting_evidence"],
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
    next_steps: { type: "array", items: { type: "string" } },
    caution: { type: "string" },
    source_artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        input_snapshot_hash: { type: "string" },
        rules_summary_hash: { type: "string" },
        case_memory_hash: { type: "string" },
      },
      required: ["input_snapshot_hash", "rules_summary_hash", "case_memory_hash"],
    },
  },
  required: [
    "schema_version",
    "generated_by",
    "model",
    "generated_at",
    "plain_language_summary",
    "key_observations",
    "hypotheses",
    "open_questions",
    "next_steps",
    "caution",
    "source_artifacts",
  ],
};

function aiNotesFallbackResponse() {
  return {
    fallback: true,
    fallbackReason: "openai_unavailable",
    message: "OpenAI provider is not configured. Using rule-generated notes.",
  };
}

function hasExactSourceArtifacts(value) {
  return value
    && typeof value === "object"
    && typeof value.input_snapshot_hash === "string"
    && typeof value.rules_summary_hash === "string"
    && typeof value.case_memory_hash === "string";
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
}

function validateAiNotesSchema(notes) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) throw new Error("AI notes must be an object.");
  for (const field of ["plain_language_summary", "caution", "schema_version", "generated_by", "model", "generated_at"]) {
    if (typeof notes[field] !== "string" || !notes[field].trim()) throw new Error(`AI notes ${field} is required.`);
  }
  if (notes.schema_version !== "0.1") throw new Error("AI notes schema_version must be 0.1.");
  if (notes.generated_by !== "openai") throw new Error("AI notes generated_by must be openai.");
  validateStringArray(notes.key_observations, "key_observations");
  validateStringArray(notes.open_questions, "open_questions");
  validateStringArray(notes.next_steps, "next_steps");
  if (!Array.isArray(notes.hypotheses)) throw new Error("hypotheses must be an array.");
  for (const hypothesis of notes.hypotheses) {
    if (!hypothesis || typeof hypothesis !== "object") throw new Error("Each hypothesis must be an object.");
    if (typeof hypothesis.claim !== "string") throw new Error("Each hypothesis claim must be a string.");
    if (!["low", "medium", "high"].includes(hypothesis.confidence)) throw new Error("Hypothesis confidence is invalid.");
    validateStringArray(hypothesis.supporting_evidence, "hypothesis.supporting_evidence");
  }
  if (!hasExactSourceArtifacts(notes.source_artifacts)) throw new Error("AI notes source_artifacts is incomplete.");
}

function aiNotesSafetyText(notes) {
  return [
    notes.plain_language_summary,
    ...(notes.key_observations || []),
    ...(notes.hypotheses || []).map((hypothesis) => hypothesis.claim),
    ...(notes.open_questions || []),
    ...(notes.next_steps || []),
  ].join("\n");
}

function validateAiNotesSafety(notes) {
  const text = aiNotesSafetyText(notes).toLowerCase();
  const blockedPatterns = [
    /\b(?:is|are|was|were)\s+(?:the\s+)?(?:hacker|attacker|criminal|thief|scammer)\b/,
    /\b(?:belongs to|owned by|controlled by|real[-\s]?world identity)\b/,
    /\b(?:guilty|illegal|committed|criminal intent|legal conclusion)\b/,
  ];
  if (blockedPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("AI notes safety check failed. Using rule-generated notes.");
  }
}

function clipArray(value, maxItems) {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

function normalizeAiNotesForHandoff(notes) {
  return {
    ...notes,
    key_observations: clipArray(notes.key_observations, 4),
    hypotheses: clipArray(notes.hypotheses, 2),
    open_questions: clipArray(notes.open_questions, 2),
    next_steps: clipArray(notes.next_steps, 2),
  };
}

function openAiUsesReasoningConfig(model) {
  const normalized = String(model || "").toLowerCase();
  return normalized.startsWith("gpt-5") || /^o\d/.test(normalized);
}

function openAiReasoningConfig() {
  if (!openaiNotesReasoningEffort || !openAiUsesReasoningConfig(openaiNotesModel)) return {};
  return { reasoning: { effort: openaiNotesReasoningEffort } };
}

function responseIncompleteReason(body) {
  const reason = body?.incomplete_details?.reason || body?.incomplete_details?.code || "";
  if (!reason) return "";
  return typeof reason === "string" ? reason : JSON.stringify(reason);
}

function responseOutputShape(body) {
  return (body?.output || []).map((output) => ({
    type: output?.type || "unknown",
    status: output?.status || "",
    contentTypes: (output?.content || []).map((item) => item?.type || (item?.text ? "text" : typeof item)),
  }));
}

function openAiResponseDebugInfo(body) {
  return {
    id: body?.id || "",
    status: body?.status || "",
    incompleteReason: responseIncompleteReason(body),
    outputShape: responseOutputShape(body),
    model: openaiNotesModel,
    maxOutputTokens: openaiNotesMaxOutputTokens,
    reasoningEffort: openaiNotesReasoningEffort || "not_configured",
  };
}

function logOpenAiNotesDebug(message, body) {
  console.debug(`[CaseFlow] ${message}`, openAiResponseDebugInfo(body));
}

function responseRefusalText(body) {
  for (const output of body?.output || []) {
    for (const item of output?.content || []) {
      if (item?.type === "refusal" && typeof item.refusal === "string") return item.refusal;
    }
  }
  return "";
}

function responseOutputText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text;
  for (const output of body?.output || []) {
    for (const item of output?.content || []) {
      if (item?.type === "output_text" && typeof item.text === "string" && item.text.trim()) return item.text;
      if (typeof item?.text === "string" && item.text.trim()) return item.text;
      if (typeof item?.json === "object") return JSON.stringify(item.json);
    }
  }
  return "";
}

function aiNotesSystemPrompt() {
  return [
    "You are an investigation note assistant for on-chain fund-flow analysis.",
    "Write a concise investigation handoff note, not a complete report.",
    "Your job is to identify the most useful lead in the current visible graph and explain what to check next.",
    "You do not query the blockchain, read Walrus, or infer facts outside the provided JSON.",
    "Only use evidence present in rules_summary, case_memory, and source_artifacts.",
    "Do not invent addresses, transaction digests, labels, entities, or evidence.",
    "If evidence is insufficient, say so clearly.",
    "Only describe fund-flow patterns and investigation handoff context.",
    "Neutral inference is allowed when grounded in the visible graph and analyst labels.",
    "Do not infer real-world identity, ownership, criminal intent, illegality, guilt, or legal conclusions.",
    "Keep plain_language_summary to exactly 2 concise sentences: first describe the primary fund-flow direction, then name the most important lead.",
    "Return at most 4 key_observations, 2 hypotheses, 2 open_questions, and 2 next_steps.",
    "Prioritize the most useful investigation lead, not every visible fact.",
    "Use short addresses such as 0xabc...123def unless the exact full address is necessary for evidence.",
    "Avoid repeating the same flow or pattern across summary, observations, and hypotheses.",
    "Make next_steps concrete actions such as expand a specific node, inspect a specific flow, or verify a specific analyst-labeled entity.",
    "You may reference analyst labels such as hacker, exchange_suspect, known_entity, intermediate, bridge, or watch.",
    "Always phrase labels as analyst-provided or analyst-labeled, for example analyst-labeled hacker.",
    "If the seed or important nodes have analyst labels, mention the label context at least once.",
    "Do not treat analyst labels as confirmed on-chain facts.",
  ].join("\n");
}

async function generateOpenAiNotes({ rulesSummary, caseMemory, sourceArtifacts }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openaiNotesTimeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: openaiNotesModel,
        max_output_tokens: openaiNotesMaxOutputTokens,
        ...openAiReasoningConfig(),
        input: [
          { role: "system", content: aiNotesSystemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              rules_summary: rulesSummary,
              case_memory: caseMemory,
              source_artifacts: sourceArtifacts,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ai_investigation_notes",
            strict: true,
            schema: aiNotesSchema,
          },
        },
      }),
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.error || text || `OpenAI returned HTTP ${response.status}.`);
    }
    if (body?.status === "incomplete") {
      const reason = responseIncompleteReason(body) || "unknown";
      logOpenAiNotesDebug("OpenAI notes response incomplete", body);
      throw new Error(`AI notes generation incomplete: ${reason}. Try increasing OPENAI_NOTES_MAX_OUTPUT_TOKENS or lowering reasoning effort.`);
    }
    const refusal = responseRefusalText(body);
    if (refusal) {
      logOpenAiNotesDebug("OpenAI notes response refused", body);
      throw new Error(`OpenAI refused to generate AI notes: ${refusal}`);
    }
    const outputText = responseOutputText(body);
    if (!outputText) {
      logOpenAiNotesDebug("OpenAI notes response missing output text", body);
      const reason = responseIncompleteReason(body);
      const statusSuffix = body?.status ? ` status: ${body.status}.` : "";
      const reasonSuffix = reason ? ` incomplete reason: ${reason}.` : "";
      throw new Error(`OpenAI response did not include output text.${statusSuffix}${reasonSuffix}`);
    }
    let aiNotes;
    try {
      aiNotes = JSON.parse(outputText);
    } catch {
      throw new Error("OpenAI response was not valid JSON.");
    }
    aiNotes = normalizeAiNotesForHandoff({
      ...aiNotes,
      schema_version: "0.1",
      generated_by: "openai",
      model: openaiNotesModel,
      generated_at: new Date().toISOString(),
      source_artifacts: sourceArtifacts,
    });
    validateAiNotesSchema(aiNotes);
    validateAiNotesSafety(aiNotes);
    return aiNotes;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("AI notes generation timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAiNotes(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to generate AI notes." });
    return;
  }

  try {
    requireSession(req);
  } catch {
    sendJson(res, 401, { error: "Connect Wallet before generating AI notes." });
    return;
  }

  if (!openaiApiKey) {
    sendJson(res, 200, aiNotesFallbackResponse());
    return;
  }

  try {
    const payload = await readRequestJson(req, maxAiNotesBytes);
    const rulesSummary = payload?.rules_summary;
    const caseMemory = payload?.case_memory;
    const sourceArtifacts = payload?.source_artifacts;

    if (!rulesSummary || typeof rulesSummary !== "object" || Array.isArray(rulesSummary)) {
      sendJson(res, 400, { error: "rules_summary is required." });
      return;
    }
    if (!caseMemory || typeof caseMemory !== "object" || Array.isArray(caseMemory)) {
      sendJson(res, 400, { error: "case_memory is required." });
      return;
    }
    if (!hasExactSourceArtifacts(sourceArtifacts)) {
      sendJson(res, 400, { error: "source_artifacts must include input_snapshot_hash, rules_summary_hash, and case_memory_hash." });
      return;
    }

    const aiNotes = await generateOpenAiNotes({ rulesSummary, caseMemory, sourceArtifacts });
    sendJson(res, 200, { ok: true, model: aiNotes.model, aiNotes });
  } catch (error) {
    sendJson(res, 502, { error: error.message || "AI notes generation failed." });
  }
}

function requestSizeLabel(maxBytes) {
  return maxBytes < 1024 * 1024 ? `${Math.round(maxBytes / 1024)} KiB` : `${Math.round(maxBytes / 1024 / 1024)} MiB`;
}

function readRequestJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body is too large. Maximum is ${requestSizeLabel(maxBytes)}.`));
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
    "case_memory.json": "application/json;charset=utf-8",
    "case_manifest.json": "application/json;charset=utf-8",
    "rules_summary.json": "application/json;charset=utf-8",
    "ai_notes.json": "application/json;charset=utf-8",
    "memwal_memory.json": "application/json;charset=utf-8",
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
    const identifiers = ["report.html", "snapshot.json", "case_memory.json", "case_manifest.json", "rules_summary.json", "ai_notes.json", "memwal_memory.json"];

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
      caseMemoryUrl: files["case_memory.json"].url,
      caseManifestUrl: files["case_manifest.json"].url,
      snapshotHash: payload.snapshotHash,
      caseMemoryHash: payload.caseMemoryHash,
      visibleNodeCount: payload.visibleNodeCount,
      visibleFlowCount: payload.visibleFlowCount,
      txCount: payload.txCount,
      createdAtMs: payload.createdAtMs,
    };
    const savedRecord = await saveSnapshotRecord(recordPayload, session.address);
    const memwal = await rememberCaseInMemWal({ artifacts, files, quiltId, savedRecord, walletAddress: session.address });
    let updatedRecord = savedRecord;
    try {
      updatedRecord = await updateSnapshotRecordMemWal(savedRecord?.id, memwal) || savedRecord;
    } catch (error) {
      memwal.recordUpdateError = error.message || "Could not update snapshot record with MemWal metadata.";
    }

    sendJson(res, 200, {
      quiltId,
      objectId,
      epochs: walrusEpochs,
      publisherUrl: trimTrailingSlash(walrusPublisherUrl),
      aggregatorUrl: trimTrailingSlash(walrusAggregatorUrl),
      files,
      reportUrl: files["report.html"].url,
      snapshotUrl: files["snapshot.json"].url,
      caseMemoryUrl: files["case_memory.json"].url,
      caseManifestUrl: files["case_manifest.json"].url,
      rulesSummaryUrl: files["rules_summary.json"].url,
      aiNotesUrl: files["ai_notes.json"].url,
      memwalMemoryUrl: files["memwal_memory.json"].url,
      savedRecord: updatedRecord,
      memwal,
      raw: response,
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

function isAllowedWalrusReadPath(pathname) {
  return pathname.startsWith("/v1/blobs/by-quilt-id/")
    || pathname.startsWith("/v1/blobs/by-quilt-patch-id/")
    || pathname.startsWith("/v1/blobs/");
}

function isAllowedWalrusReadUrl(value) {
  try {
    const requested = new URL(value);
    const allowed = new URL(trimTrailingSlash(walrusAggregatorUrl));
    return requested.origin === allowed.origin && isAllowedWalrusReadPath(requested.pathname);
  } catch {
    return false;
  }
}

function walrusSnapshotReadUrlFromQuiltId(quiltId) {
  const id = String(quiltId || "").trim();
  if (!id || /^https?:\/\//i.test(id) || id.includes("/") || id.includes("?")) return "";
  return quiltReadUrl(id, "snapshot.json");
}

async function handleWalrusReadJson(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Use GET to read Walrus JSON." });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const sourceUrl = url.searchParams.get("url") || walrusSnapshotReadUrlFromQuiltId(url.searchParams.get("quiltId") || "");
  if (!isAllowedWalrusReadUrl(sourceUrl)) {
    sendJson(res, 400, { error: "Only configured Walrus aggregator blob URLs or Walrus Case IDs can be read." });
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

function memwalMissingConfig() {
  const missing = [];
  if (!memwalAccountId) missing.push("MEMWAL_ACCOUNT_ID");
  if (!memwalDelegatePrivateKey) missing.push("MEMWAL_DELEGATE_PRIVATE_KEY");
  if (!memwalServerUrl) missing.push("MEMWAL_SERVER_URL");
  return missing;
}

function memwalNamespaceForWallet(walletAddress) {
  const walletHash = sha256Hex(String(walletAddress || "").toLowerCase()).slice(0, 12);
  const prefix = String(memwalNamespacePrefix || "sui-caseflow").replace(/:+$/, "");
  return `${prefix}:wallet:${walletHash}`;
}

function safeShortText(value, maxLength = 800) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function shortTextId(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function memwalRememberText({ memwalMemory, quiltId, files }) {
  const metadata = memwalMemory?.metadata || {};
  const boundaries = Array.isArray(memwalMemory?.trace_boundaries) ? memwalMemory.trace_boundaries.slice(0, 6) : [];
  const nextAction = memwalMemory?.next_best_action || null;
  const labels = Array.isArray(metadata.labels) ? metadata.labels.slice(0, 12).join(", ") : "";
  const boundaryText = boundaries
    .map((boundary) => `${boundary.address_short || boundary.address || "boundary"} (${boundary.boundary_type || "boundary"}): ${boundary.recommended_action || "verify_before_expanding"}`)
    .join("; ");

  return [
    "Sui CaseFlow MemWal Memory",
    "",
    safeShortText(memwalMemory?.search_text || memwalMemory?.summary || "Sui CaseFlow investigation memory."),
    "",
    "Restore references:",
    `Walrus Case ID: ${quiltId}`,
    `Snapshot URL: ${files?.["snapshot.json"]?.url || ""}`,
    `Manifest URL: ${files?.["case_manifest.json"]?.url || ""}`,
    `Report URL: ${files?.["report.html"]?.url || ""}`,
    "",
    "Structured hints:",
    `Root address: ${memwalMemory?.root_address || metadata.root_address || ""}`,
    labels ? `Labels: ${labels}` : "Labels: none recorded",
    boundaryText ? `Trace boundaries: ${boundaryText}` : "Trace boundaries: none recorded",
    nextAction?.title ? `Next best action: ${nextAction.title}` : "Next best action: none recorded",
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

async function ensureMemWalCryptoRuntime() {
  try {
    const nodeCrypto = await import("node:crypto");
    const webcrypto = nodeCrypto.webcrypto;
    const randomUUID = nodeCrypto.randomUUID;

    if (!globalThis.crypto && webcrypto) {
      Object.defineProperty(globalThis, "crypto", {
        value: webcrypto,
        configurable: true,
      });
    }

    if (globalThis.crypto && !globalThis.crypto.randomUUID && typeof randomUUID === "function") {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: randomUUID,
        configurable: true,
      });
    }
  } catch (error) {
    throw new Error(`MemWal crypto runtime setup failed: ${error.message || "unknown error"}`);
  }
}

async function updateSnapshotRecordMemWal(recordId, memwal) {
  if (!recordId) return null;
  const id = encodeURIComponent(`eq.${recordId}`);
  const rows = await supabaseRequest(`snapshot_records?id=${id}`, {
    method: "PATCH",
    body: {
      memwal_status: memwal.status || "failed",
      memwal_namespace: memwal.namespace || "",
      memwal_job_id: memwal.jobId || "",
      memwal_blob_id: memwal.blobId || "",
      memwal_error: memwal.error || "",
      memwal_queued_at: memwal.queuedAt || null,
      memwal_saved_at: memwal.savedAt || null,
    },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function rememberCaseInMemWal({ artifacts, files, quiltId, savedRecord, walletAddress }) {
  const namespace = memwalNamespaceForWallet(walletAddress);
  const missing = memwalMissingConfig();
  if (missing.length > 0) {
    return {
      status: "skipped",
      namespace,
      error: `not_configured:${missing.join(",")}`,
      queuedAt: null,
      savedAt: null,
    };
  }

  let memwalMemory;
  try {
    memwalMemory = JSON.parse(artifacts["memwal_memory.json"] || "{}");
  } catch {
    return {
      status: "failed",
      namespace,
      error: "memwal_memory.json was not valid JSON",
      queuedAt: null,
      savedAt: null,
    };
  }

  try {
    await ensureMemWalCryptoRuntime();
    const { MemWal } = await import("@mysten-incubation/memwal");
    const client = MemWal.create({
      key: memwalDelegatePrivateKey,
      accountId: memwalAccountId,
      serverUrl: memwalServerUrl,
      namespace,
    });
    const text = memwalRememberText({ memwalMemory, quiltId, files });
    const accepted = await client.remember(text, namespace);
    const now = new Date().toISOString();
    const blobId = accepted?.blob_id || accepted?.blobId || "";
    return {
      status: blobId ? "saved" : "queued",
      namespace,
      jobId: accepted?.job_id || accepted?.jobId || "",
      blobId,
      error: "",
      queuedAt: now,
      savedAt: blobId ? now : null,
    };
  } catch (error) {
    return {
      status: "failed",
      namespace,
      error: error.message || "MemWal remember failed.",
      queuedAt: null,
      savedAt: null,
    };
  }
}


function normalizeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function parseRestoreReferences(text) {
  const refs = { walrusCaseId: "", snapshotUrl: "", manifestUrl: "", reportUrl: "" };
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(Walrus Case ID|Walrus case id|Walrus ID|Snapshot URL|Manifest URL|Report URL)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "walrus case id" || key === "walrus id") refs.walrusCaseId = value;
    if (key === "snapshot url") refs.snapshotUrl = value;
    if (key === "manifest url") refs.manifestUrl = value;
    if (key === "report url") refs.reportUrl = value;
  }
  return refs;
}

function parseStructuredHint(text, label) {
  const pattern = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(.+?)\\s*$`, "im");
  return String(text || "").match(pattern)?.[1]?.trim() || "";
}

function extractMemorySummary(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const skip = /^(Sui CaseFlow MemWal Memory|Restore references:|Structured hints:|Walrus Case ID:|Walrus case id:|Snapshot URL:|Manifest URL:|Report URL:|Root address:|Labels:|Trace boundaries:|Next best action:)/i;
  return safeShortText(lines.find((line) => !skip.test(line)) || "Related Sui CaseFlow memory.", 240);
}

function tokenOverlap(left, right) {
  const a = new Set(normalizeArray(left));
  const b = new Set(normalizeArray(right));
  return Array.from(a).filter((item) => b.has(item));
}

function recallDistanceScore(distance) {
  const value = Number(distance);
  if (!Number.isFinite(value)) return 0;
  if (value <= 0.2) return 20;
  if (value <= 0.35) return 14;
  if (value <= 0.5) return 8;
  return 0;
}

function rootFromMemoryText(text) {
  const root = parseStructuredHint(text, "Root address");
  return isSuiAddress(root) ? root.toLowerCase() : "";
}

function boundaryTypesFromText(text) {
  const value = parseStructuredHint(text, "Trace boundaries");
  return normalizeArray((value.match(/\(([^)]+)\)/g) || []).map((item) => item.replace(/[()]/g, "")));
}

function labelsFromText(text) {
  const value = parseStructuredHint(text, "Labels");
  if (!value || value.toLowerCase() === "none recorded") return [];
  return normalizeArray(value.split(/[,;]+/));
}

function rankRecallMemory(memory, query) {
  const text = String(memory?.text || "");
  const refs = parseRestoreReferences(text);
  const rootAddress = rootFromMemoryText(text);
  const labels = labelsFromText(text);
  const boundaryTypes = boundaryTypesFromText(text);
  const nextBestAction = parseStructuredHint(text, "Next best action");
  const currentWalrusCaseId = String(query.currentWalrusCaseId || "").trim();
  const isCurrentCase = Boolean(currentWalrusCaseId && refs.walrusCaseId && refs.walrusCaseId === currentWalrusCaseId);
  const matchReasons = [];
  let score = recallDistanceScore(memory?.distance);

  if (rootAddress && rootAddress === String(query.rootAddress || "").toLowerCase()) {
    score += 24;
    matchReasons.push("same root address");
  }
  const sharedLabels = tokenOverlap(labels, query.labels);
  if (sharedLabels.length) {
    score += Math.min(18, sharedLabels.length * 6);
    matchReasons.push(`shared label ${sharedLabels.slice(0, 2).join(", ")}`);
  }
  const sharedBoundaries = tokenOverlap(boundaryTypes, query.boundaryTypes);
  if (sharedBoundaries.length) {
    score += Math.min(20, sharedBoundaries.length * 8);
    matchReasons.push(`shared ${sharedBoundaries[0]} boundary`);
  }
  if (query.nextActionType && nextBestAction.toLowerCase().includes(String(query.nextActionType).replace(/_/g, " ").toLowerCase())) {
    score += 10;
    matchReasons.push("similar next action");
  }
  if (refs.walrusCaseId || refs.snapshotUrl) {
    score += 12;
    matchReasons.push("has Walrus restore reference");
  }

  return {
    score,
    confidence: score >= 70 ? "High match" : "Medium match",
    isCurrentCase,
    matchReasons: matchReasons.slice(0, 4),
    rootAddress,
    rootAddressShort: rootAddress ? shortTextId(rootAddress) : "",
    labels,
    boundaryTypes,
    nextBestAction: safeShortText(nextBestAction, 140),
    summary: extractMemorySummary(text),
    walrusCaseId: refs.walrusCaseId,
    walrusCaseIdShort: refs.walrusCaseId ? shortTextId(refs.walrusCaseId) : "",
    snapshotUrl: refs.snapshotUrl,
    manifestUrl: refs.manifestUrl,
    reportUrl: refs.reportUrl,
    distance: Number.isFinite(Number(memory?.distance)) ? Number(memory.distance) : null,
    blobId: memory?.blob_id || memory?.blobId || "",
  };
}

function recallQueryText(payload) {
  return [
    safeShortText(payload.searchText || "Sui CaseFlow investigation memory.", 1200),
    normalizeArray(payload.labels).length ? `Labels: ${normalizeArray(payload.labels).join(", ")}` : "",
    normalizeArray(payload.boundaryTypes).length ? `Boundary types: ${normalizeArray(payload.boundaryTypes).join(", ")}` : "",
    normalizeArray(payload.patternTypes).length ? `Pattern types: ${normalizeArray(payload.patternTypes).join(", ")}` : "",
    payload.nextActionType ? `Next action type: ${payload.nextActionType}` : "",
  ].filter(Boolean).join("\n");
}

async function recallCasesInMemWal({ payload, walletAddress }) {
  const namespace = memwalNamespaceForWallet(walletAddress);
  const missing = memwalMissingConfig();
  if (missing.length > 0) {
    return { status: "skipped", namespace, results: [], message: "MemWal is not configured on this server." };
  }
  await ensureMemWalCryptoRuntime();
  const { MemWal } = await import("@mysten-incubation/memwal");
  const client = MemWal.create({
    key: memwalDelegatePrivateKey,
    accountId: memwalAccountId,
    serverUrl: memwalServerUrl,
    namespace,
  });
  const recalled = await client.recall(recallQueryText(payload), 10, namespace);
  const ranked = (recalled?.results || [])
    .map((memory) => rankRecallMemory(memory, payload))
    .filter((memory) => !memory.isCurrentCase)
    .filter((memory) => memory.score >= 40)
    .filter((memory) => memory.walrusCaseId || memory.snapshotUrl)
    .sort((a, b) => b.score - a.score || Number(a.distance ?? 999) - Number(b.distance ?? 999))
    .slice(0, 3);
  return {
    status: "ok",
    namespace,
    total: recalled?.total || 0,
    results: ranked,
    message: ranked.length ? "Related memories found." : "No other related memories found yet.",
  };
}

async function handleMemWalRecall(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to recall MemWal memories." });
    return;
  }
  let session;
  try {
    session = requireSession(req);
  } catch (error) {
    sendJson(res, 401, { error: "Connect Wallet to recall your MemWal memories." });
    return;
  }
  try {
    const payload = await readRequestJson(req, 128 * 1024);
    if (!payload?.searchText || typeof payload.searchText !== "string") {
      sendJson(res, 400, { error: "Current case memory is required before recall." });
      return;
    }
    const result = await recallCasesInMemWal({ payload, walletAddress: session.address });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 502, { error: error.message || "MemWal recall failed." });
  }
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

  if (req.url?.startsWith("/api/ai-notes")) {
    await handleAiNotes(req, res);
    return;
  }

  if (req.url?.startsWith("/api/memwal/recall")) {
    await handleMemWalRecall(req, res);
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
