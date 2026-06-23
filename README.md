# Sui CaseFlow

Investigator layer for Sui fund flows: arbitrary wallet tracing, visual transaction graphs, case labels, and timeline reconstruction.

## MVP Goal

Input any Sui address, fetch recent transaction blocks, parse balance changes, and convert them into an investigation graph that can later be rendered in a frontend.

## Current Files

- `docs/mvp-spec.md` - product scope, demo flow, and feature boundaries.
- `docs/graph-model.md` - graph data structures for addresses, flows, labels, and timeline items.
- `docs/project-memory.md` - product context, current capabilities, architecture notes, and future direction.
- `scripts/query-sui-address.mjs` - dependency-free Sui RPC proof-of-concept.

## Quick Start

Install dependencies once, then start the API server and Vite frontend:

```bash
npm install
node server.mjs
npm run dev
```

Then open:

```text
http://127.0.0.1:5174
```

Development ports:

- API server: `http://127.0.0.1:5173`
- Vite frontend: `http://127.0.0.1:5174`

## Production build test

To test the production deployment path locally, build the Vite frontend and run the Node server in production mode:

```bash
npm run build
NODE_ENV=production PORT=5199 npm start
```

Then open:

```text
http://127.0.0.1:5199
```

In production mode, `server.mjs` serves only the Vite `dist` directory and fails fast if `dist/index.html` is missing. The sample trace fixture is available from `public/data/sample-trace.json`, which Vite copies to `dist/data/sample-trace.json` during build.

## Zeabur deployment

The app is deployment-ready as a long-lived Node service. Recommended Zeabur settings:

```text
Build command: npm install && npm run build
Start command: npm start
```

Set this environment variable for the service:

```bash
NODE_ENV=production
```

Add server-side secrets in Zeabur environment variables, not in GitHub or `.env` files. `VITE_*` variables are public build-time values and must be present before `npm run build`; server-only secrets such as `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and `MEMWAL_DELEGATE_PRIVATE_KEY` must not use the `VITE_` prefix.

### Snapshot NFT dev mode

Wallet-based testnet minting is available through the Vite frontend while the API server runs on port 5173.


Deploy `move/caseflow_snapshot` to Sui testnet, copy `.env.example` to `.env`, and set:

```bash
VITE_CASEFLOW_SNAPSHOT_PACKAGE_ID=0xYOUR_TESTNET_PACKAGE_ID
```

Run the proof-of-concept with a Sui address:

```bash
node scripts/query-sui-address.mjs 0xYOUR_SUI_ADDRESS
```

The script queries both outbound and inbound transaction blocks, merges them by digest, and emits a graph-shaped JSON summary.

Optional arguments:

```bash
node scripts/query-sui-address.mjs 0xYOUR_SUI_ADDRESS --limit 20 --network mainnet
```

Save the JSON result for frontend fixtures:

```bash
node scripts/query-sui-address.mjs 0xYOUR_SUI_ADDRESS --limit 20 --network mainnet --out data/sample-trace.json
```

Supported networks:

- `mainnet`
- `testnet`
- `devnet`

## Wallet sign-in and My Snapshots

Case Snapshot uploads can be saved to a wallet-owned snapshot list. Create the Supabase table with `docs/supabase-schema.sql`, then set these server-side environment variables before running `npm run server`:

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
SESSION_SECRET="a-long-random-secret"
```

`Upload to Walrus` requires signing in with a Sui wallet. `Download Report` and `Download JSON` continue to work without signing in.
