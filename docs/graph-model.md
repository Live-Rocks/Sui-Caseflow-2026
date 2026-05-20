# Graph Model

This model is intentionally small enough for a hackathon MVP and explicit enough to evolve into a real investigation system.

## GraphSnapshot

```ts
type GraphSnapshot = {
  seedAddress: string;
  network: "mainnet" | "testnet" | "devnet";
  generatedAt: string;
  nodes: AddressNode[];
  edges: FlowEdge[];
  timeline: TimelineItem[];
};
```

## AddressNode

```ts
type AddressNode = {
  id: string;
  address: string;
  shortAddress: string;
  labels: AddressLabel[];
  firstSeenTxDigest?: string;
  lastSeenTxDigest?: string;
  stats: {
    txCount: number;
    inboundCount: number;
    outboundCount: number;
  };
};
```

## FlowEdge

```ts
type FlowEdge = {
  id: string;
  from: string;
  to: string;
  coinType: string;
  amount: string;
  rawAmount: string;
  txDigest: string;
  timestampMs?: string;
  confidence: "probable" | "possible";
  reason: string;
};
```

## TimelineItem

```ts
type TimelineItem = {
  id: string;
  txDigest: string;
  timestampMs?: string;
  kind: "transfer" | "swap_hint" | "bridge_hint" | "unknown";
  title: string;
  details: string[];
  relatedAddresses: string[];
};
```

## AddressLabel

```ts
type AddressLabel =
  | "seed"
  | "hacker"
  | "intermediate"
  | "bridge"
  | "exchange_suspect"
  | "known_entity"
  | "watch";
```

## First Parser Strategy

The first parser can infer probable edges by pairing negative and positive `balanceChanges` for the same `coinType` inside a single transaction block.

This is imperfect for many-to-many transactions, swaps, gas, and DeFi interactions. That is acceptable for the first demo as long as the UI calls these edges `probable` and exposes the source transaction digest.
