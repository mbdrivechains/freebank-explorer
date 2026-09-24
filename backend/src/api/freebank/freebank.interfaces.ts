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
  confidence_dead: boolean;
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
  minted_grams_total: number;
  bills_active: number;
  loanbook_face_total: number; // sats
  loanbook_face_total_grams: number;
  pools: number;
  gold_fix: FreebankGoldFix | null;
}
