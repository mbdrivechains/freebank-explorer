// FreeBank BMM view: the responses of /api/v1/freebank/bmm*.
//
// Every FreeBank block is blind-merged-mined: an eCash miner commits it in an eCash block (M7 in
// the coinbase, for FreeBank's slot) and is paid by a bid (the fee of an M8 tx in that block). The
// backend finds both through the eCash explorer's API (explorer.beta.ecash.ninja) and caches the
// answer per FreeBank block hash; the browser only ever reads our own API and links to that
// explorer. Amounts are integer sats of the eCash chain. Hashes are in display order.

/**
 * How far the backend got with one FreeBank block:
 *   ok                  the eCash block, its pool and the winning bid are known
 *   no-mainchain-block  the eCash explorer does not have the eCash block the FreeBank block names
 *   no-commitment       the eCash block's coinbase has no commitment for FreeBank's slot
 *   no-bid              a commitment, but no matching bid tx in that eCash block
 *   error               the eCash explorer did not answer; retried
 *   pending             not looked up yet (only the freebank_* fields, merkleroot and time are set)
 */
export type FreebankBmmStatus = 'ok' | 'no-mainchain-block' | 'no-commitment' | 'no-bid' | 'error' | 'pending';

/** An eCash mining pool, from the eCash explorer's pool list. */
export interface FreebankBmmPool {
  name: string;
  slug: string;                   // the eCash explorer's /mining/pool/{slug}
}

/** One FreeBank block and the eCash block that carried it. */
export interface FreebankBmmBlock {
  freebank_height: number;
  freebank_hash: string;
  merkleroot: string;             // h*, the value committed on eCash
  time: number;                   // FreeBank block time, unix seconds
  ecash_hash: string;             // the node's hashmainblock
  ecash_height: number | null;
  ecash_time: number | null;      // unix seconds
  pool: FreebankBmmPool | null;
  bid_sats: number | null;        // the winning bid: the fee of the M8 tx
  bid_txid: string | null;
  bid_vsize: number | null;       // vbytes (weight / 4, may have a fraction)
  bid_rate: number | null;        // sat/vB, 2 decimals
  other_sidechains: number[];     // the other slots committed in the same eCash coinbase
  status: FreebankBmmStatus;
}

/** GET /bmm?limit=&before= : newest first over the active chain. */
export interface FreebankBmmListResponse {
  enabled: boolean;
  explorer_url: string;           // the eCash explorer, for links
  tip_height: number;
  items: FreebankBmmBlock[];
}

export interface FreebankBmmPoolShare extends FreebankBmmPool {
  blocks: number;                 // FreeBank blocks carried by this pool
  share: number;                  // 0-1 of the carried blocks
}

/** Whether the BMM view is on, and the eCash explorer for links: fixed while the backend runs (ApiService.getFreebankBmmConfig$). */
export interface FreebankBmmConfig {
  enabled: boolean;
  explorer_url: string;
}

/** GET /bmm/summary : over the cached entries on the active chain. */
export interface FreebankBmmSummaryResponse {
  enabled: boolean;
  explorer_url: string;
  indexed: number;                // blocks with a final status (anything but pending and error)
  pending: number;                // blocks still to look up, or being retried
  carried: number;                // blocks whose commitment was found (ok or no-bid)
  total_bid_sats: number;
  avg_bid_sats: number | null;    // over the ok blocks; null before the first
  median_bid_sats: number | null;
  last: FreebankBmmBlock | null;  // the newest ok block
  pools: FreebankBmmPoolShare[];  // sorted by blocks, most first
  latest_ecash_height: number | null;
}
