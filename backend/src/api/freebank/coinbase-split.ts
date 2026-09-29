import logger from '../../logger';
import { isBundlePayment, parsePegOutput, readDepositHead, SIDECHAIN_DEPOSIT_FEE } from './peg-parser';
import { PegInUnpaidReason } from './peg.interfaces';
import { unwrapFullDepositAddress } from './deposit-address';

// What a FreeBank coinbase pays, split by who gets it: the block producer, depositors from
// eCash, and withdrawal refunds. FreeBank has no block subsidy (validation.cpp GetBlockSubsidy
// returns 0), so the coinbase can pay at most the block's fees plus its deposit and refund
// payouts (validation.cpp, bad-cb-amount), and what the producer earns is its fees plus
// 1,000 szats for every deposit it pays out (SIDECHAIN_DEPOSIT_FEE).
//
// The stock block builder (miner.cpp CreateNewBlock) lays the coinbase out as:
//   vout[0]  the producer: fees + 1,000 x deposits paid (set last)
//   zero-value commitments (bundle status, previous block, bundle hash, block version) and, in a
//            block that makes one, the withdrawal bundle
//   refund payouts, each worth the whole withdrawal (payout + eCash fee), in blocks with no bundle
//   per deposit from eCash: its payout (amount less 1,000 szats, when one is owed), then its record
//   the witness commitment
//
// Refunds: every refund request in any tx of the block (validation.cpp ConnectBlock) must be paid,
// in the same block, by a coinbase output of exactly the withdrawal's amount to its refund
// address. The amounts and addresses are in the node's withdrawal database, not in the block, so
// the caller passes them (RefundDue, from $blockRefundsDue). Any other positive output (a modified
// builder may split its earnings) is the producer's too.
//
// splitFreebankCoinbase is pure: it reads output values, scripts and addresses only.
// $blockRefundsDue asks the node.

export interface CoinbaseOutput {
  value: number; // szats
  scriptpubkey: string;
  scriptpubkey_address?: string;
}

export interface PegInPayout {
  record_vout: number;
  payout_vout: number | null;
  dest: string;
  amount: number; // added to the eCash treasury
  paid: number; // to the depositor
  unpaid_reason: PegInUnpaidReason | null;
}

/** A refund the block must pay: the withdrawal's whole amount to its refund address. */
export interface RefundDue {
  withdrawal_id: string;
  amount: number; // szats
  dest: string; // the refund address as the withdrawal stores it
}

export interface CoinbaseSplit {
  total: number; // every output together
  producerAmt: number; // what the block producer earns: total - deposit payouts - refunds
  pegInCount: number; // deposits from eCash paid out
  pegInAmt: number; // paid to those depositors (after the 1,000-szat fee each)
  pegInFees: number; // 1,000 szats x pegInCount, to the producer
  pegInUnpaidCount: number; // deposits recorded with nothing to pay (dust, or not a FreeBank address)
  bundleReturnCount: number; // withdrawal bundle payments recorded (destination 'D', amount 0 or less)
  pegRecords: number; // deposit and bundle records, and bundle paid/failed commitments: the block has peg events
  refundCount: number; // refund payouts found (one per RefundDue that has its output)
  refundAmt: number;
  pegIns: PegInPayout[]; // in record order
  refundVouts: number[]; // ascending
  otherVouts: number[]; // positive outputs after vout[0] paying neither a deposit nor a refund: the producer's
}

/** A coinbase output that makes a peg event (a record or a bundle status change; not the current-bundle commitment). */
function isPegRecord(script: string): boolean {
  return /^6aacdcf66f(44|50)/.test(script) || (script.length === 74 && /^6a(fb5345de|fa86c689)/.test(script));
}

// the node's own spelling of a bech32 address: lower case, the HRP, '1', then 6 or more symbols
const BECH32_ADDRESS = /^[a-z0-9]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/;
// C isspace, which base58.cpp skips; String.trim() would strip more (NBSP, U+FEFF, ...)
const C_SPACE_AT_ENDS = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/**
 * Whether a destination string names the address an output pays, as the node reads the string
 * (freebank base58.cpp DecodeDestination). `output` is the node's own spelling of the output's
 * address. bech32 (bech32.cpp Decode) takes the whole string: printable ASCII in one case, lower
 * or upper. base58 (DecodeBase58Check on str.c_str()) stops at the first NUL and skips C
 * whitespace at both ends; whitespace left inside is no address. The same rule as
 * freebank-tx-flags.ts and the frontend's peg-view.ts.
 */
export function sameAddress(output: string | undefined | null, dest: string): boolean {
  if (!output || !dest) {
    return false;
  }
  if (BECH32_ADDRESS.test(output)) {
    return /^[\x21-\x7e]+$/.test(dest) && (dest === dest.toLowerCase() || dest === dest.toUpperCase()) && dest.toLowerCase() === output;
  }
  return dest.split('\0')[0].replace(C_SPACE_AT_ENDS, '') === output;
}

/**
 * Whether a payout output pays a deposit's destination. From v0.2.17 the full deposit address
 * s130_<address>_<checksum> pays exactly <address> in its canonical spelling, which is how the output's address is
 * written (deposit-address.ts, D-2026-09-30-1); any other destination is read as sameAddress reads it.
 */
export function depositPaysTo(output: string | undefined | null, dest: string): boolean {
  const unwrapped = unwrapFullDepositAddress(dest);
  return unwrapped !== null ? !!output && output === unwrapped : sameAddress(output, dest);
}

function isOpReturn(output: CoinbaseOutput | undefined): boolean {
  return (output?.scriptpubkey || '').startsWith('6a');
}

/**
 * Split a coinbase's outputs (the node's JSON as mempool converts it: value in szats, script
 * hex, address). Mirrors the node's claim rule (sidechain.cpp ClaimDepositPayoutOutput): each
 * deposit claims one output of exactly its amount less 1,000 szats to its destination, and an
 * output is claimed once, so two identical deposits need two outputs. vout[0] is the producer's
 * and never claimed; among equal matches the one right before the record (where the builder
 * puts it) is taken first. Then each refund in `refunds` (in request order) claims one of the
 * outputs left, of exactly its amount to its refund address. With no `refunds`, no output is
 * taken for a refund.
 */
export function splitFreebankCoinbase(vout: CoinbaseOutput[], refunds: RefundDue[] = []): CoinbaseSplit {
  const outputs = vout || [];
  const split: CoinbaseSplit = {
    total: outputs.reduce((sum, o) => sum + (o?.value || 0), 0),
    producerAmt: 0,
    pegInCount: 0,
    pegInAmt: 0,
    pegInFees: 0,
    pegInUnpaidCount: 0,
    bundleReturnCount: 0,
    pegRecords: outputs.filter((o) => isPegRecord(o?.scriptpubkey || '')).length,
    refundCount: 0,
    refundAmt: 0,
    pegIns: [],
    refundVouts: [],
    otherVouts: [],
  };
  const claimed = new Set<number>([0]);

  outputs.forEach((output, i) => {
    const head = readDepositHead(output?.scriptpubkey || '');
    if (!head) {
      return;
    }
    if (isBundlePayment(head.dest, head.amount)) {
      split.bundleReturnCount++;
      return;
    }
    const entry: PegInPayout = { record_vout: i, payout_vout: null, dest: head.dest, amount: head.amount, paid: 0, unpaid_reason: null };
    if (head.dest === 'D') {
      entry.unpaid_reason = 'not-a-freebank-address'; // sidechain.cpp GetDepositPayoutOutput: 'D' is never paid, whatever the amount
    } else if (head.amount <= SIDECHAIN_DEPOSIT_FEE) {
      entry.unpaid_reason = 'at-or-below-fee';
    } else {
      const want = head.amount - SIDECHAIN_DEPOSIT_FEE;
      const matches = (j: number): boolean => !claimed.has(j) && outputs[j]?.value === want && depositPaysTo(outputs[j]?.scriptpubkey_address, head.dest);
      let found = i - 1 >= 1 && matches(i - 1) ? i - 1 : -1;
      for (let j = 1; found < 0 && j < outputs.length; j++) {
        if (matches(j)) {
          found = j;
        }
      }
      if (found >= 0) {
        claimed.add(found);
        entry.payout_vout = found;
        entry.paid = want;
      } else {
        entry.unpaid_reason = 'not-a-freebank-address';
      }
    }
    if (entry.payout_vout !== null) {
      split.pegInCount++;
      split.pegInAmt += entry.paid;
      split.pegInFees += SIDECHAIN_DEPOSIT_FEE;
    } else {
      split.pegInUnpaidCount++;
    }
    split.pegIns.push(entry);
  });

  // validation.cpp: each refund request needs an output of the withdrawal's amount to its refund address
  for (const refund of refunds) {
    const j = outputs.findIndex((o, n) => n > 0 && !claimed.has(n) && !isOpReturn(o) && o?.value === refund.amount && sameAddress(o?.scriptpubkey_address, refund.dest));
    if (j > 0) {
      claimed.add(j);
      split.refundCount++;
      split.refundAmt += outputs[j].value;
      split.refundVouts.push(j);
    }
  }
  split.refundVouts.sort((a, b) => a - b);

  outputs.forEach((output, i) => {
    if (!claimed.has(i) && output?.value > 0 && !isOpReturn(output)) {
      split.otherVouts.push(i);
    }
  });

  split.producerAmt = split.total - split.pegInAmt - split.refundAmt;
  return split;
}

/**
 * Whether the coinbase pays something after vout[0] and its deposit payouts. Only then can it
 * pay a refund, so only then does the reward need the block's refund requests.
 */
export function coinbaseMayPayRefunds(coinbaseVout: CoinbaseOutput[]): boolean {
  return splitFreebankCoinbase(coinbaseVout).otherVouts.length > 0;
}

/** A block's reward and peg fields (mempool.interfaces.ts BlockExtension), from its coinbase. */
export interface FreebankRewardExtras {
  reward: number; // what the block producer earns
  pegInCount: number;
  pegInAmt: number;
  pegInFees: number;
  pegInUnpaidCount: number;
  refundCount: number;
  refundAmt: number;
  pegRecords: number;
}

/** `refunds`: the block's refunds ($blockRefundsDue); none when the coinbase cannot pay one. */
export function freebankRewardExtras(coinbaseVout: CoinbaseOutput[], refunds: RefundDue[] = []): FreebankRewardExtras {
  const split = splitFreebankCoinbase(coinbaseVout, refunds);
  return {
    reward: split.producerAmt,
    pegInCount: split.pegInCount,
    pegInAmt: split.pegInAmt,
    pegInFees: split.pegInFees,
    pegInUnpaidCount: split.pegInUnpaidCount,
    refundCount: split.refundCount,
    refundAmt: split.refundAmt,
    pegRecords: split.pegRecords,
  };
}

/** The node calls $blockRefundsDue makes (bitcoinClient in blocks.ts; tests pass their own). */
export interface RefundNode {
  getBlock(hash: string, verbosity: number): Promise<any>;
  getWithdrawal(id: string): Promise<{ refunddestination: string, amount: number }>;
}

/**
 * The refunds a block pays: every refund request in any of its txs, the coinbase included, in
 * block order, each with its withdrawal's amount (szats) and refund address from the node's
 * getwithdrawal (rpc/misc.cpp). `txs`: all of the block's txs when the caller has them (their
 * output scripts); null, and the block is read with getblock <hash> 2. A node failure throws, so
 * the caller stores no reward rather than a wrong one. A withdrawal the node does not know (only
 * possible for a block off its best chain) is left out, and its output stays the producer's.
 * @asyncUnsafe
 */
export async function $blockRefundsDue(blockHash: string, txs: { vout?: { scriptpubkey?: string }[] }[] | null, node: RefundNode): Promise<RefundDue[]> {
  let scripts: string[][];
  if (txs) {
    scripts = txs.map((tx) => (tx?.vout || []).map((o) => o?.scriptpubkey || ''));
  } else {
    const block = await node.getBlock(blockHash, 2);
    scripts = (block?.tx || []).map((tx: any) => (tx?.vout || []).map((o: any) => o?.scriptPubKey?.hex || ''));
  }
  const ids: string[] = [];
  scripts.forEach((outs, i) => outs.forEach((script, n) => {
    const out = parsePegOutput(script, n, i === 0); // the node's exact shape: 102 bytes, an id that is not zero
    if (out?.kind === 'refund-request' && !ids.includes(out.withdrawal_id)) {
      ids.push(out.withdrawal_id);
    }
  }));
  const due: RefundDue[] = [];
  for (const id of ids) {
    let w: { refunddestination: string, amount: number } | null;
    try {
      w = await node.getWithdrawal(id);
    } catch (e: any) {
      if (/does not exist|invalid id/i.test(e?.message ?? '')) {
        logger.warn(`FreeBank block ${blockHash}: the node does not know withdrawal ${id}, whose refund request is in the block`);
        continue;
      }
      throw e;
    }
    if (typeof w?.amount === 'number' && typeof w.refunddestination === 'string') {
      due.push({ withdrawal_id: id, amount: w.amount, dest: w.refunddestination });
    }
  }
  return due;
}

/**
 * The stock builder pays its producer exactly the fees plus 1,000 szats per deposit paid out; a
 * block that pays it more (or less) is worth a line in the log. The genesis block is skipped.
 */
export function unexpectedReward(height: number, extras: { reward?: number, totalFees?: number, pegInFees?: number }): string | null {
  if (height <= 0 || typeof extras.reward !== 'number' || typeof extras.totalFees !== 'number') {
    return null;
  }
  const expected = extras.totalFees + (extras.pegInFees ?? 0);
  return extras.reward === expected ? null
    : `FreeBank block ${height}: the producer's output is ${extras.reward} szats, fees + deposit fees are ${expected}`;
}
