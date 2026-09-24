import { FreebankBill, FreebankBillStatus, FreebankTxFamily } from '@interfaces/freebank-credit.interface';

// FreeBank credit tx families and their op codes, from the freebank headers:
// primitives/transaction.h (versions), bill.h, house.h, note.h, deposit.h, pool.h, settle.h,
// oracle.h (the *_OP_* constants). `name` is what the backend sends as op_name (the constant's
// suffix in lower case); `label` is the plain-English text to show.
// Pure TypeScript (no Angular) so it can be unit-tested or copied into the backend.

export interface CreditFamilyInfo {
  version: number;
  label: string;                  // same wording as CREDIT_TX_LABELS in shared/transaction.utils.ts
}

export const CREDIT_FAMILIES: { [family in FreebankTxFamily]: CreditFamilyInfo } = {
  bill: { version: 11, label: 'Bill' },
  house: { version: 12, label: 'House' },
  note: { version: 13, label: 'Note' },
  deposit: { version: 14, label: 'Term deposit' },
  pool: { version: 15, label: 'Pool' },
  settle: { version: 16, label: 'Settlement' },
  oracle: { version: 17, label: 'Oracle' },
};

export const CREDIT_FAMILY_ORDER: FreebankTxFamily[] = ['house', 'note', 'bill', 'deposit', 'pool', 'settle', 'oracle'];

export function creditFamilyForVersion(version: number): FreebankTxFamily | undefined {
  return CREDIT_FAMILY_ORDER.find((family) => CREDIT_FAMILIES[family].version === version);
}

export interface CreditOpInfo {
  name: string;
  label: string;
}

export const CREDIT_OPS: { [family in FreebankTxFamily]: { [op: number]: CreditOpInfo } } = {
  bill: {
    1: { name: 'issue', label: 'Issue' },
    2: { name: 'endorse', label: 'Endorse' },
    3: { name: 'retire', label: 'Retire (paid by the acceptor)' },
    4: { name: 'claim', label: 'Claim escrow (defaulted)' },
    5: { name: 'discount', label: 'Discount at a house' },
    6: { name: 'recourse', label: 'Recourse' },
    7: { name: 'hretire', label: 'Retire (held by a house)' },
    8: { name: 'hclaim', label: 'Claim escrow (held by a house)' },
  },
  house: {
    1: { name: 'register', label: 'Register house' },
    2: { name: 'topup', label: 'Top up pledge' },
    3: { name: 'admit', label: 'Admit partner' },
    4: { name: 'exit', label: 'Partner exit' },
    5: { name: 'winddown', label: 'Wind down' },
    6: { name: 'reclaim', label: 'Reclaim pledge' },
    7: { name: 'attest', label: 'Reserve attestation' },
    8: { name: 'defer', label: 'Invoke option clause' },
    9: { name: 'renew', label: 'Renew option clause' },
    10: { name: 'release', label: 'Release locked reserves' },
  },
  note: {
    1: { name: 'mint', label: 'Mint notes' },
    2: { name: 'transfer', label: 'Transfer notes' },
    3: { name: 'redeem', label: 'Redeem notes' },
    4: { name: 'lock', label: 'Lock (reserved)' },
    5: { name: 'unlock', label: 'Unlock (reserved)' },
    6: { name: 'claim', label: 'Claim (insolvent house)' },
    7: { name: 'demand', label: 'Demand redemption' },
    8: { name: 'protest', label: 'Protest unpaid demand' },
  },
  deposit: {
    1: { name: 'originate', label: 'Open term deposit' },
    2: { name: 'transfer', label: 'Transfer term deposit' },
    3: { name: 'withdraw', label: 'Withdraw at maturity' },
    4: { name: 'claim', label: 'Claim (insolvent house)' },
  },
  pool: {
    1: { name: 'create', label: 'Create pool' },
    2: { name: 'add_liq', label: 'Add liquidity' },
    3: { name: 'remove_liq', label: 'Remove liquidity' },
    4: { name: 'swap', label: 'Swap' },
    5: { name: 'retire', label: 'Retire pool' },
  },
  settle: {
    1: { name: 'exchange', label: 'Note exchange between houses' },
  },
  oracle: {
    1: { name: 'bond', label: 'Bond gold-price submitter' },
    2: { name: 'submit', label: 'Gold price submission' },
  },
};

/** Plain-English label for a credit op; falls back to the backend's op_name, then 'Op <n>'. */
export function creditOpLabel(family: FreebankTxFamily | string, op: number, opName?: string): string {
  const known = CREDIT_OPS[family as FreebankTxFamily]?.[op];
  if (known) {
    return known.label;
  }
  if (opName) {
    return opName.charAt(0).toUpperCase() + opName.slice(1).replace(/_/g, ' ');
  }
  return `Op ${op}`;
}

export const BILL_STATUS_LABELS: { [status in FreebankBillStatus]: string } = {
  a: 'Active',
  r: 'Retired',
  d: 'Defaulted',
  x: 'Disputed',
};

/**
 * Bill status for display. An active bill held by a house (owner_house_id != 0) was discounted
 * and sits in that house's loan book, so it reads 'Discounted'.
 */
export function billStatusLabel(bill: Pick<FreebankBill, 'status' | 'owner_house_id'>): string {
  if (bill?.status === 'a' && bill.owner_house_id) {
    return 'Discounted';
  }
  return BILL_STATUS_LABELS[bill?.status] || 'Unknown';
}

export const HOUSE_TIER_LABELS: { [tier: number]: string } = {
  0: 'Bonded solo',
  1: 'Encumbered solo',
  2: 'Restricted partnership (fixed M-of-N)',
  3: 'Partnership (M-of-N, admits partners)',
};
