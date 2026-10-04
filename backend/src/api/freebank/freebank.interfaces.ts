import { CreditFamily, DecodedPayload } from './freebank-tx-parser';
import { HouseBadge } from './house-badge';

// Shapes of the FreeBank credit RPCs (freebank/src/rpc/misc.cpp) as this backend passes them
// through, and of the /api/v1/freebank/* responses. The RPC objects are forwarded as the node
// returns them; only the fields this backend reads are typed, the rest ride along.
//
// Amount conventions of the node's JSON:
//   ECX amounts from ValueFromAmount are decimal ECX (e.g. "amount": 1.00000000) - bill
//     amount/escrow, house activeescrow/lastattestreserves, partner pledge, insolventpot;
//   unit counts are integers (mintedunits, depositunits, note_reserve, ...), and some sat
//     amounts are integers too (listloanbook face_total, pool btx_reserve, getpool/listpools);
//   every *_grams field is the same amount in grams of gold at the node's presentation scale.

export interface FreebankHouse {
  id: number;
  classid: string;
  status: string;
  effective_status: string;
  mintedunits: number;
  mintedunits_grams: number;
  attestedratiobps: number;
  lastattestheight: number;
  attest_deadline: number;
  pareligible: boolean;
  defer_activations?: number; // suspensions, all time (v0.2.18: no limit, so the count is shown)
  type?: string; // v0.2.19: 'open' | 'members' | 'redeem', fixed at registration
  member_records?: number; // v0.2.19: member records of a members-only house
  insolventheight?: number;
  [field: string]: any;
}

export interface FreebankBill {
  id: number;
  status: string; // 'a' active, 'r' retired, 'd' defaulted, 'x' disputed (bill.h BILL_STATUS_*)
  owner_house_id: number; // 0 unless a house holds it in its loan book
  [field: string]: any;
}

export interface FreebankLoanBook {
  house_id: number; // 0 when unfiltered
  count: number;
  face_total: number; // sats
  face_total_grams: number;
  recorded_face?: number; // filtered only
  face_matches?: boolean; // filtered only
  wtd_avg_maturity?: number; // filtered only
  bills: FreebankBill[];
}

export interface FreebankPool {
  pool_id: number;
  house_id: number;
  [field: string]: any;
}

export interface FreebankGoldFix {
  raw: number; // mg of gold per 1000 ECX
  braked: number;
  fixheight: number;
  ageblocks?: number;
}

export interface FreebankOracleSubmitter {
  id: number;
  [field: string]: any;
}

export interface FreebankActivityItem {
  txid: string;
  height: number;
  time: number; // block time, unix seconds
  version: number;
  family: CreditFamily;
  op: number | null; // null if the tx could not be parsed
  op_name: string | null;
  fee: number | null; // sats; null if the inputs could not be looked up
  decoded: DecodedPayload;
}

export type HouseBadgeCounts = Record<HouseBadge, number>;

export interface FreebankSummary {
  tip_height: number;
  houses: number;
  houses_by_badge: HouseBadgeCounts;
  minted_units_total: number;
  minted_grams_total?: number; // only from a node that still sends *_grams (before v0.2.17)
  bills_active: number;
  loanbook_face_total: number; // sats
  loanbook_face_total_grams?: number; // likewise
  pools: number;
  gold_fix: FreebankGoldFix | null;
}

// The BMM view (/api/v1/freebank/bmm*, bmm.ts): for each FreeBank block, the eCash block that
// carried it, that block's pool, and the bid (the M8's fee). Hashes are in display order.

export type BmmStatus = 'ok' | 'no-mainchain-block' | 'no-commitment' | 'no-bid' | 'error' | 'pending';

export interface BmmPool {
  name: string;
  slug: string;
}

export interface BmmBlock {
  freebank_height: number;
  freebank_hash: string;
  merkleroot: string; // h*, the value committed on eCash
  time: number; // FreeBank block time, unix seconds
  ecash_hash: string; // the node's hashmainblock
  ecash_height: number | null;
  ecash_time: number | null;
  pool: BmmPool | null;
  bid_sats: number | null; // the M8's fee
  bid_txid: string | null;
  bid_vsize: number | null; // weight / 4, as mempool counts it (may have a fraction)
  bid_rate: number | null; // sat/vB, 2 decimals
  other_sidechains: number[]; // the other M7 slots in that coinbase
  // ok, or why not: no-mainchain-block (the eCash explorer does not have the block),
  // no-commitment (no M7 for our slot and h*), no-bid (no matching M8), error (retried),
  // pending (not looked up yet)
  status: BmmStatus;
}

export interface BmmList {
  enabled: boolean;
  explorer_url: string;
  tip_height: number;
  items: BmmBlock[]; // newest first
}

export interface BmmPoolShare extends BmmPool {
  blocks: number;
  share: number; // 0-1, of the carried blocks
}

export interface BmmSummary {
  enabled: boolean;
  explorer_url: string;
  indexed: number; // blocks of the window with a final status
  pending: number; // blocks of the window still to look up (or being retried)
  carried: number; // blocks whose commitment was found (status ok or no-bid)
  total_bid_sats: number;
  avg_bid_sats: number | null; // over the blocks with a bid (status ok)
  median_bid_sats: number | null;
  last: BmmBlock | null; // the newest ok block
  pools: BmmPoolShare[]; // most blocks first
  latest_ecash_height: number | null;
}
