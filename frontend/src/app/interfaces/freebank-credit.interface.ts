// FreeBank credit layer: the responses of the /api/v1/freebank/* endpoints.
//
// Every endpoint passes the node's credit RPCs through unchanged (freebank src/rpc/misc.cpp:
// HouseToJSON, BillToJSON, listloanbook, PoolToJSON, getgoldfix, listoraclesubmitters), wrapped
// with tip_height, the chain tip the backend read them at. Field names are the node's.
//
// UNITS - read these before formatting a number:
//   ECX      a decimal coin amount (ValueFromAmount), e.g. 1.00000000. Fields: bill amount /
//            escrow, house activeescrow / lastattestreserves / insolventpot, partner pledge.
//   sats     an integer amount of the coin's small unit (1 ECX = 100,000,000 sats). Fields:
//            loan book face_total / recorded_face, house loanbookface, pool btx_reserve.
//   units    note units, integers. v1 notes are base-native 1:1: one note unit redeems for one
//            sat (freebank note.h). Fields: house mintedunits, depositunits, *capunits,
//            insolventunits, insolventdepositprincipal; pool note_reserve.
//   grams    grams of gold, a decimal with 6 places (every *_grams field). The node converts at
//            its launch presentation scale (getgramrate: sats per gram). PRESENTATION ONLY:
//            redemption is fixed in ECX and the scale is not enforced by consensus.
//   height   a block height. 0 usually means "never" / "none" (noted per field).
//   blocks   a count of blocks (a duration, not a height).
//   bps      basis points: 10000 = 100%, 100 = 1%, 1 = 0.01%.
//
// Large raw counters (the *wtmathi / *wtmatlo words of 128-bit accumulators) can exceed 2^53
// and lose precision as JavaScript numbers. They are exposed for byte-exact node checks; do not
// display them.

/** The credit tx families, by tx version (freebank primitives/transaction.h). */
export type FreebankTxFamily = 'bill' | 'house' | 'note' | 'deposit' | 'pool' | 'settle' | 'oracle';

/**
 * A house's status as the node names it (misc.cpp StatusName). `status` is the stored value
 * ('open', 'insolvent' once materialized by the first insolvency claim, or 'wounddown');
 * `effective_status` is the status in force at the tip, which also derives 'stressed',
 * 'deferred' and 'insolvent' from stored heights (house.cpp HouseEffectiveStatus).
 */
export type FreebankHouseStatus = 'open' | 'stressed' | 'deferred' | 'insolvent' | 'wounddown' | 'unknown';

export interface FreebankHousePartner {
  index: number;
  pubkey: string;                 // hex, 33-byte compressed key
  pledge: number;                 // ECX; cumulative (registration + top-ups), never reduced by reclaim
  status: 'active' | 'tail' | 'settled'; // tail = left a multi-partner house, pledge still locked
  tailunlockheight?: number;      // height; only when status is 'tail'
  pledgeoutputs: number;          // count of pledge escrow outputs
}

/** One discount house: gethouse <id>, or one element of listhouses. */
export interface FreebankHouse {
  id: number;                     // dense house id (1, 2, ...), used by every other RPC
  househash: string;              // hex, 32-byte house identity
  tier: number;                   // 0 bonded solo, 1 encumbered solo, 2 restricted M-of-N, 3 multi-partner
  threshold: number;              // M: partner signatures an approval needs
  classid: string;                // the note class name, [a-z0-9]{1,16}
  denominationmggold: number;     // declared denomination, milligrams of gold per unit (inert in v1)
  lambdax10: number;              // issuance multiplier x10: notes + deposits <= lambdax10/10 * escrow
  activeescrow: number;           // ECX: partner capital currently locked
  activeescrow_grams: number;     // grams
  mintedunits: number;            // units: notes outstanding
  mintedunits_grams: number;      // grams
  depositunits: number;           // units: term-deposit principal outstanding
  depositwam: number;             // blocks: weighted-average remaining term of the deposit book
  matchfundingok: boolean;        // term money covers the deposit-funded slice of the loan book
  depositwtmathi: number;         // raw 128-bit accumulator word; do not display
  depositwtmatlo: number;         // raw 128-bit accumulator word; do not display
  loanbookface: number;           // sats: face value of the discounted bills the house holds
  loanwtmathi: number;            // raw 128-bit accumulator word; do not display
  loanwtmatlo: number;            // raw 128-bit accumulator word; do not display
  redemptiondestpk: string;       // hex: the house's custody key (redemptions, discounted bill titles)
  insolventdepositprincipal: number; // units
  mintcapunits: number;           // units: binding mint cap = min(capital cap, reserve cap)
  mintcapunits_grams: number;     // grams
  capitalcapunits: number;        // units: lambda * active escrow
  reservecapunits: number;        // units: attested reserves / 10% reserve floor
  attestedratiobps: number;       // bps: reserves / notes at the last attestation, capped at 10000
  brassagebps: number;            // bps: redemption spread; 0 at or above the 10% reserve floor
  status: FreebankHouseStatus;    // stored status
  effective_status: FreebankHouseStatus; // status in force at the tip (what the badge reads)
  stress_since?: number;          // height the current stress began; only while stressed
  protest_open?: number;          // count of open note protests; present once a protest ever happened
  protest_height?: number;        // height
  protest_demand_height?: number; // height
  attest_deadline: number;        // height: lastattestheight + 2 * attestation cadence. If the house has
                                  // not attested by this height it is stressed from attest_deadline + 1.
  lastattestheight: number;       // height of the last attestation (the registration height if none yet)
  lastattestreserves: number;     // ECX: reserves proven at the last attestation
  lastattestreserves_grams: number; // grams
  lastsettleheight: number;       // height of the last settlement; 0 = never
  pareligible: boolean;           // may settle at par now: open, ratio >= floor, attested within one cadence
  insolventheight?: number;       // height insolvency was materialized; only once insolvent
  insolventunits?: number;        // units outstanding at insolvency
  insolventpot?: number;          // ECX: the pot note holders claim from pro rata
  escrowchangeoutputs: number;    // count
  reservelockoutputs: number;     // count
  // option clause (v0.2.18: a suspension has no end date and may repeat; defer_end_height and confidence_dead are gone)
  defer_invoked_height?: number;  // height the option clause was invoked; only while suspended
  defer_silence_insolvent_height?: number; // only while suspended: insolvent at this height unless it attests first
  defer_interest_bps?: number;    // bps a year earned by demanded notes queued during a suspension (1000 = 10%)
  defer_renewals: number;         // always 0 from v0.2.18 (renewal retired)
  defer_activations: number;      // suspensions, all time
  defer_ended_height: number;     // height the last suspension ended (the reopen); 0 = none
  defer_suspended_blocks: number; // blocks spent suspended, all time (the current suspension included)
  registeredheight: number;       // height
  txidregister: string;           // txid of the registration (v12) tx
  partners: FreebankHousePartner[];
  type?: string;                  // v0.2.19: 'open' | 'members' (notes only between members) | 'redeem' (only between
                                  // the house and the holder); fixed at registration
  member_records?: number;        // v0.2.19: member records (active and scheduled for removal), members-only houses
  tokenunits?: number;            // v0.2.20: units backing the house's Chaumian tokens outstanding (part of mintedunits)
  tokenclaimed?: number;          // v0.2.21: units claimed by token holders at a failed house
  tokenclaims?: number;           // v0.2.21: claims made
  tokencollected?: number;        // v0.2.21: claims paid
}

/** GET /api/v1/freebank/house/:id/tokens (gettokenclaims), v0.2.21: the house's mint keysets and token claims. */
export interface FreebankTokenKeyset {
  id: string;                     // 16 hex
  height: number;                 // recorded at
  postingpubkey: string;
  keys: { amount: number, pubkey: string }[];
}

export interface FreebankTokenClaim {
  y: string;                      // the token's Y (hex)
  amount: number;                 // units
  payout: string;                 // the holder's payout script (hex)
  feebps: number;                 // the relayer's share
  relayer: string;
  height: number;                 // claimed at
  collectheight: number;          // paid at; 0 = not yet
}

export interface FreebankHouseTokensResponse {
  tip_height: number;
  house_id: number;
  insolventsince: number;         // E: 0 while the house has not failed
  windowend: number;              // E + the claim window; 0 while not failed
  tokenunits: number;
  base: number;                   // B, set by the first collect
  claimed: number;                // T, units claimed
  claims: number;
  collected: number;
  paid: number;                   // ECX paid out (szats)
  writeoff: number;
  keysets: FreebankTokenKeyset[];
  list: FreebankTokenClaim[];
  next: string | null;            // the Y the next page of claims starts at
}

/** GET /api/v1/freebank/house/:id/members (listhousemembers), v0.2.19. */
export interface FreebankHouseMember {
  address: string;
  added_height: number;
  removal_height: number;         // 0 = no removal scheduled
  active: boolean;                // a member in the next block
}

export interface FreebankHouseMembersResponse {
  tip_height: number;
  house_id: number;
  members: FreebankHouseMember[];
  next: string | null;            // the address to start the next page from, null on the last page
}

/** Bill status letters (freebank bill.h BILL_STATUS_*). Issued and endorsed bills are both 'a'. */
export type FreebankBillStatus = 'a' | 'r' | 'd' | 'x';

export interface FreebankBillEndorsement {
  from: string;                   // hex pubkey
  to: string;                     // hex pubkey
  at_height: number;              // height
}

/** One bill of exchange: getbill <id>, or one element of listbills (which omits encrypted_body). */
export interface FreebankBill {
  id: number;                     // dense bill id (1, 2, ...), used by getbill
  bill_id: string;                // hex: sha256 of the encrypted body (the bill's identity)
  amount: number;                 // ECX: face value
  amount_grams: number;           // grams
  escrow: number;                 // ECX: the acceptor's escrow bond
  escrow_grams: number;           // grams
  status: FreebankBillStatus;     // a = active, r = retired (paid), d = defaulted, x = disputed (unused in v1)
  issued_height: number;          // height
  maturity_height: number;        // height the bill falls due
  grace_blocks: number;           // blocks after maturity before the holder can claim the escrow
  drawer_pubkey: string;          // hex
  acceptor_pubkey: string;        // hex: the drawee who accepted and pays at maturity
  holder_pubkey: string;          // hex: current holder (last endorsee)
  owner_house_id: number;         // house holding it in its loan book (discounted); 0 = not house-held
  issue_txid: string;             // txid of the issue (v11) tx
  escrow_outpoint: string;        // "txid:vout"
  title_outpoint: string;         // "txid:vout" of the title coin
  endorsements: FreebankBillEndorsement[];
  encrypted_body?: string;        // hex; getbill only (GET /bill/:id)
}

/** listloanbook <house_id>: the discounted bills one house holds. */
export interface FreebankLoanBook {
  house_id: number;               // 0 when unfiltered (the backend always filters by house)
  count: number;                  // bills held
  face_total: number;             // sats: summed face of the bill records
  face_total_grams: number;       // grams
  recorded_face?: number;         // sats: the house's own counter (loanbookface); filtered calls only
  face_matches?: boolean;         // face_total == recorded_face, the loan-book invariant; filtered calls only
  wtd_avg_maturity?: number;      // height: face-weighted average maturity (0 if empty); filtered calls only
  bills: FreebankBill[];
}

/** One AMM pool of a house's notes against ECX: getpool <id>, or one element of listpools. */
export interface FreebankPool {
  pool_id: number;                // equals house_id in v1 (one pool per house)
  house_id: number;
  fee_bps: number;                // bps: swap fee
  note_reserve: number;           // units: notes in the pool
  note_reserve_grams: number;     // grams
  btx_reserve: number;            // sats: ECX in the pool ('btx' is the chassis' old name for the coin)
  btx_reserve_grams: number;      // grams
  lp_supply: number;              // liquidity shares issued (not note units)
  locked_lp: number;              // liquidity shares locked forever at creation
  spot_price_sats_x1e8?: number;  // sats per note unit x 1e8 (0.95 sats/unit = 95000000); absent when note_reserve is 0.
                                  // Informational: a real swap also pays the fee and moves the price.
  note_escrow_txid: string;
  note_escrow_vout: number;
  btx_escrow_txid: string;
  btx_escrow_vout: number;
  createheight: number;           // height
}

/**
 * getgoldfix: the on-chain gold price, or null before the first fix has formed.
 * The price is MILLIGRAMS OF GOLD PER 1000 ECX, so grams per ECX = value / 1e6
 * (see goldFixGramsPerEcx in freebank/credit-units.ts). Consensus-inert in this phase:
 * nothing in the credit rules reads it, and it is not the presentation scale behind *_grams.
 */
export interface FreebankGoldFix {
  raw: number;                    // mg gold per 1000 ECX: median of the last quorum block's submissions
  braked: number;                 // mg gold per 1000 ECX: damped view, follows rises at once, falls slowly
  fixheight: number;              // height the fix formed
  ageblocks?: number;             // blocks: tip - fixheight
}

/** One bonded gold-price submitter (listoraclesubmitters). */
export interface FreebankOracleSubmitter {
  id: number;
  pubkey: string;                 // hex
  bondtxid: string;               // the bond escrow coin
  bondvout: number;
  bondheight: number;             // height
  lastsubmitheight: number;       // height; 0 = has never submitted
  blockssincesubmit?: number;     // blocks; absent if never submitted. A gap does not prove the
                                  // submitter was absent: the block producer may have left it out.
  unbondrequestheight: number;    // height; 0 = no unbond pending
}

// ---- endpoint responses (GET /api/v1/freebank/...) ----

/** GET /houses */
export interface FreebankHousesResponse {
  tip_height: number;
  houses: FreebankHouse[];
}

/** GET /house/:id (404 if unknown) */
export interface FreebankHouseResponse {
  tip_height: number;
  house: FreebankHouse;
  loanbook: FreebankLoanBook;
  bills: FreebankBill[];          // listbills entries whose owner_house_id is this house
  pools: FreebankPool[];          // listpools entries whose house_id is this house (0 or 1 in v1)
}

/** GET /bills */
export interface FreebankBillsResponse {
  tip_height: number;
  bills: FreebankBill[];
}

/** GET /bill/:id (404 if unknown) */
export interface FreebankBillResponse {
  tip_height: number;
  bill: FreebankBill;             // includes encrypted_body
}

/** GET /pools */
export interface FreebankPoolsResponse {
  tip_height: number;
  pools: FreebankPool[];
}

/** GET /pool/:id */
export interface FreebankPoolResponse {
  tip_height: number;
  pool: FreebankPool;
  house: FreebankHouse;           // the house whose notes the pool trades
}

/** GET /gold */
export interface FreebankGoldResponse {
  tip_height: number;
  fix: FreebankGoldFix | null;
  submitters: FreebankOracleSubmitter[];
}

export type FreebankDecodedValue = number | string | boolean | null;

/**
 * GET /activity `decoded`: the payload fields the backend could read from the tx's credit
 * payload (backend/src/api/freebank/freebank-tx-parser.ts on mb/freebank-m4-backend, which names
 * them). Best effort: {} when the op carries nothing useful or the payload did not parse, so treat
 * every field as possibly missing. Grouped by family and op; units as in the file header.
 */
export interface FreebankDecodedPayload {
  // bill: issue (face_sats, maturity_height, grace_blocks), endorse (bill_id, from_pubkey,
  // to_pubkey), retire / claim / recourse (bill_id), discount (bill_id, house_id, price_units,
  // face_sats, maturity_height), hretire / hclaim (bill_id, house_id, face_sats, maturity_height)
  bill_id?: number;               // dense bill id (GET /bill/:id), not the bill hash
  face_sats?: number;             // sats
  maturity_height?: number;       // height
  grace_blocks?: number;          // blocks
  from_pubkey?: string;           // hex
  to_pubkey?: string;             // hex
  price_units?: number;           // units: the discount price, paid in the house's own notes
  // house: register (tier, threshold, classid, denominationmggold, partners, pledge_sats),
  // topup / exit / reclaim (house_id, partner_index), attest (house_id, as_of_height,
  // reserves_sats), admit / winddown / defer / renew / release (house_id)
  house_id?: number;              // also on note, deposit, pool and bill discount ops
  tier?: number;
  threshold?: number;
  classid?: string;
  denominationmggold?: number;
  partners?: number;              // count
  pledge_sats?: number;           // sats, all founding pledges
  partner_index?: number;
  as_of_height?: number;          // height the attested reserves are proven at
  reserves_sats?: number;         // sats: the attested reserves
  // house (v0.2.19): register_mo (the register fields and house_type), member_add / member_remove / member_purge
  // (house_id, members, member_addresses: the first 20, comma-separated)
  house_type?: string;            // 'open' | 'members' | 'redeem'
  members?: number;               // count of member keys the op names
  member_addresses?: string;      // comma-separated, at most 20
  // note: mint / transfer / demand / protest (house_id, units, outputs), redeem / claim (house_id);
  // demand also (demand_mode, prior_demand_height), v0.2.18
  units?: number;                 // units, summed over the note outputs
  outputs?: number;               // count of note outputs
  change_units?: number;          // v0.2.20 lock (token mint record): change notes back to the holder
  // v0.2.21 token claim ops: token_keyset (keys, largest_amount), token_post (keyset_id, issued, issued_units, spent),
  // token_claim (tokens, claimed_units), token_collect (claims, escrow_change)
  keys?: number;
  largest_amount?: number;
  keyset_id?: string;
  issued?: number;
  issued_units?: number;
  spent?: number;
  tokens?: number;
  claimed_units?: number;
  claims?: number;
  escrow_change?: boolean;
  demand_mode?: string;           // 'plain' | 'preauth' | 'preauth_queue' (or 'mode_<n>' for an unknown byte)
  prior_demand_height?: number;   // height: non-zero on an upgrade of a plain demand (its clock kept)
  // deposit: originate (house_id, principal_units, receipts), transfer (house_id,
  // principal_units, rate_bps, maturity_height), withdraw / claim (house_id)
  principal_units?: number;       // units
  receipts?: number;              // count
  rate_bps?: number;              // bps a year
  // pool (every op has pool_id and house_id, equal in v1): create (fee_bps, note_units,
  // ecx_sats), add_liq (note_units, ecx_sats, lp_minted), remove_liq (lp_burned, note_units_out,
  // ecx_sats_out), swap (direction, amount_in, amount_out)
  pool_id?: number;
  fee_bps?: number;               // bps
  note_units?: number;            // units
  ecx_sats?: number;              // sats
  lp_minted?: number;             // liquidity shares
  lp_burned?: number;             // liquidity shares
  note_units_out?: number;        // units
  ecx_sats_out?: number;          // sats
  direction?: string;             // 'notes_for_ecx' (amount_in units, amount_out sats) or
                                  // 'ecx_for_notes' (amount_in sats, amount_out units)
  amount_in?: number;
  amount_out?: number;
  // settle exchange: two houses swap each other's notes at par; the house whose notes came home
  // more pays the difference in ECX (residual_sats) to the other
  house_a_id?: number;            // lower house id
  house_b_id?: number;            // higher house id
  mode?: number;                  // 0 = even swap, 1 = with a residual payment
  house_a_notes_units?: number;   // units of house A's notes presented
  house_b_notes_units?: number;   // units of house B's notes presented
  residual_sats?: number;         // sats
  debtor_house_id?: number | null;   // pays the residual; null for an even swap
  creditor_house_id?: number | null; // receives it; null for an even swap
  expiry_height?: number;         // height; 0 = none
  // oracle: bond (submitter_id (0 = new), target_height, pubkey), submit (submitter_id,
  // target_height, price_mg)
  submitter_id?: number;
  target_height?: number;         // height
  pubkey?: string;                // hex
  price_mg?: number;              // mg gold per 1000 ECX (the gold fix unit)
  [field: string]: FreebankDecodedValue | undefined;
}

/** One credit tx in GET /activity. */
export interface FreebankActivityItem {
  txid: string;
  height: number;                 // block height
  time: number;                   // block time, unix seconds
  version: number;                // tx version, 11..17
  family: FreebankTxFamily;
  op: number | null;              // the op byte after nLockTime; null if the tx did not parse
  op_name: string | null;         // lower-case constant name, e.g. HOUSE_OP_ATTEST -> 'attest'; 'op_<n>' if unknown
  fee: number | null;             // sats; null if the backend could not look up the inputs
  decoded: FreebankDecodedPayload; // {} when not decoded
}

/** GET /activity?family=&limit= (newest first) */
export interface FreebankActivityResponse {
  tip_height: number;
  scanned_from_height: number;    // lowest height the backend scanned; older activity is not listed
  items: FreebankActivityItem[];
}

/** House counts per health badge (see freebank/house-health.ts for the rules). */
export interface FreebankHouseBadgeCounts {
  sound: number;
  stressed: number;
  attestation_due: number;
  insolvent: number;
  wound_down?: number;            // closed houses; sent by the backend, not in the written contract
}

/** GET /summary */
export interface FreebankSummaryResponse {
  tip_height: number;
  houses: number;                 // count
  houses_by_badge: FreebankHouseBadgeCounts;
  minted_units_total: number;     // units: notes outstanding, all houses
  minted_grams_total?: number;    // grams; only from a node that still sends *_grams (before v0.2.17)
  bills_active: number;           // count of bills with status 'a'
  loanbook_face_total: number;    // sats: summed loanbookface of all houses
  loanbook_face_total_grams?: number; // grams (sent by the backend, not in the written contract)
  pools: number;                  // count
  gold_fix: FreebankGoldFix | null;
}

// ---- assets (v0.2.18, tx v10): GET /api/v1/freebank/assets, asset/:id (backend api/freebank/asset-index.ts) ----
// Units are an asset's base units (a coin's value in szats); decimals say where the display point goes. An asset is its
// asset_id (the genesis txid): tickers are not unique.

export interface FreebankAsset {
  asset_id: string;
  ticker: string;
  headline: string;
  payload: string;                // '' when none
  decimals: number;               // 0-8, display only
  supply: number;                 // units created
  burned: number;                 // units burned since
  circulating: number;            // supply - burned
  holders: number;                // addresses holding units now
  control_address: string | null; // where the control coin is now
  height: number;                 // the genesis block
  block_hash: string;
  time: number;
  tx_count: number;               // txs that created or moved it
  last_height: number;
}

export interface FreebankAssetHolder {
  address: string | null;         // null: a script without an address
  units: number;
  coins: number;
}

export interface FreebankAssetTx {
  txid: string;
  height: number;
  time: number;
  kind: 'genesis' | 'transfer' | 'invalid';
  units_moved: number;
  burned: number;
  control_moved: boolean;
}

export interface FreebankAssetDetail extends FreebankAsset {
  holders_list: FreebankAssetHolder[]; // largest first, at most 100
  holders_truncated: boolean;
  control: { txid: string, vout: number, address: string | null } | null;
  txs: FreebankAssetTx[];             // newest first, at most 50
}

export interface FreebankAssetsResponse {
  tip_height: number;             // the index's top
  behind_by: number;              // blocks the index has still to read
  assets: FreebankAsset[];
}

export interface FreebankAssetResponse {
  tip_height: number;
  behind_by: number;
  asset: FreebankAssetDetail;
}
