import { FreebankBill } from '@interfaces/freebank-credit.interface';
import { formatBlockCount } from '@app/freebank/credit-units';

// Display helpers shared by the bill pages (/bills and /bill/:id). Pure TypeScript.
//
// The node's bill rules these follow (freebank src/bill.h, validation.cpp CheckBillOperation):
//  - status 'a' covers issued and endorsed bills. owner_house_id != 0 means a house bought the
//    bill (BILL_OP_DISCOUNT) and holds it on its loan book.
//  - The acceptor may pay (retire) an active bill at any time: status 'r'.
//  - A house may discount a bill only before it falls due: in a block below maturity_height.
//  - The holder may claim the escrow only in a block above maturity_height + grace_blocks: the
//    bill is then 'd' (defaulted). A house-held bill is claimed by the house quorum instead.

/** The filter keys of the bill list; 'unknown' is a status letter the page does not know. */
export type BillStatusKey = 'active' | 'discounted' | 'retired' | 'defaulted' | 'disputed' | 'unknown';
export type BillFilter = 'all' | BillStatusKey;

export const BILL_FILTER_ORDER: BillFilter[] = ['all', 'active', 'discounted', 'retired', 'defaulted', 'disputed'];

export const BILL_FILTER_LABELS: { [key in BillFilter]: string } = {
  all: 'All',
  active: 'Active',
  discounted: 'Discounted',
  retired: 'Retired',
  defaulted: 'Defaulted',
  disputed: 'Disputed',
  unknown: 'Unknown',
};

/** One-line meaning of each status, for tooltips. */
export const BILL_STATUS_HELP: { [key in BillStatusKey]: string } = {
  active: 'Outstanding and held privately: the acceptor has not paid it yet.',
  discounted: 'Outstanding and bought by a house before maturity: it sits on that house\'s loan book, and the house collects the face value.',
  retired: 'Paid: the acceptor paid the face value to the holder.',
  defaulted: 'Unpaid after the grace period: the escrow bond was claimed instead (by the holder, or into the escrow of the house that held it).',
  disputed: 'Marked disputed (reserved for a future dispute process).',
  unknown: 'A status this explorer does not recognise.',
};

export function billStatusKey(bill: Pick<FreebankBill, 'status' | 'owner_house_id'>): BillStatusKey {
  switch (bill?.status) {
    case 'a': return bill.owner_house_id ? 'discounted' : 'active';
    case 'r': return 'retired';
    case 'd': return 'defaulted';
    case 'x': return 'disputed';
    default: return 'unknown';
  }
}

export function parseBillFilter(value: string | null): BillFilter {
  return BILL_FILTER_ORDER.includes(value as BillFilter) ? value as BillFilter : 'all';
}

/**
 * Where an outstanding bill stands against its dates:
 *   running    the tip is below maturity_height
 *   grace      maturity reached; the grace blocks have not all passed
 *   claimable  past maturity + grace and still unpaid: the escrow can be claimed
 *   closed     no longer outstanding (retired, defaulted, disputed)
 */
export type BillPhase = 'running' | 'grace' | 'claimable' | 'closed';

export interface BillMaturity {
  phase: BillPhase;
  maturityHeight: number;
  graceEndHeight: number;         // last block of the grace period (maturity + grace)
  claimableFrom: number;          // first block a claim on the escrow can be mined in (grace end + 1)
  termBlocks: number;             // issued -> maturity
  short: string;                  // short line for the list ('' once closed)
  phaseText: string;              // the phase in a few words ('' once closed)
  sentence: string;               // one sentence for the bill page
}

export function billMaturity(bill: FreebankBill, tipHeight: number): BillMaturity {
  const maturityHeight = bill.maturity_height;
  const grace = bill.grace_blocks || 0;
  const graceEndHeight = maturityHeight + grace;
  const claimableFrom = graceEndHeight + 1;
  const termBlocks = Math.max(0, maturityHeight - bill.issued_height);
  const outstanding = bill.status === 'a';
  const houseHeld = !!bill.owner_house_id;
  const claimant = houseHeld ? 'the house' : 'the holder';

  let phase: BillPhase;
  let short: string;
  let sentence: string;
  if (!outstanding) {
    phase = 'closed';
    short = '';
    sentence = tipHeight < maturityHeight
      ? `Was due at block ${maturityHeight}; it is no longer outstanding.`
      : `Fell due at block ${maturityHeight}; it is no longer outstanding.`;
  } else if (tipHeight < maturityHeight) {
    phase = 'running';
    short = `in ${formatBlockCount(maturityHeight - tipHeight)}`;
    sentence = `Falls due at block ${maturityHeight}, ${formatBlockCount(maturityHeight - tipHeight)} from now. The acceptor owes the face value to the holder then.`;
  } else if (tipHeight < claimableFrom) {
    phase = 'grace';
    const left = claimableFrom - tipHeight;
    short = tipHeight === maturityHeight
      ? 'matured at the tip, in grace'
      : `matured ${formatBlockCount(tipHeight - maturityHeight)} ago, in grace`;
    sentence = tipHeight === maturityHeight
      ? `Fell due at the tip. If it is still unpaid, ${claimant} can claim the escrow from block ${claimableFrom}.`
      : `Fell due ${formatBlockCount(tipHeight - maturityHeight)} ago and is in its grace period. If it is still unpaid, ${claimant} can claim the escrow from block ${claimableFrom}, in ${formatBlockCount(left)}.`;
  } else {
    phase = 'claimable';
    short = `matured ${formatBlockCount(tipHeight - maturityHeight)} ago, escrow claimable`;
    sentence = `Fell due ${formatBlockCount(tipHeight - maturityHeight)} ago and is still unpaid. The grace period ended at block ${graceEndHeight}, so ${claimant} can now claim the escrow.`;
  }
  const phaseText = {
    running: 'Not yet due.',
    grace: 'Due, in its grace period.',
    claimable: 'Overdue: the grace period is over.',
    closed: '',
  }[phase];
  return { phase, maturityHeight, graceEndHeight, claimableFrom, termBlocks, short, phaseText, sentence };
}

/** The escrow as a share of face, e.g. 75 for 0.75 ECX against 1.00 ECX; null without a face. */
export function escrowPercentOfFace(bill: Pick<FreebankBill, 'amount' | 'escrow'>): number | null {
  if (typeof bill?.amount !== 'number' || typeof bill?.escrow !== 'number' || !(bill.amount > 0)) {
    return null;
  }
  return bill.escrow / bill.amount * 100;
}

/** The first holder named at issue (the payee): the first endorser, or the holder if never endorsed. */
export function billPayee(bill: Pick<FreebankBill, 'endorsements' | 'holder_pubkey'>): string {
  return bill.endorsements?.length ? bill.endorsements[0].from : bill.holder_pubkey;
}
