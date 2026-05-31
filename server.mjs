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
const walrusEpochDaysMs = 24 * 60 * 60 * 1000;
const maxCaseUploadBytes = 10 * 1024 * 1024;
const maxAiNotesBytes = 200 * 1024;
const maxMemWalAskBytes = 64 * 1024;
const maxMemWalAskQuestionChars = 1000;
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiNotesModel = process.env.OPENAI_NOTES_MODEL || "gpt-5-nano";
const openaiNotesTimeoutMs = Number(process.env.OPENAI_NOTES_TIMEOUT_MS || 20_000);
const openaiNotesMaxOutputTokens = Math.max(300, Math.min(4000, Number(process.env.OPENAI_NOTES_MAX_OUTPUT_TOKENS || 1200)));
const openaiNotesReasoningEffort = process.env.OPENAI_NOTES_REASONING_EFFORT || "";
const openaiAskModel = process.env.OPENAI_ASK_MODEL || openaiNotesModel;
const openaiAskTimeoutMs = Number(process.env.OPENAI_ASK_TIMEOUT_MS || openaiNotesTimeoutMs || 20_000);
const openaiAskMaxOutputTokens = Math.max(200, Math.min(2000, Number(process.env.OPENAI_ASK_MAX_OUTPUT_TOKENS || 700)));
const openaiAskReasoningEffort = process.env.OPENAI_ASK_REASONING_EFFORT || openaiNotesReasoningEffort;
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

function formatErrorMessage(error, fallback = "Unknown error.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "object") {
    const parts = [];
    for (const key of ["message", "details", "hint", "code", "error"]) {
      const value = error[key];
      if (!value) continue;
      if (typeof value === "string") parts.push(value);
      else parts.push(formatErrorMessage(value, ""));
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
    const message = formatErrorMessage(data, text || `Supabase returned HTTP ${response.status}.`);
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

const memwalAskAnswerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    source_ids: { type: "array", items: { type: "string" } },
    caution: { type: "string" },
  },
  required: ["answer", "confidence", "source_ids", "caution"],
};

function normalizeAskAnswer(answer, availableSourceIds) {
  const validIds = new Set(availableSourceIds);
  const sourceIds = Array.isArray(answer?.source_ids) ? answer.source_ids.filter((id) => validIds.has(id)) : [];
  return {
    answer: safeShortText(answer?.answer || "I could not produce a grounded answer from the current case memory.", 1200),
    confidence: ["low", "medium", "high"].includes(answer?.confidence) ? answer.confidence : "low",
    source_ids: sourceIds.length ? sourceIds.slice(0, 4) : ["current_case"].filter((id) => validIds.has(id)),
    caution: safeShortText(answer?.caution || "This answer is based only on current case memory and recalled MemWal memories. Analyst labels are not confirmed entity attribution.", 500),
  };
}

function validateAskAnswerSchema(answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("Ask answer must be an object.");
  if (typeof answer.answer !== "string" || !answer.answer.trim()) throw new Error("Ask answer text is required.");
  if (!["low", "medium", "high"].includes(answer.confidence)) throw new Error("Ask confidence is invalid.");
  validateStringArray(answer.source_ids, "source_ids");
  if (typeof answer.caution !== "string" || !answer.caution.trim()) throw new Error("Ask caution is required.");
}

function stripSafeAnalystLabelPhrases(text) {
  return String(text || "")
    .replace(/analyst[-\s]labeled\s+(?:hacker|attacker|criminal|thief|scammer)/gi, "analyst label")
    .replace(/analyst[-\s]provided\s+(?:hacker|attacker|criminal|thief|scammer)\s+label/gi, "analyst label")
    .replace(/(?:labeled|labelled)\s+as\s+(?:hacker|attacker|criminal|thief|scammer)/gi, "labeled as analyst label")
    .replace(/has\s+(?:a\s+)?(?:hacker|attacker|criminal|thief|scammer)\s+label/gi, "has analyst label")
    .replace(/label\s+is\s+(?:hacker|attacker|criminal|thief|scammer)/gi, "label is analyst label")
    .replace(/(?:hacker|attacker|criminal|thief|scammer)\s+label/gi, "analyst label");
}

function validateAskAnswerSafety(answer) {
  const text = stripSafeAnalystLabelPhrases([answer.answer, answer.caution].join("\n").toLowerCase());
  const blockedPatterns = [
    new RegExp("\\b(?:is|are|was|were)\\s+(?:the\\s+)?(?:hacker|attacker|criminal|thief|scammer)\\b"),
    new RegExp("\\b(?:belongs to|owned by|controlled by|real[-\\s]?world identity)\\b"),
    new RegExp("\\b(?:guilty|illegal|committed|criminal intent|legal conclusion)\\b"),
  ];
  if (blockedPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("Ask answer safety check failed. Try asking about analyst labels or current memory more specifically.");
  }
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

function openAiReasoningConfigFor(model, effort) {
  if (!effort || !openAiUsesReasoningConfig(model)) return {};
  return { reasoning: { effort } };
}

function openAiReasoningConfig() {
  return openAiReasoningConfigFor(openaiNotesModel, openaiNotesReasoningEffort);
}

function openAiAskReasoningConfig() {
  return openAiReasoningConfigFor(openaiAskModel, openaiAskReasoningEffort);
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

function openAiResponseDebugInfo(body, options = {}) {
  return {
    id: body?.id || "",
    status: body?.status || "",
    incompleteReason: responseIncompleteReason(body),
    outputShape: responseOutputShape(body),
    model: options.model || openaiNotesModel,
    maxOutputTokens: options.maxOutputTokens || openaiNotesMaxOutputTokens,
    reasoningEffort: options.reasoningEffort || openaiNotesReasoningEffort || "not_configured",
  };
}

function logOpenAiNotesDebug(message, body) {
  console.debug(`[CaseFlow] ${message}`, openAiResponseDebugInfo(body));
}

function logOpenAiAskDebug(message, body) {
  console.debug(`[CaseFlow] ${message}`, openAiResponseDebugInfo(body, {
    model: openaiAskModel,
    maxOutputTokens: openaiAskMaxOutputTokens,
    reasoningEffort: openaiAskReasoningEffort || "not_configured",
  }));
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
    "You may reference analyst labels such as hacker, funder, exchange_suspect, known_entity, intermediate, bridge, or watch.",
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
    throw new Error(formatErrorMessage(body?.error || body?.message || body, text || `Walrus publisher returned HTTP ${response.status}.`));
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

function isWalrusBlobNotFoundError({ status, message, sourceUrl }) {
  if (Number(status) !== 404 || !isAllowedWalrusReadUrl(sourceUrl)) return false;
  return /BLOB_NOT_FOUND|blob[^\n]*not found|not found[^\n]*blob|quilt[^\n]*not found|not found[^\n]*quilt|requested blob ID does not exist/i.test(String(message || ""));
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
    if (!response.ok) {
      if (isWalrusBlobNotFoundError({ status: response.status, message: text, sourceUrl })) {
        throw new Error("This Walrus case may have expired or is no longer available on testnet.");
      }
      throw new Error("Unable to load this Walrus case right now. Please try again later.");
    }
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
  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + walrusEpochs * walrusEpochDaysMs);
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
    uploaded_at: uploadedAt.toISOString(),
    walrus_epochs: walrusEpochs,
    walrus_expires_at: expiresAt.toISOString(),
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
  const labeledNodes = normalizeLabeledNodes(metadata.labeled_nodes, 20);
  const labeledNodeText = labeledNodes
    .map((node) => `${node.address} (${node.labels.join(", ")} )`.replace(" )", ")"))
    .join("; ");
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
    labeledNodeText ? `Labeled nodes: ${labeledNodeText}` : "Labeled nodes: none recorded",
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

function normalizeLabeledNodes(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value.map((node) => {
    const address = String(node?.address || node?.id || "").trim();
    if (!address) return null;
    return {
      address,
      address_short: safeShortText(node?.address_short || node?.shortAddress || shortTextId(address), 32),
      labels: normalizeArray(node?.labels).slice(0, 8),
    };
  }).filter((node) => node && node.labels.length > 0).slice(0, limit);
}

function normalizeVisibleNodes(value, limit = 50) {
  if (!Array.isArray(value)) return [];
  return value.map((node) => {
    const address = String(node?.address || node?.id || "").trim();
    if (!address) return null;
    return {
      address,
      address_short: safeShortText(node?.address_short || node?.shortAddress || shortTextId(address), 32),
      labels: normalizeArray(node?.labels).slice(0, 8),
    };
  }).filter(Boolean).slice(0, limit);
}

function quiltIdFromWalrusUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/\/v1\/blobs\/by-quilt-id\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
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
  if (!refs.walrusCaseId) refs.walrusCaseId = quiltIdFromWalrusUrl(refs.snapshotUrl);
  return refs;
}

function parseStructuredHint(text, label) {
  const pattern = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(.+?)\\s*$`, "im");
  return String(text || "").match(pattern)?.[1]?.trim() || "";
}

function extractMemorySummary(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const skip = /^(Sui CaseFlow MemWal Memory|Restore references:|Structured hints:|Walrus Case ID:|Walrus case id:|Snapshot URL:|Manifest URL:|Report URL:|Root address:|Labels:|Labeled nodes:|Trace boundaries:|Next best action:)/i;
  return safeShortText(lines.find((line) => !skip.test(line)) || "Related Sui CaseFlow memory.", 240);
}

function labeledNodesFromText(text) {
  const value = parseStructuredHint(text, "Labeled nodes");
  if (!value || value.toLowerCase() === "none recorded") return [];
  return value.split(/;+/).map((item) => {
    const match = item.trim().match(/^(0x[a-fA-F0-9]{64})\s*\(([^)]*)\)/);
    if (!match) return null;
    return {
      address: match[1],
      address_short: shortTextId(match[1]),
      labels: normalizeArray(match[2].split(/[,|]+/)),
    };
  }).filter((node) => node && node.labels.length > 0).slice(0, 20);
}

function traceBoundaryLabelNodesFromText(text) {
  const value = parseStructuredHint(text, "Trace boundaries");
  if (!value || value.toLowerCase() === "none recorded") return [];
  return value.split(/;+/).map((item) => {
    const match = item.trim().match(/^([^()]+?)\s*\(([^)]+)\)/);
    if (!match) return null;
    return {
      address: "",
      address_short: safeShortText(match[1].trim(), 32),
      labels: normalizeArray([match[2]]),
    };
  }).filter((node) => node && node.address_short && node.labels.length > 0).slice(0, 12);
}

function tokenOverlap(left, right) {
  const a = new Set(normalizeArray(left));
  const b = new Set(normalizeArray(right));
  return Array.from(a).filter((item) => b.has(item));
}

const lowSignalRecallLabels = new Set(["seed", "swap", "protocol", "intermediate"]);

function meaningfulRecallLabels(value) {
  return normalizeArray(value).filter((label) => !lowSignalRecallLabels.has(label));
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
  const labeledNodes = labeledNodesFromText(text);
  const boundaryLabelNodes = traceBoundaryLabelNodesFromText(text);
  const currentVisibleNodes = normalizeVisibleNodes(query.visibleNodes, 50);
  const currentLabeledNodes = normalizeLabeledNodes(query.labeledNodes, 40);
  const currentAddresses = new Set([
    ...currentVisibleNodes,
    ...currentLabeledNodes,
  ].map((node) => node.address.toLowerCase()));
  const currentShorts = new Map([...currentVisibleNodes, ...currentLabeledNodes]
    .map((node) => [String(node.address_short || shortTextId(node.address)).toLowerCase(), node.address]));
  const exactSameAddressLabels = labeledNodes
    .filter((node) => currentAddresses.has(String(node.address || "").toLowerCase()));
  const boundarySameAddressLabels = boundaryLabelNodes
    .filter((node) => currentShorts.has(String(node.address_short || "").toLowerCase()))
    .map((node) => ({ ...node, address: currentShorts.get(String(node.address_short || "").toLowerCase()) || "" }));
  const sameAddressLabeledNodes = [...exactSameAddressLabels, ...boundarySameAddressLabels]
    .slice(0, 8);
  const nextBestAction = parseStructuredHint(text, "Next best action");
  const currentWalrusCaseId = String(query.currentWalrusCaseId || "").trim();
  const isCurrentCase = Boolean(currentWalrusCaseId && refs.walrusCaseId && refs.walrusCaseId === currentWalrusCaseId);
  const matchReasons = [];
  let score = recallDistanceScore(memory?.distance);

  if (rootAddress && rootAddress === String(query.rootAddress || "").toLowerCase()) {
    score += 24;
    matchReasons.push("same root address");
  }
  const sharedLabels = tokenOverlap(meaningfulRecallLabels(labels), meaningfulRecallLabels(query.labels));
  if (sharedLabels.length) {
    score += Math.min(18, sharedLabels.length * 6);
    matchReasons.push(`shared label ${sharedLabels.slice(0, 2).join(", ")}`);
  }
  const sharedBoundaries = tokenOverlap(boundaryTypes, query.boundaryTypes);
  if (sharedBoundaries.length) {
    score += Math.min(20, sharedBoundaries.length * 8);
    matchReasons.push(`shared ${sharedBoundaries[0]} boundary`);
  }
  if (sameAddressLabeledNodes.length) {
    score += 22;
    matchReasons.push(`same address has recalled label ${sameAddressLabeledNodes[0].labels[0]}`);
  }
  if (query.nextActionType && nextBestAction.toLowerCase().includes(String(query.nextActionType).replace(/_/g, " ").toLowerCase())) {
    score += 10;
    matchReasons.push("similar next action");
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
    labeledNodes: labeledNodes.length ? labeledNodes : boundaryLabelNodes,
    sameAddressLabeledNodes,
    nextBestAction: safeShortText(nextBestAction, 140),
    summary: extractMemorySummary(text),
    referenceStatus: "unchecked",
    referenceNotice: "",
    walrusCaseId: refs.walrusCaseId,
    walrusCaseIdShort: refs.walrusCaseId ? shortTextId(refs.walrusCaseId) : "",
    snapshotUrl: refs.snapshotUrl,
    manifestUrl: refs.manifestUrl,
    reportUrl: refs.reportUrl,
    distance: Number.isFinite(Number(memory?.distance)) ? Number(memory.distance) : null,
    blobId: memory?.blob_id || memory?.blobId || "",
  };
}

async function snapshotRecordsByQuiltIds(quiltIds, walletAddress) {
  const ids = Array.from(new Set(normalizeArray(quiltIds))).filter(Boolean);
  if (!ids.length || !supabaseConfigured()) return new Map();
  const wallet = encodeURIComponent(`eq.${walletAddress}`);
  const quotedIds = ids.map((id) => `"${String(id).replace(/"/g, '\"')}"`).join(",");
  const rows = await supabaseRequest(`snapshot_records?wallet_address=${wallet}&quilt_id=in.(${encodeURIComponent(quotedIds)})&select=quilt_id,walrus_expires_at,snapshot_url,report_url`);
  return new Map((rows || []).map((row) => [row.quilt_id, row]));
}

function withoutRestoreReferenceReason(memory) {
  return {
    ...memory,
    matchReasons: (memory.matchReasons || []).filter((reason) => reason !== "has Walrus restore reference"),
  };
}

function applyUnknownRecallReference(memory) {
  return {
    ...withoutRestoreReferenceReason(memory),
    referenceStatus: "unknown",
    referenceNotice: "Memory recalled, but no active Walrus restore reference was found.",
    walrusCaseId: "",
    walrusCaseIdShort: "",
    snapshotUrl: "",
  };
}

async function applyRecallReferenceStatus(memories, walletAddress) {
  const recordMap = await snapshotRecordsByQuiltIds(memories.map((memory) => memory.walrusCaseId), walletAddress);
  const now = Date.now();
  return memories.map((memory) => {
    if (!memory.walrusCaseId) {
      return applyUnknownRecallReference(memory);
    }
    const record = recordMap.get(memory.walrusCaseId);
    if (!record) {
      return applyUnknownRecallReference(memory);
    }
    const expiresAtMs = record.walrus_expires_at ? Date.parse(record.walrus_expires_at) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
      return { ...memory, referenceStatus: "expired" };
    }
    return {
      ...memory,
      referenceStatus: "active",
      snapshotUrl: record.snapshot_url || memory.snapshotUrl,
      reportUrl: record.report_url || memory.reportUrl,
    };
  });
}

function recallQueryText(payload) {
  const labeledNodeText = normalizeLabeledNodes(payload.labeledNodes, 8)
    .map((node) => `${node.address_short} (${node.labels.join(", ")} )`.replace(" )", ")"))
    .join("; ");
  return [
    safeShortText(payload.searchText || "Sui CaseFlow investigation memory.", 1200),
    normalizeArray(payload.labels).length ? `Labels: ${normalizeArray(payload.labels).join(", ")}` : "",
    labeledNodeText ? `Labeled nodes: ${labeledNodeText}` : "",
    normalizeArray(payload.boundaryTypes).length ? `Boundary types: ${normalizeArray(payload.boundaryTypes).join(", ")}` : "",
    normalizeArray(payload.patternTypes).length ? `Pattern types: ${normalizeArray(payload.patternTypes).join(", ")}` : "",
    payload.nextActionType ? `Next action type: ${payload.nextActionType}` : "",
  ].filter(Boolean).join("\n");
}

async function recallCasesInMemWal({ payload, walletAddress, includeSameAddressLabelEvidence = false }) {
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
  const candidates = (recalled?.results || [])
    .map((memory) => rankRecallMemory(memory, payload))
    .filter((memory) => !memory.isCurrentCase)
    .filter((memory) => memory.score >= 40 || (includeSameAddressLabelEvidence && memory.sameAddressLabeledNodes.length > 0))
    .sort((a, b) => b.score - a.score || Number(a.distance ?? 999) - Number(b.distance ?? 999));
  const checked = await applyRecallReferenceStatus(candidates, walletAddress);
  const activeOrUnknown = checked
    .filter((memory) => memory.referenceStatus !== "expired")
    .slice(0, 3);
  const expiredCount = checked.filter((memory) => memory.referenceStatus === "expired").length;
  return {
    status: "ok",
    namespace,
    total: recalled?.total || 0,
    expiredCount,
    results: activeOrUnknown,
    message: activeOrUnknown.length
      ? "Related memories found."
      : expiredCount
        ? "No active related memories found. Some recalled memories may point to expired Walrus testnet data."
        : "No strong related memory found.",
  };
}

function memwalAskScopedRefusal(question) {
  return {
    ok: true,
    status: "refused",
    answer: {
      answer: "I can only answer questions about the current Sui CaseFlow workspace and recalled MemWal investigation memories.",
      confidence: "low",
      caution: "Ask MemWal is scoped to current case memory and recalled case memories; it does not answer unrelated questions.",
    },
    sources: [{ id: "current_case", type: "current_case", label: "Current case memory" }],
    sourceIds: ["current_case"],
    recalled: [],
  };
}

function isMemwalAskInScope(question) {
  const value = String(question || "").trim().toLowerCase();
  if (!value) return false;
  const naturalInvestigation = /^(what|why|where|which|how|is this|should i|can i|do i|tell me|summarize|explain)\b/.test(value)
    && /\b(this|case|one|next|important|look|check|verify|trace|stop|related|memory|flow|node|address|label|lead)\b/.test(value);
  const scopedKeywords = /\b(case|address|wallet|memory|memwal|flow|fund|trace|label|boundary|next|verify|recall|walrus|snapshot|report|node|transaction|tx|sui|usdc|exchange|bridge|hacker|intermediate|known_entity|exchange_suspect|lead|expand|restore)\b/.test(value);
  const zhScopedKeywords = /案件|地址|錢包|記憶|資金|流向|金流|追蹤|標籤|邊界|下一步|驗證|召回|相關|快照|報告|節點|交易|交易所|橋|駭客|中繼|展開|復原|重要|看看|為什麼|哪裡/.test(value);
  return naturalInvestigation || scopedKeywords || zhScopedKeywords;
}

function safeAskCurrentMemory(payload) {
  return {
    searchText: safeShortText(payload.searchText || "", 2200),
    rootAddress: safeShortText(payload.rootAddress || "", 90),
    labels: normalizeArray(payload.labels).slice(0, 12),
    boundaryTypes: normalizeArray(payload.boundaryTypes).slice(0, 12),
    patternTypes: normalizeArray(payload.patternTypes).slice(0, 12),
    nextActionType: safeShortText(payload.nextActionType || "", 80),
    nextBestAction: payload.nextBestAction && typeof payload.nextBestAction === "object" ? {
      type: safeShortText(payload.nextBestAction.type || payload.nextBestAction.action_type || "", 80),
      title: safeShortText(payload.nextBestAction.title || "", 180),
      rationale: safeShortText(payload.nextBestAction.rationale || "", 260),
    } : null,
    traceBoundaries: Array.isArray(payload.traceBoundaries) ? payload.traceBoundaries.slice(0, 4).map((boundary) => ({
      address_short: safeShortText(boundary?.address_short || "", 32),
      boundary_type: safeShortText(boundary?.boundary_type || "", 80),
      recommended_action: safeShortText(boundary?.recommended_action || "", 100),
    })) : [],
    visibleNodes: normalizeVisibleNodes(payload.visibleNodes, 50),
    labeledNodes: normalizeLabeledNodes(payload.labeledNodes, 20),
  };
}

function safeAskMemorySummary(memory, index) {
  return {
    source_id: "memory_" + (index + 1),
    summary: safeShortText(memory.summary || "Related memory.", 500),
    rootAddressShort: safeShortText(memory.rootAddressShort || "", 32),
    confidence: memory.confidence || "Medium match",
    matchReasons: (memory.matchReasons || []).slice(0, 4),
    labels: (memory.labels || []).slice(0, 8),
    boundaryTypes: (memory.boundaryTypes || []).slice(0, 8),
    labeledNodes: normalizeLabeledNodes(memory.labeledNodes, 12),
    sameAddressLabeledNodes: normalizeLabeledNodes(memory.sameAddressLabeledNodes, 8),
    nextBestAction: safeShortText(memory.nextBestAction || "", 180),
    walrusCaseIdShort: safeShortText(memory.referenceStatus === "active" ? memory.walrusCaseIdShort || "" : "", 32),
    referenceStatus: memory.referenceStatus || "unknown",
    referenceNotice: safeShortText(memory.referenceNotice || "", 180),
  };
}

function askAvailableSources(recalled) {
  const sources = [{ id: "current_case", type: "current_case", label: "Current case memory" }];
  if (!recalled.length) {
    sources.push({ id: "no_recalled_memory", type: "no_recalled_memory", label: "No related MemWal memory found" });
    return sources;
  }
  for (const [index, memory] of recalled.entries()) {
    sources.push({
      id: "memory_" + (index + 1),
      type: "recalled_memory",
      label: memory.referenceStatus === "active" && memory.walrusCaseIdShort ? "Walrus ID: " + memory.walrusCaseIdShort : "Related memory " + (index + 1),
      walrusCaseId: memory.referenceStatus === "active" ? memory.walrusCaseId || "" : "",
      snapshotUrl: memory.referenceStatus === "active" ? memory.snapshotUrl || "" : "",
    });
  }
  return sources;
}

function memwalAskSystemPrompt() {
  return [
    "You are Ask MemWal inside Sui CaseFlow, a bounded investigation memory assistant.",
    "Answer only from current_case_memory and recalled_memories. Do not query the blockchain, read Walrus, use outside knowledge, or invent addresses, labels, transaction digests, Walrus IDs, entities, or evidence.",
    "",
    "current_case_memory is the currently visible workspace. recalled_memories are past MemWal memories from saved cases. If recalled_memories is empty, say no related MemWal memory directly matched and answer only from current_case_memory.",
    "",
    "For label or memory questions, treat memory as recalled_memories first. Prioritize same-address matches between current_case_memory.visibleNodes and recalled_memories.labeledNodes / sameAddressLabeledNodes. Clearly distinguish current-case labels, recalled-memory labels, and same-address recalled labels; never describe a recalled label as a confirmed current-case label unless current_case_memory.labeledNodes contains it.",
    "",
    "For trace-boundary or stop questions, if a current visible address appears in recalled memory with analyst-provided exchange_suspect, known_entity, known_exchange, bridge, or bridge_contract labels, treat it as memory-backed boundary evidence and prefer verify/stop wording over expand wording.",
    "",
    "Analyst labels, including hacker, funder, exchange_suspect, known_entity, intermediate, bridge, and watch, are analyst-provided context, not confirmed attribution. Do not infer real-world identity, ownership, criminal intent, illegality, guilt, or legal conclusions.",
    "",
    "Keep the answer concise but useful: usually 3 to 6 sentences in up to 2 short paragraphs. For verification, boundary, or comparison questions, use the second paragraph for the key evidence. Do not turn the answer into a full report or list every node. Do not use fixed headings. Do not write a Caution sentence inside answer; use the separate caution field. Use only source_ids from available_sources and include current_case when current case memory supports the answer.",
  ].join("\n");
}

async function generateOpenAiAskAnswer({ question, currentMemory, recalledMemories, availableSources }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openaiAskTimeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + openaiApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: openaiAskModel,
        max_output_tokens: openaiAskMaxOutputTokens,
        ...openAiAskReasoningConfig(),
        input: [
          { role: "system", content: memwalAskSystemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              question,
              current_case_memory: currentMemory,
              recalled_memories: recalledMemories,
              available_sources: availableSources.map((source) => ({
                source_id: source.id,
                type: source.type,
                label: source.label,
              })),
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "memwal_ask_answer",
            strict: true,
            schema: memwalAskAnswerSchema,
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
      throw new Error(body?.error?.message || body?.error || text || "OpenAI returned HTTP " + response.status + ".");
    }
    if (body?.status === "incomplete") {
      logOpenAiAskDebug("OpenAI ask response incomplete", body);
      throw new Error("Ask generation incomplete: " + (responseIncompleteReason(body) || "unknown") + ".");
    }
    const refusal = responseRefusalText(body);
    if (refusal) {
      logOpenAiAskDebug("OpenAI ask response refused", body);
      throw new Error("OpenAI refused to answer: " + refusal);
    }
    const outputText = responseOutputText(body);
    if (!outputText) {
      logOpenAiAskDebug("OpenAI ask response missing output text", body);
      throw new Error("OpenAI response did not include output text for Ask MemWal.");
    }
    let answer;
    try {
      answer = JSON.parse(outputText);
    } catch {
      throw new Error("OpenAI Ask response was not valid JSON.");
    }
    answer = normalizeAskAnswer(answer, availableSources.map((source) => source.id));
    validateAskAnswerSchema(answer);
    validateAskAnswerSafety(answer);
    return answer;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Ask MemWal timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function askMemWal({ payload, walletAddress }) {
  const question = String(payload.question || "").trim();
  if (!question) throw new Error("Question is required.");
  if (question.length > maxMemWalAskQuestionChars) throw new Error("Question is too long. Maximum is " + maxMemWalAskQuestionChars + " characters.");
  if (!payload?.searchText || typeof payload.searchText !== "string") throw new Error("Current case memory is required before Ask MemWal.");

  const currentMemory = safeAskCurrentMemory(payload);
  const availableCurrentSource = [{ id: "current_case", type: "current_case", label: "Current case memory" }];
  if (!isMemwalAskInScope(question)) return memwalAskScopedRefusal(question);
  if (!openaiApiKey) {
    return {
      ok: true,
      status: "skipped",
      answer: {
        answer: "OpenAI is not configured for Ask MemWal on this server.",
        confidence: "low",
        caution: "Ask MemWal requires an OpenAI provider; no chat content was saved.",
      },
      sources: availableCurrentSource,
      sourceIds: ["current_case"],
      recalled: [],
    };
  }

  const recalledResult = await recallCasesInMemWal({
    payload,
    walletAddress,
    includeSameAddressLabelEvidence: true,
  });
  const recalled = recalledResult.results || [];
  const availableSources = askAvailableSources(recalled);
  const recalledSummaries = recalled.map((memory, index) => safeAskMemorySummary(memory, index));
  const answer = await generateOpenAiAskAnswer({
    question,
    currentMemory,
    recalledMemories: recalledSummaries,
    availableSources,
  });
  const sourceMap = new Map(availableSources.map((source) => [source.id, source]));
  return {
    ok: true,
    status: recalledResult.status || "ok",
    answer: {
      answer: answer.answer,
      confidence: answer.confidence,
      caution: answer.caution,
    },
    sourceIds: answer.source_ids,
    sources: answer.source_ids.map((id) => sourceMap.get(id)).filter(Boolean),
    recalled,
    message: recalled.length ? "Answered from current case memory and recalled MemWal memories." : "Answered from current case memory. No related MemWal memory was found.",
  };
}

async function handleMemWalAsk(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to ask MemWal." });
    return;
  }
  let session;
  try {
    session = requireSession(req);
  } catch {
    sendJson(res, 401, { error: "Connect Wallet to ask MemWal." });
    return;
  }
  try {
    const payload = await readRequestJson(req, maxMemWalAskBytes);
    const result = await askMemWal({ payload, walletAddress: session.address });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 502, { error: error.message || "Ask MemWal failed." });
  }
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
      const url = new URL(req.url, `http://${req.headers.host}`);
      const includeExpired = url.searchParams.get("include_expired") === "1";
      const wallet = encodeURIComponent(`eq.${session.address}`);
      const expiryFilter = includeExpired
        ? ""
        : `&or=${encodeURIComponent(`(walrus_expires_at.is.null,walrus_expires_at.gt.${new Date().toISOString()})`)}`;
      const rows = await supabaseRequest(`snapshot_records?wallet_address=${wallet}&select=*&order=uploaded_at.desc&limit=25${expiryFilter}`);
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

  if (req.url?.startsWith("/api/memwal/ask")) {
    await handleMemWalAsk(req, res);
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
