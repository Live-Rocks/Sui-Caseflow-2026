module caseflow_snapshot::snapshot_nft;

use std::string::String;

public struct CaseSnapshotNFT has key, store {
    id: UID,
    name: String,
    description: String,
    image_url: String,
    snapshot_url: String,
    snapshot_hash: String,
    seed_address: String,
    created_at_ms: u64,
}

public entry fun mint(
    name: String,
    description: String,
    image_url: String,
    snapshot_url: String,
    snapshot_hash: String,
    seed_address: String,
    created_at_ms: u64,
    ctx: &mut TxContext,
) {
    let snapshot = CaseSnapshotNFT {
        id: object::new(ctx),
        name,
        description,
        image_url,
        snapshot_url,
        snapshot_hash,
        seed_address,
        created_at_ms,
    };

    transfer::public_transfer(snapshot, tx_context::sender(ctx));
}
