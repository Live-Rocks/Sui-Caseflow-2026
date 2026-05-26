# Sui CaseFlow Project Memory

This file preserves the product and implementation context that has accumulated during development. It is meant to help future Codex chats, teammates, and hackathon work sessions reconnect quickly.

## Product Positioning

Sui CaseFlow is an investigator layer for Sui fund flows. It is not trying to replace block explorers. Explorers expose raw facts; Sui CaseFlow turns those facts into a case workspace with graph tracing, labels, reports, and recoverable snapshots.

The current product direction is a free public observation tool first. Commercialization, pricing, AI summaries, and heavy entity intelligence are deliberately deferred until the core investigation experience is stable.

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
- Multi-page Sui RPC fetching so Last 100 can reach beyond the first RPC page.
- Visual fund-flow graph with draggable nodes, pan, zoom, fit, and undo.
- Expand node workflow with dedupe and lineage-aware layout.
- Dust / noise filter for tiny or same-transaction clutter.
- Direction coloring: inbound blue, outbound red, bidirectional summary gold.
- Case labels such as `hacker`, `intermediate`, `bridge`, `exchange_suspect`, `known_entity`, and `watch`.
- Flow Details panel with transaction-level evidence and Suivision links.
- Case Snapshot modal with HTML report and JSON export.
- Case memory artifact inside snapshot JSON for future Walrus / agent memory workflows.
- Walrus upload of case package artifacts: report, snapshot, and case memory.
- Sui wallet sign-in where wallet address is the user identity.
- Supabase-backed My Snapshots list for wallet-owned snapshot records.
- Restore workspace from a saved Walrus snapshot.
- Off-chain Analyst XP / Investigator Reputation with levels in the wallet dropdown.
- Optional testnet minting flow for snapshot NFT / certificate experiments.

## Architecture Notes

Current stack:

- Frontend: vanilla JavaScript, HTML, CSS, served by Vite in dev.
- API server: Node `server.mjs`.
- Data source: Sui RPC through the local API server.
- Explorer links: Suivision.
- Persistent snapshot storage: Walrus public publisher / aggregator.
- Snapshot index: Supabase `snapshot_records` table.
- Identity: Sui wallet signature session, stored locally as a short-lived token.

Development ports:

- API server: `http://127.0.0.1:5173`
- Vite frontend: `http://127.0.0.1:5174`

Recommended local startup:

```bash
node server.mjs
npm run dev
```

The old single-server command `PORT=5174 node server.mjs` is no longer the preferred dev path because wallet imports and Vite module resolution need the Vite frontend.

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

## Walrus / Case Memory Direction

Walrus is positioned as the durable case memory layer.

A Case Snapshot should contain:

- Human-readable HTML report.
- Machine-readable snapshot JSON.
- Machine-readable case-memory JSON.
- Snapshot hash and case memory hash.
- Links to Walrus artifacts after upload.

Current restore behavior is visible-snapshot restore: it restores the graph state saved in the snapshot, not the full historical RPC universe. After restore, investigators can continue from restored nodes by expanding addresses again.

Future Walrus direction:

- Improve report viewing through the app instead of raw browser HTML when useful.
- Add Load from Walrus / restore by blob or quilt id.
- Potentially support private or encrypted case packages later with Seal.
- Keep public upload warnings clear because Walrus data is persistent and public in the current flow.

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

- Wallet selector modal instead of auto-opening the first detected wallet.
- Better My Snapshots dropdown / future profile page with snapshots and reputation.
- Snapshot restore polish and clearer restored-state messaging.
- Better layout handling for large fan-out graphs and low-value noise.
- Report viewer improvements for Walrus-hosted HTML.
- Start Phase 4 reputation only after snapshot restore and wallet UX feel solid.

## Safety Notes

Do not commit secrets or local credentials into docs:

- Supabase service role key
- `.env` values
- wallet signatures
- session tokens
- private case notes or identities

Use placeholders in public docs and keep real secrets only in local `.env` or deployment environment variables.
