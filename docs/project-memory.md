# Sui CaseFlow Project Memory

This file preserves the product and implementation context that has accumulated during development. It is meant to help future Codex chats, teammates, and hackathon work sessions reconnect quickly.

## Product Positioning

Sui CaseFlow is an investigator layer for Sui fund flows. It is not trying to replace block explorers. Explorers expose raw facts; Sui CaseFlow turns those facts into a case workspace with graph tracing, labels, reports, and recoverable snapshots.

The current product direction is a free public observation tool first. Commercialization, pricing, and heavy entity intelligence are deliberately deferred until the core investigation experience is stable. AI notes are allowed, but only as a bounded handoff layer: deterministic graph analysis remains the source of truth, while AI turns structured case artifacts into readable investigation notes.

Core promise:

- Paste any Sui address.
- Trace recent fund movement.
- Expand suspicious nodes into multi-hop flows.
- Hide noise and label addresses manually.
- Export or store a case snapshot that can be reopened later.

## Current Capabilities

The app currently supports:

- Arbitrary Sui address trace through the local API server.
- Transaction limits of Last 25, Last 50, and Last 100.
- Multi-page Sui GraphQL RPC fetching so Last 100 can reach beyond the first GraphQL page.
- Visual fund-flow graph with draggable nodes, pan, zoom, fit, and undo.
- Expand node workflow with dedupe and lineage-aware layout.
- Dust / noise filter for same-transaction clutter and tiny SUI flows; current SUI threshold is `< 0.02 SUI`, while non-SUI token amounts are not dust-filtered by value.
- Direction coloring: inbound blue, outbound red, bidirectional summary gold.
- Case labels such as `hacker`, `funder`, `intermediate`, `bridge`, `exchange_suspect`, `known_entity`, and `watch`.
- Flow Details panel with transaction-level evidence and Suivision links for the selected flow; it no longer hosts Investigation Leads in the empty state.
- Case Snapshot modal with HTML report, JSON export, Walrus upload, and optional OpenAI notes generation.
- Walrus case package artifacts: `report.html`, `snapshot.json`, `case_memory.json`, `case_manifest.json`, `rules_summary.json`, `ai_notes.json`, and `memwal_memory.json`.
- Case manifest as the artifact index and integrity layer for hashes, metadata, and package references.
- Rule-based `Investigation Leads` for next investigation steps, stored in case memory and reports.
- Stop-boundary suggestions: `exchange_suspect` / `known_entity` are verification boundaries, while bridge/protocol/swap flows are inspection points rather than default expand targets.
- Sui wallet sign-in where wallet address is the user identity.
- Supabase-backed My Snapshots list for wallet-owned snapshot records.
- My Snapshots cards can copy a `Walrus Case ID` and `Snapshot URL` for handoff or debugging.
- Wallet dropdown includes `Load from Walrus`, which can restore a workspace from a Walrus Case ID or snapshot URL without requiring wallet sign-in.
- Upload to Walrus can optionally submit the compact `memwal_memory.json` search text to MemWal using app-managed storage and wallet-scoped namespaces.
- Right-bottom `MemWal Assistant` drawer with Current Case Memory, deterministic Next Action, chat timeline, `Strongest memory`, and bounded `Ask MemWal` Q&A.
- `Strongest memory` is recall-only and can build a temporary memory query from the current visible graph; the current case does not need to be uploaded first.
- `Verify next`, `Trace boundary`, and free-form input use `Ask MemWal`, which answers from current case memory plus recalled memories from the signed-in wallet’s MemWal namespace. Ask results are ephemeral UI state and are not written to MemWal, Walrus, or AI notes.
- Restore workspace from a saved Walrus snapshot, including embedded AI notes when present.
- Off-chain Analyst XP / Investigator Reputation with levels in the wallet dropdown.
- Optional testnet minting flow for snapshot NFT / certificate experiments.

## Architecture Notes

Current stack:

- Frontend: vanilla JavaScript, HTML, CSS, served by Vite in dev.
- API server: Node `server.mjs`.
- Data source: Sui GraphQL RPC through the local API server. JSON-RPC public fullnodes are deprecated and should not be used for trace / expand.
- Explorer links: Suivision.
- Persistent snapshot storage: Walrus public publisher / aggregator.
- Snapshot index: Supabase `snapshot_records` table.
- Hackathon/testnet demo retention currently recommends `WALRUS_EPOCHS=31`; each upload stores its own `walrus_epochs` and estimated `walrus_expires_at`.
- Optional recall index: MemWal remember v1, managed by the app through a delegate private key and separated by deterministic wallet namespace hashes.
- Identity: Sui wallet signature session, stored locally as a short-lived token.
- Sui GraphQL endpoint defaults use public Sui endpoints (`https://graphql.<network>.sui.io/graphql`). For higher traffic or reliability, replace them with provider URLs via `SUI_GRAPHQL_MAINNET_URL`, `SUI_GRAPHQL_TESTNET_URL`, and `SUI_GRAPHQL_DEVNET_URL`.

Development ports:

- API server: `http://127.0.0.1:5173`
- Vite frontend: `http://127.0.0.1:5174`

Recommended local startup:

```bash
node server.mjs
npm run dev
```

The old single-server command `PORT=5174 node server.mjs` is no longer the preferred dev path because wallet imports and Vite module resolution need the Vite frontend.

Production / deployment path:

- First public deployment target is Zeabur or another long-lived Node service, not a Vercel serverless refactor.
- `server.mjs` serves `/api/*` before static files, listens on `process.env.PORT` and `0.0.0.0`, and exposes `GET /healthz`.
- In `NODE_ENV=production`, `server.mjs` serves only `dist` and fails fast when `dist/index.html` is missing. It must not fallback to the repo root in production.
- `package.json` has `build` / `start` scripts for `vite build` and `node server.mjs`.
- Node is pinned to `>=20.19.0` with `.nvmrc` set to `20.19.0`; `.npmrc` uses `legacy-peer-deps=true` for clean installs with the MemWal / Sui dependency set.
- `data/sample-trace.json` remains for local fallback, while `public/data/sample-trace.json` is the production sample asset copied by Vite into `dist/data/sample-trace.json`.
- `VITE_*` values are build-time public frontend env vars. Supabase service role, OpenAI key, and MemWal delegate private key are server-only env vars and must not use a `VITE_` prefix.

## Product Preferences

Important product decisions so far:

- Keep the core tool free and useful before adding monetization.
- Prefer transparent investigator workflows over black-box AI claims.
- Do not rush React / TypeScript migration until the product direction stabilizes.
- Do not issue a testnet token for user points.
- Treat `exchange_suspect` as a cautious label, not a confirmed exchange/entity claim.
- Keep complete evidence visible through links and transaction details instead of pretending heuristics are perfect.
- Use Walrus as durable case memory / report storage, not just as a file dump.
- My Snapshots should restore the investigation workspace, not only open a static report.
- `exchange_suspect` and `known_entity` are default investigation boundaries, not default expand targets. `funder` is a high-signal funding-source label, but it is not a default trace boundary and does not block expansion by itself.
- Bridge, protocol, and swap nodes should be inspected as transition evidence before following service-side noise.
- AI and rule suggestions should help analysts choose the next lead, not encourage infinite graph expansion.
- Flow Details should stay focused on the selected flow. Investigation Leads and recall belong in the MemWal Assistant.

## Walrus / Case Memory Direction

Walrus is positioned as the durable case memory layer.

A Case Snapshot should contain:

- `report.html`: human-readable report.
- `snapshot.json`: recoverable visible graph snapshot, including active `aiNotes` when present.
- `case_memory.json`: machine-readable investigation memory and suggested actions.
- `case_manifest.json`: package index, metadata, artifact hashes, and integrity references.
- `rules_summary.json`: deterministic graph analysis used as AI and report input.
- `ai_notes.json`: rule-generated by default, optionally generated by the OpenAI adapter using the same schema.
- `memwal_memory.json`: MemWal-ready compact investigation handoff card for recall. The UI labels this artifact as `MemWal`; internally it keeps the same filename and schema, stores search text and structured metadata, and does not store final Walrus IDs or manifest hashes.
- MemWal remember v1 sends only the canonical `memwal_memory.search_text` plus compact Walrus restore references and structured hints. It must not send full `snapshot.json`, full `report.html`, full graph JSON, or full transaction lists.
- `memwal_memory.json.metadata` includes compact evidence such as `visible_nodes`, `labeled_nodes`, `important_nodes`, `trace_boundaries`, `pattern_types`, `boundary_types`, and `tx_digests`. `visible_nodes` keeps full address, short address, and labels for up to 50 nodes, prioritizing labeled nodes, seed/root, next-action target, and important nodes.
- MemWal remember text uses stable sections such as `Restore references:`, `Structured hints:`, and `Labeled nodes:` so recall can parse Walrus references and same-address analyst-label matches.

Current restore behavior is visible-snapshot restore: it restores the graph state saved in `snapshot.json`, not the full historical RPC universe. If `snapshot.json` contains embedded `aiNotes`, restored snapshots preserve those notes unless the graph changes. Old snapshots without `aiNotes` remain compatible and fall back to rule-generated notes. After restore, investigators can continue from restored nodes by expanding addresses again.

Current share / restore behavior:

- `Walrus Case ID` is the product-facing name for the internal `record.quilt_id`. It is the compact identifier users can copy from My Snapshots and paste into `Load from Walrus`.
- `Snapshot URL` is the direct technical URL for reading `snapshot.json`; it is useful for debugging, fallback restore, or handoff before the site has stable case links.
- `Load from Walrus` accepts either a Walrus Case ID or a snapshot URL and restores the workspace through the existing snapshot restore path.
- Restore by URL is intentionally restricted to the configured Walrus aggregator host and supported Walrus blob/quilt read paths. The backend must not become an arbitrary URL proxy.
- `walrus_expires_at` is an estimated expiry derived from upload time and stored `walrus_epochs`; it is used for My Snapshots / MemWal recall hygiene, not as a chain-level proof of object expiry. Expired recalled references are filtered out of MemWal Assistant results and Ask input; unknown references can remain as text memory but do not expose Restore / Copy actions.

Future Walrus direction:

- Improve report viewing through the app instead of raw browser HTML when useful.
- Before public deployment, add `APP_PUBLIC_URL` and a `Copy Case Link` flow, likely using `/restore?quiltId=<id>`.
- Opening a case link should not automatically overwrite the current workspace; it should prompt the user to restore the Walrus case.
- Potentially support private or encrypted case packages later with Seal.
- Keep public upload warnings clear because Walrus data is persistent and public in the current flow.

## MemWal Remember v1

MemWal integration is implemented as app-managed storage for the first version. CaseFlow uses one backend-managed MemWal account / delegate private key and separates user memories with deterministic wallet-scoped namespaces:

```text
sui-caseflow:wallet:<sha256(lowercase_wallet_address).slice(0, 12)>
```

This is product-level wallet isolation, not a claim that each user cryptographically owns their own MemWal account. Recommended pitch wording:

> CaseFlow manages MemWal storage through an app delegate key and separates user memories by wallet-scoped namespaces.

Upload flow order:

1. Upload the full case package to Walrus.
2. Create a Supabase `snapshot_record`.
3. Try MemWal `remember()` with compact memory text.
4. Update the same `snapshot_record` with MemWal metadata.

MemWal status fields in Supabase are `memwal_status`, `memwal_namespace`, `memwal_job_id`, `memwal_blob_id`, `memwal_error`, `memwal_queued_at`, and `memwal_saved_at`. Missing MemWal env config is treated as `skipped / not_configured`; Walrus upload and My Snapshots still work.

Current v1 behavior uses MemWal `remember()`, so a successful submission often records `memwal_status = queued`. This is normal: `queued` means MemWal accepted the background job, not that indexing has completed or that a final MemWal blob id has already been written back.

Current `.env` settings:

- `MEMWAL_ACCOUNT_ID`
- `MEMWAL_DELEGATE_PRIVATE_KEY`
- `MEMWAL_SERVER_URL`
- `MEMWAL_NAMESPACE_PREFIX=sui-caseflow`

MemWal Assistant v1 is implemented in the right-bottom drawer as a chat timeline. `Strongest memory` uses recall-only flow: the current workspace is query material, the backend recalls up to 10 MemWal memories, reranks locally, excludes the current case, and returns the top 3 relevant previous memories. `Ask MemWal` is bounded Q&A: it recalls memories, sends compact current/recalled summaries to OpenAI, and renders a structured JSON answer with source chips, confidence, and caution. The frontend renders Ask answers as readable paragraphs and uses decimal-safe splitting so amounts such as `50.00K` are not broken across paragraphs.

Ask MemWal has three guardrail layers:

- Scope check before OpenAI: `isMemwalAskInScope()` blocks clearly unrelated questions without calling OpenAI.
- System prompt to OpenAI: `memwalAskSystemPrompt()` restricts answers to current case memory and recalled MemWal memories.
- Safety check after OpenAI: `validateAskAnswerSafety()` blocks identity attribution, ownership claims, criminal intent, illegality, guilt, and legal conclusions.

Recall behavior differs by entrypoint: `Strongest memory` uses strict ranking, ignores generic `seed`, `swap`, `protocol`, and `intermediate` label matches, and does not treat Walrus restore references as relevance. If no strong memory remains, the UI says no strong related memory was found. `Ask MemWal` always keeps same-address analyst-label evidence so recalled labels on currently visible addresses can support grounded answers. Restore / copy actions are shown only when backend-validated active references are available.

Future MemWal direction:

- Tune memory card quality and recall ranking with more real cases.
- Add optional MemWal job sync so queued remember jobs can be checked later by `memwal_job_id` and updated to `saved` with `memwal_blob_id` and `memwal_saved_at` when complete. This sync must not block Walrus upload or slow the main investigation flow.
- Add a stronger profile or memory management surface if the drawer becomes crowded.
- Improve Ask MemWal answer quality, source attribution, and guardrail tuning as more real cases are tested.

## AI Notes Adapter

Current direction: AI notes are an optional enhancement layer for Case Snapshot, not the core chain-analysis engine. The deterministic graph parser, rules summary, and case memory remain the source of truth.

- Default notes are generated locally from `rules_summary.json` and `case_memory.json`.
- If `OPENAI_API_KEY` is configured, a signed-in wallet user can manually generate OpenAI notes from the same structured artifacts.
- The OpenAI adapter must output the same `ai_notes.json` schema and include `source_artifacts` hashes.
- Prompt v2 produces a concise investigation handoff note: 2-sentence summary, up to 4 observations, 2 hypotheses, 2 open questions, and 2 next steps.
- Grounded neutral inference is allowed when based on the visible graph and analyst labels. Labels must be phrased as analyst-provided context, such as `analyst-labeled hacker`, not confirmed identity.
- If OpenAI is unavailable, times out, returns invalid output, or fails safety validation, keep rule-generated notes and do not corrupt the pending snapshot.
- Notes must describe fund-flow patterns only and must not infer real-world identity, ownership, criminal intent, or legal conclusions.
- OpenAI settings live in `.env`: `OPENAI_NOTES_MODEL`, `OPENAI_NOTES_MAX_OUTPUT_TOKENS`, `OPENAI_NOTES_TIMEOUT_MS`, and optional `OPENAI_NOTES_REASONING_EFFORT`.
- `OPENAI_NOTES_REASONING_EFFORT` has no app default. It is sent only when explicitly set in `.env`, because different models support different reasoning effort values.
- Ask MemWal can override the notes settings with `OPENAI_ASK_MODEL`, `OPENAI_ASK_MAX_OUTPUT_TOKENS`, `OPENAI_ASK_TIMEOUT_MS`, and optional `OPENAI_ASK_REASONING_EFFORT`; unset Ask values fall back to the AI Notes OpenAI settings.

## Phase 4: Investigator Reputation

First version implemented: off-chain XP and levels. Wallet address is the user identity, and the app can award deduplicated XP events for real investigation actions such as trace case, expand node, download report, upload to Walrus, and restore snapshot. XP is stored in Supabase, not as a transferable token.

Current level ladder:

- Level 1: Observer, 0 XP
- Level 2: Analyst, 50 XP
- Level 3: Investigator, 150 XP
- Level 4: Senior Investigator, 350 XP
- Level 5: Case Lead, 700 XP

Future direction:

- Add better profile / reputation history UI.
- Add verification-oriented XP events if they support real analyst behavior.
- Consider daily check-in only if it supports retention without feeling like a generic task system.
- Once a wallet reaches a reputation threshold, the user may mint an Investigator Certificate.
- Do not issue a testnet token for XP. XP should behave like analyst reputation, not a tradable asset.

Guiding principle:

> Daily XP lives off-chain. Important proofs can live on-chain.

## Near-Term Candidate Work

Good next steps include:

- Test AI Notes quality on real cases and tune prompt / rules based on investigator feedback.
- Tune Investigation Leads stop-boundary and expand heuristics for more cases.
- Tune MemWal recall ranking, memory card wording, match-reason quality, and Ask MemWal answer quality with more real cases.
- Add optional MemWal queued-to-saved sync for better memory lifecycle visibility.
- Add My Snapshots management for growing snapshot lists, such as search, filters, hide/delete local index records, or a profile page.
- Add optional case version diff so restored cases can compare v1 and v2 investigation states.
- Improve report viewing through the app instead of raw browser HTML when useful.
- Add deployment-ready `Copy Case Link` support with `APP_PUBLIC_URL` and a query restore prompt.
- Improve Ask MemWal source attribution, scope-check tuning, and chat UI polish.
- Consider a future provider adapter option for Bedrock or other models after OpenAI notes are stable.

## Safety Notes

Do not commit secrets or local credentials into docs:

- Supabase service role key
- `.env` values
- wallet signatures
- session tokens
- private case notes or identities

Use placeholders in public docs and keep real secrets only in local `.env` or deployment environment variables.
