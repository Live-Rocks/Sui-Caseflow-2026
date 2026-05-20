# Sui CaseFlow MVP Spec

## One-liner

Trace suspicious funds across Sui with arbitrary wallet input, visual fund-flow graphs, and investigator case labels.

## Problem

Sui tracing today is either explorer-based and manual, or demo-based and non-interactive. Investigators need arbitrary-address tracing, case labeling, and eventually cross-chain flow reconstruction.

## Product Positioning

Sui CaseFlow is not a block explorer replacement. Explorers expose raw facts; Sui CaseFlow reconstructs investigation workflows from those facts.

## MVP Demo Flow

1. Investigator pastes a Sui address.
2. App fetches recent transaction blocks related to that address.
3. Parser extracts balance changes, timestamps, transaction digests, and involved owners.
4. App generates a fund-flow graph.
5. Investigator expands a downstream address.
6. Investigator labels addresses as `hacker`, `intermediate`, `bridge`, `exchange_suspect`, or `known_entity`.
7. App generates a timeline and short case summary.

## Version 0 Scope

### Included

- Arbitrary Sui address input.
- Recent transaction lookup through `suix_queryTransactionBlocks`.
- Balance-change parsing.
- Initial flow graph JSON.
- Address labels and notes in local state.
- Timeline grouped by transaction timestamp.

### Deferred

- Perfect transfer attribution for complex DeFi transactions.
- Protocol-specific parsers.
- Entity intelligence database.
- Login, team sharing, and persistent backend storage.
- Fully reliable cross-chain attribution.

## Initial Heuristics

### Transfer Edge

Within the same transaction:

- owner A has a negative balance change for token X.
- owner B has a positive balance change for token X.
- create a probable flow edge from A to B.

### Swap Hint

Within the same transaction:

- one owner loses token A.
- the same owner gains token B.
- mark the transaction as possible swap activity.

### Bridge Hint

Within the same transaction:

- event package/module/function or object owner suggests known bridge interaction.
- mark the transaction as possible bridge activity.

Known bridge detection starts as a manual allowlist and should become protocol-specific later.

## Pitch Narrative

An investigator is tracking funds after an incident. The attacker sends assets through several Sui addresses, then possibly through bridge or swap activity. Existing explorers require manual transaction-by-transaction inspection. Sui CaseFlow turns the address into a graph, lets the investigator expand suspicious branches, add labels, and export a timeline.

## Success Criteria

- A judge can paste a Sui address and see real transaction data.
- The tool produces a graph-shaped JSON output from live RPC data.
- The demo explains uncertainty honestly with `probable` and `possible` labels.
- The case workflow feels useful even before entity intelligence is complete.
