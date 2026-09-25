// FreeBank's two-way peg with eCash, as the explorer reads it from FreeBank's own blocks
// (peg-parser.ts, peg-index.ts) and serves it at /api/v1/freebank/peg*.
//
// Words: a "deposit from eCash" (peg-in) is an eCash M5 to FreeBank's slot, credited in a FreeBank
// coinbase; a "withdrawal to eCash" (peg-out) is a FreeBank tx that burns coins, later paid on
// eCash by a "withdrawal bundle" (the M6); a "withdrawal refund" gives an unpaid withdrawal back
// on FreeBank. Plain "deposit" means something else in FreeBank (the v14 term deposits).
//
// Amounts are integer szats (1e-8 of the coin, on both chains). Hashes and txids are in display
// (byte-reversed) order, as the nodes print them.

/** One decoded FreeBank peg output, by what it is. `vout` is its index in its transaction. */
export type PegOutput =
  | PegDepositRecord
  | PegBundleRecord
  | PegWithdrawalObject
  | PegCommitment
  | PegRefundRequest
  | PegStray
  | PegUnreadable;

/**
 * A deposit record (coinbase, OP_RETURN acdcf66f 'D'): an eCash deposit credited in this block.
 * Its destination 'D' marks the other kind, a withdrawal bundle's payment: then the eCash tx is
 * the M6 that paid the bundle, and nothing is paid on FreeBank.
 */
export interface PegDepositRecord {
  kind: 'deposit';
  vout: number;
  slot: number;
  dest: string; // the FreeBank address the depositor gave, as they typed it ('D' for a bundle payment)
  amount: number; // what this deposit added to the eCash treasury (the depositor gets it less 1,000 szats)
  ecash_txid: string; // the eCash tx: the deposit (M5), or the bundle's payment (M6)
  ecash_block: string;
  ecash_tx_index: number; // its position in that eCash block
  burn_index: number; // the output that holds the eCash treasury after this tx
  treasury_value: number | null; // that output's value: what the treasury holds for FreeBank
  bundle_payment: boolean; // dest 'D': the M6 of a withdrawal bundle
  ecash_outputs?: { value: number, scriptpubkey: string }[]; // bundle payments only: the M6's outputs
}

/** A withdrawal bundle (coinbase, OP_RETURN acdcf66f 'P'): the eCash payout tx FreeBank asks eCash to approve. */
export interface PegBundleRecord {
  kind: 'bundle';
  vout: number;
  slot: number;
  bundle_hash: string; // the bundle tx's txid: what FreeBank blocks commit to
  m6id: string; // the same tx without its input: the id eCash's enforcer knows it by
  format: 'cusf' | 'legacy' | 'unknown';
  ecash_fee: number | null; // the eCash fee the withdrawals pay, together
  payouts: PegBundlePayout[]; // in bundle order
  withdrawal_ids: string[];
  total: number; // paid out on eCash, fee not included
}

export interface PegBundlePayout {
  vout: number; // its output index, the same in the bundle and in the eCash M6
  value: number;
  scriptpubkey: string; // the eCash script
  withdrawal_id: string | null;
}

/** A withdrawal (ordinary tx, OP_RETURN acdcf66f 'W'). */
export interface PegWithdrawalObject {
  kind: 'withdrawal';
  vout: number;
  slot: number;
  id: string; // sha256d of the object with status 'u' (the node's GetID)
  dest_raw: string; // the eCash destination as stored (bech32 and P2SH in the node's carrier form)
  refund_dest: string; // FreeBank address for a refund
  amount: number; // burned on FreeBank: payout + eCash fee
  ecash_fee: number;
  payout: number; // amount - ecash_fee: what the eCash address receives
}

/** The coinbase's bundle commitments: the current bundle (ef5d1dfe), paid (fb5345de), failed (fa86c689). */
export interface PegCommitment {
  kind: 'bundle-hash' | 'bundle-paid' | 'bundle-failed';
  vout: number;
  bundle_hash: string;
}

/** A withdrawal refund request (ordinary tx, OP_RETURN fcd2e546 <id> <sig>). */
export interface PegRefundRequest {
  kind: 'refund-request';
  vout: number;
  withdrawal_id: string;
}

/**
 * A peg object in the wrong kind of transaction: a deposit record or a bundle outside the
 * coinbase, or a withdrawal or refund request inside it. The node does not treat these as peg
 * events (only block producers write deposits and bundles), so neither does the explorer.
 */
export interface PegStray {
  kind: 'stray';
  vout: number;
  object: 'deposit' | 'bundle' | 'withdrawal' | 'refund-request';
  note: string;
}

/** An output with a peg tag whose contents do not decode. */
export interface PegUnreadable {
  kind: 'unreadable';
  vout: number;
  tag: string;
  error: string;
}

// ---------------------------------------------------------------------------- the index's view

/** Why a deposit from eCash was recorded without a payout. */
export type PegInUnpaidReason = 'at-or-below-fee' | 'not-a-freebank-address';

export interface PegDeposit {
  freebank_height: number;
  freebank_block: string;
  freebank_time: number; // block time, unix seconds
  coinbase_txid: string;
  record_vout: number;
  payout_vout: number | null; // null: not paid (see unpaid_reason)
  dest: string;
  amount: number; // added to the eCash treasury
  paid: number; // to the depositor: amount less 1,000 szats, or 0
  fee: number; // the 1,000 szats the block producer keeps, or 0
  unpaid_reason: PegInUnpaidReason | null;
  ecash_txid: string;
  ecash_block: string;
  ecash_vout: number; // the treasury output of the eCash tx
  treasury_value: number | null;
}

export type PegWithdrawalStatus =
  | 'waiting' // no bundle yet
  | 'requeued' // its bundle failed on eCash; back in the queue
  | 'in-bundle' // in a bundle; waiting for approval on eCash
  | 'paid' // the bundle's eCash payment is known
  | 'marked-paid' // a block producer marked the bundle paid, but no matching eCash payment is recorded
  | 'refunded';

export interface PegWithdrawal {
  id: string;
  txid: string;
  vout: number;
  freebank_height: number;
  freebank_block: string;
  freebank_time: number;
  dest_raw: string;
  refund_dest: string;
  amount: number;
  ecash_fee: number;
  payout: number;
  status: PegWithdrawalStatus;
  bundle_hash: string | null; // the latest bundle it is or was in
  bundle_vout: number | null; // its output in that bundle (and in the eCash M6)
  failed_bundles: string[];
  ecash_payment: PegEcashPayment | null; // status 'paid'
  refund: PegRefund | null;
}

export interface PegEcashPayment {
  ecash_txid: string; // the M6
  ecash_block: string;
  ecash_vout: number | null; // the withdrawal's output in the M6 (bundles: null)
  freebank_height: number; // the FreeBank block that recorded it
  freebank_block: string;
}

export type PegBundleStatus =
  | 'created' // waiting for approval on eCash
  | 'paid' // paid on eCash, the M6 is known
  | 'marked-paid' // marked paid, no matching M6 recorded
  | 'failed';

export interface PegBundle {
  bundle_hash: string;
  m6id: string;
  freebank_height: number;
  freebank_block: string;
  freebank_time: number;
  coinbase_txid: string;
  record_vout: number;
  format: 'cusf' | 'legacy' | 'unknown';
  ecash_fee: number | null;
  total: number;
  payouts: PegBundlePayout[];
  withdrawal_ids: string[];
  status: PegBundleStatus;
  status_height: number | null; // the FreeBank block that marked it paid or failed
  status_block: string | null;
  ecash_payment: PegEcashPayment | null;
}

export interface PegRefund {
  withdrawal_id: string;
  request_txid: string;
  request_vout: number;
  freebank_height: number;
  freebank_block: string;
  freebank_time: number;
  coinbase_txid: string | null;
  payout_vout: number | null; // the coinbase output that pays the refund
  amount: number | null; // the withdrawal's amount, when known
  refund_dest: string | null;
}

/** An eCash tx the chain recorded that is not tied to anything above (a 'D' record with no bundle to match). */
export interface PegEcashPaymentRecord {
  ecash_txid: string;
  ecash_block: string;
  freebank_height: number;
  freebank_block: string;
  freebank_time: number;
  coinbase_txid: string;
  record_vout: number;
  treasury_value: number | null;
  bundle_hash: string | null; // the bundle it paid, when the payouts match
}

export interface PegTreasury {
  ecash_txid: string;
  ecash_vout: number;
  value: number | null;
  freebank_height: number; // the FreeBank block whose record reported it
}

/** A peg event of one block, for /peg/block/:hash and the block page. */
export interface PegBlockEvents {
  freebank_height: number;
  freebank_block: string;
  deposits: PegDeposit[];
  deposits_paid: number; // count with a payout
  deposits_paid_amount: number;
  deposits_unpaid: number;
  refunds: PegRefund[];
  refunds_amount: number;
  bundles_created: PegBundle[];
  bundles_paid: PegBundle[]; // marked paid (a 'paid' commitment) in this block
  bundles_failed: PegBundle[];
  ecash_payments: PegEcashPaymentRecord[]; // M6 records in this block
  withdrawals: PegWithdrawal[]; // made in this block
}

export interface PegSummary {
  explorer_url: string;
  tip_height: number; // the index's top
  scanned_from_height: number;
  treasury: PegTreasury | null;
  deposits: number;
  deposits_amount: number;
  withdrawals: number;
  withdrawals_waiting: number; // waiting or requeued
  withdrawals_in_bundle: number;
  withdrawals_paid: number; // paid or marked paid
  withdrawals_refunded: number;
  bundles: number;
  current_bundle: PegBundle | null; // the newest bundle while it is 'created'
}

/** One peg output of a tx, with what the index knows about it. */
export interface PegTxOutputView {
  output: PegOutput;
  deposit?: PegDeposit; // a deposit record
  payment?: PegEcashPaymentRecord; // a bundle payment record
  bundle?: PegBundle; // a bundle record, or the bundle a commitment names
  withdrawal?: PegWithdrawal; // a withdrawal, or the one a refund request names
  refund?: PegRefund; // a refund request
}

/** GET peg/tx/:txid */
export interface PegTxView {
  explorer_url: string;
  txid: string;
  confirmed: boolean;
  indexed: boolean; // the index holds the tx's block, so the statuses are known
  freebank_height: number | null;
  freebank_block: string | null;
  coinbase: boolean;
  outputs: PegTxOutputView[];
  deposit_payouts: { vout: number, record_vout: number }[]; // coinbase outputs paying a deposit
  refund_payouts: { vout: number, withdrawal_id: string }[]; // coinbase outputs paying a refund
}

/** GET peg/block/:hash */
export interface PegBlockView extends PegBlockEvents {
  explorer_url: string;
  indexed: boolean; // false while the index has not reached this block
}

/** GET peg/ecash-tx/:txid: the FreeBank block that recorded an eCash tx. */
export interface PegEcashTxView {
  explorer_url: string;
  ecash_txid: string;
  kind: 'deposit' | 'bundle-payment';
  freebank_height: number;
  freebank_block: string;
  coinbase_txid: string;
  record_vout: number;
  deposit: PegDeposit | null;
  payment: PegEcashPaymentRecord | null;
}

export type PegListType = 'deposit' | 'withdrawal' | 'bundle';

/** GET pegs?type=&limit= */
export interface PegList {
  explorer_url: string;
  tip_height: number;
  type: PegListType;
  total: number;
  items: (PegDeposit | PegWithdrawal | PegBundle)[]; // newest first
}

/** The node's getwithdrawal (freebank rpc/misc.cpp). */
export interface PegNodeWithdrawal {
  destination: string; // the eCash address, in its eCash form
  destination_raw: string;
  scriptpubkey: string;
  refunddestination: string;
  amount: number; // szats
  amountmainchainfee: number;
  status: string; // 'Unspent', 'Pending - in WithdrawalBundle', 'Spent'
  hashblindtx: string;
}

/** GET withdrawal/:id */
export interface PegWithdrawalView {
  explorer_url: string;
  tip_height: number;
  withdrawal: PegWithdrawal | null;
  bundle: PegBundle | null;
  node: PegNodeWithdrawal | null; // null when the node does not know it (yet)
}
