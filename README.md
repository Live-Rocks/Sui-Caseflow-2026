# Sui CaseFlow

Investigator layer for Sui fund flows: arbitrary wallet tracing, visual transaction graphs, case labels, and timeline reconstruction.

## MVP Goal

Input any Sui address, fetch recent transaction blocks, parse balance changes, and convert them into an investigation graph that can later be rendered in a frontend.

## Current Files

- `docs/mvp-spec.md` - product scope, demo flow, and feature boundaries.
- `docs/graph-model.md` - graph data structures for addresses, flows, labels, and timeline items.
- `scripts/query-sui-address.mjs` - dependency-free Sui RPC proof-of-concept.

## Quick Start

Start the local app:

```bash
node server.mjs
```

If port 5173 is already in use:

```bash
PORT=5174 node server.mjs
```

Then open:

```text
http://127.0.0.1:5173
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

## Next Build Step

Add address expansion so investigators can click a downstream address and pull the next layer into the same case graph.
