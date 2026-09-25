import { BUNDLE_RETURN_DEST, readDepositHead, SIDECHAIN_DEPOSIT_FEE } from './peg-parser';
import { PegInUnpaidReason } from './peg.interfaces';

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
// Pure: reads output values, scripts and addresses only; the refund amounts are not in the block
// (the node keeps them in its withdrawal database), so refunds are the positive outputs left
// after vout[0] and the deposit payouts. That is exact for the stock builder; a modified builder's
// extra outputs would count as refunds.

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

export interface CoinbaseSplit {
  total: number; // every output together
  producerAmt: number; // what the block producer earns: total - deposit payouts - refunds
  pegInCount: number; // deposits from eCash paid out
  pegInAmt: number; // paid to those depositors (after the 1,000-szat fee each)
  pegInFees: number; // 1,000 szats x pegInCount, to the producer
  pegInUnpaidCount: number; // deposits recorded with nothing to pay (dust, or not a FreeBank address)
  bundleReturnCount: number; // withdrawal bundle payments recorded (destination 'D')
  refundCount: number;
  refundAmt: number;
  pegIns: PegInPayout[]; // in record order
  refundVouts: number[];
}

/** bech32 is case-insensitive (a depositor may type it in capitals); base58 is not. */
function sameAddress(output: string | undefined, dest: string): boolean {
  if (!output || !dest) {
    return false;
  }
  if (output === dest) {
    return true;
  }
  return /^[a-z0-9]+1[a-z0-9]+$/i.test(dest) && output.toLowerCase() === dest.toLowerCase();
}

/**
 * Split a coinbase's outputs (the node's JSON as mempool converts it: value in szats, script
 * hex, address). Mirrors the node's claim rule (sidechain.cpp ClaimDepositPayoutOutput): each
 * deposit claims one output of exactly its amount less 1,000 szats to its destination, and an
 * output is claimed once, so two identical deposits need two outputs. vout[0] is the producer's
 * and never claimed; among equal matches the one right before the record (where the builder
 * puts it) is taken first.
 */
export function splitFreebankCoinbase(vout: CoinbaseOutput[]): CoinbaseSplit {
  const outputs = vout || [];
  const split: CoinbaseSplit = {
    total: outputs.reduce((sum, o) => sum + (o?.value || 0), 0),
    producerAmt: 0,
    pegInCount: 0,
    pegInAmt: 0,
    pegInFees: 0,
    pegInUnpaidCount: 0,
    bundleReturnCount: 0,
    refundCount: 0,
    refundAmt: 0,
    pegIns: [],
    refundVouts: [],
  };
  const claimed = new Set<number>([0]);

  outputs.forEach((output, i) => {
    const head = readDepositHead(output?.scriptpubkey || '');
    if (!head) {
      return;
    }
    if (head.dest === BUNDLE_RETURN_DEST) {
      split.bundleReturnCount++;
      return;
    }
    const entry: PegInPayout = { record_vout: i, payout_vout: null, dest: head.dest, amount: head.amount, paid: 0, unpaid_reason: null };
    if (head.amount <= SIDECHAIN_DEPOSIT_FEE) {
      entry.unpaid_reason = 'at-or-below-fee';
    } else {
      const want = head.amount - SIDECHAIN_DEPOSIT_FEE;
      const matches = (j: number): boolean => !claimed.has(j) && outputs[j]?.value === want && sameAddress(outputs[j]?.scriptpubkey_address, head.dest);
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

  outputs.forEach((output, i) => {
    if (!claimed.has(i) && output?.value > 0) {
      split.refundCount++;
      split.refundAmt += output.value;
      split.refundVouts.push(i);
    }
  });

  split.producerAmt = split.total - split.pegInAmt - split.refundAmt;
  return split;
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
}

export function freebankRewardExtras(coinbaseVout: CoinbaseOutput[]): FreebankRewardExtras {
  const split = splitFreebankCoinbase(coinbaseVout);
  return {
    reward: split.producerAmt,
    pegInCount: split.pegInCount,
    pegInAmt: split.pegInAmt,
    pegInFees: split.pegInFees,
    pegInUnpaidCount: split.pegInUnpaidCount,
    refundCount: split.refundCount,
    refundAmt: split.refundAmt,
  };
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
