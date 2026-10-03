import { FREEBANK_TX_FLAGS } from '@app/freebank/freebank-tx-flags';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

export interface Filter {
  key: string,
  label: string,
  flag: bigint,
  toggle?: string,
  group?: string,
  important?: boolean,
  tooltip?: boolean,
  txPage?: boolean,
}

export type FilterMode = 'and' | 'or' | 'nor';

export type GradientMode = 'fee' | 'age';

export interface ActiveFilter {
  mode: FilterMode,
  filters: string[],
  gradient: GradientMode,
}

// binary flags for transaction classification
export const TransactionFlags = {
  // features
  rbf:                                                         0b00000001n,
  no_rbf:                                                      0b00000010n,
  v1:                                                          0b00000100n,
  v2:                                                          0b00001000n,
  v3:                                                          0b00010000n,
  nonstandard:                                                 0b00100000n,
  // address types
  p2pk:                                               0b00000001_00000000n,
  p2ms:                                               0b00000010_00000000n,
  p2pkh:                                              0b00000100_00000000n,
  p2sh:                                               0b00001000_00000000n,
  p2wpkh:                                             0b00010000_00000000n,
  p2wsh:                                              0b00100000_00000000n,
  p2tr:                                               0b01000000_00000000n,
  // behavior
  cpfp_parent:                               0b00000001_00000000_00000000n,
  cpfp_child:                                0b00000010_00000000_00000000n,
  replacement:                               0b00000100_00000000_00000000n,
  acceleration:                              0b00001000_00000000_00000000n,
  // data
  op_return:                        0b00000001_00000000_00000000_00000000n,
  fake_pubkey:                      0b00000010_00000000_00000000_00000000n,
  inscription:                      0b00000100_00000000_00000000_00000000n,
  fake_scripthash:                  0b00001000_00000000_00000000_00000000n,
  annex:                            0b00010000_00000000_00000000_00000000n,
  // heuristics
  coinjoin:                0b00000001_00000000_00000000_00000000_00000000n,
  consolidation:           0b00000010_00000000_00000000_00000000_00000000n,
  batch_payout:            0b00000100_00000000_00000000_00000000_00000000n,
  // sighash
  sighash_all:    0b00000001_00000000_00000000_00000000_00000000_00000000n,
  sighash_none:   0b00000010_00000000_00000000_00000000_00000000_00000000n,
  sighash_single: 0b00000100_00000000_00000000_00000000_00000000_00000000n,
  sighash_default:0b00001000_00000000_00000000_00000000_00000000_00000000n,
  sighash_acp:    0b00010000_00000000_00000000_00000000_00000000_00000000n,
  // FreeBank: credit families, transfers to and from eCash, assets (bits 29-31, 35, 45-52), kept in step
  // with the backend's mempool.interfaces.ts by sharing freebank-tx-flags.ts
  ...FREEBANK_TX_FLAGS,
};

export function toFlags(filters: string[]): bigint {
  let flag = 0n;
  for (const filter of filters) {
    flag |= TransactionFlags[filter];
  }
  return flag;
}

export function toFilters(flags: bigint): Filter[] {
  const filters = [];
  for (const filter of Object.values(TransactionFilters).filter(f => f !== undefined)) {
    if (flags & filter.flag) {
      filters.push(filter);
    }
  }
  return filters;
}

// FreeBank: the node has no Taproot (a Core 0.16-era chassis), so the Taproot, inscription, annex
// and sighash_default filters are not offered. Nor are Version 1/2/3 (v3 is FreeBank's default tx
// version, so 'Version 3' matched every ordinary tx; credit txs are told apart by their own
// filters) or Coinjoin (no coinjoin tools exist for FreeBank: the heuristic only gives false
// positives). Their TransactionFlags bits stay reserved, and the classifiers may still set them.
// The credit filters stay out of the tooltip and the tx page, which name the credit type already.
// A tx is one credit family at most, so the seven family filters share a toggle group (not 'Any
// credit'); see pickFilter below for when it applies.
export const TransactionFilters: { [key: string]: Filter } = {
    /* FreeBank: credit families (tx versions 11-17) */
    credit: { key: 'credit', label: 'Any credit', flag: TransactionFlags.credit, important: true, tooltip: false, txPage: false, },
    bill: { key: 'bill', label: 'Bill', flag: TransactionFlags.bill, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    house: { key: 'house', label: 'House', flag: TransactionFlags.house, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    note: { key: 'note', label: 'Note', flag: TransactionFlags.note, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    term_deposit: { key: 'term_deposit', label: 'Term deposit', flag: TransactionFlags.term_deposit, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    pool: { key: 'pool', label: 'Pool', flag: TransactionFlags.pool, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    settlement: { key: 'settlement', label: 'Settlement', flag: TransactionFlags.settlement, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    oracle: { key: 'oracle', label: 'Oracle', flag: TransactionFlags.oracle, toggle: 'credit_family', important: true, tooltip: false, txPage: false, },
    /* FreeBank: transfers to and from eCash */
    deposit_from_ecash: { key: 'deposit_from_ecash', label: 'Deposit from eCash', flag: TransactionFlags.deposit_from_ecash, important: true, tooltip: true, txPage: true, },
    withdrawal_to_ecash: { key: 'withdrawal_to_ecash', label: 'Withdrawal to eCash', flag: TransactionFlags.withdrawal_to_ecash, important: true, tooltip: true, txPage: true, },
    withdrawal_refund: { key: 'withdrawal_refund', label: 'Withdrawal refund', flag: TransactionFlags.withdrawal_refund, important: true, tooltip: true, txPage: true, },
    /* FreeBank: assets (v0.2.18) */
    asset_created: { key: 'asset_created', label: 'Asset created', flag: TransactionFlags.asset_created, important: true, tooltip: false, txPage: false, },
    /* features */
    rbf: { key: 'rbf', label: 'RBF enabled', flag: TransactionFlags.rbf, toggle: 'rbf', important: true, tooltip: true, txPage: false, },
    no_rbf: { key: 'no_rbf', label: 'RBF disabled', flag: TransactionFlags.no_rbf, toggle: 'rbf', important: true, tooltip: true, txPage: false, },
    nonstandard: { key: 'nonstandard', label: 'Non-Standard', flag: TransactionFlags.nonstandard, important: true, tooltip: true, txPage: true, },
    /* address types */
    p2pk: { key: 'p2pk', label: 'P2PK', flag: TransactionFlags.p2pk, important: true, tooltip: true, txPage: true, },
    p2ms: { key: 'p2ms', label: 'Bare multisig', flag: TransactionFlags.p2ms, important: true, tooltip: true, txPage: true, },
    p2pkh: { key: 'p2pkh', label: 'P2PKH', flag: TransactionFlags.p2pkh, important: true, tooltip: false, },
    p2sh: { key: 'p2sh', label: 'P2SH', flag: TransactionFlags.p2sh, important: true, tooltip: false, },
    p2wpkh: { key: 'p2wpkh', label: 'P2WPKH', flag: TransactionFlags.p2wpkh, important: true, tooltip: false, },
    p2wsh: { key: 'p2wsh', label: 'P2WSH', flag: TransactionFlags.p2wsh, important: true, tooltip: false, },
    /* behavior */
    cpfp_parent: { key: 'cpfp_parent', label: 'Paid for by child', flag: TransactionFlags.cpfp_parent, important: true, tooltip: true, txPage: false, },
    cpfp_child: { key: 'cpfp_child', label: 'Pays for parent', flag: TransactionFlags.cpfp_child, important: true, tooltip: true, txPage: false, },
    replacement: { key: 'replacement', label: 'Replacement', flag: TransactionFlags.replacement, important: true, tooltip: true, txPage: false, },
    acceleration: window?.['__env']?.ACCELERATOR ? { key: 'acceleration', label: $localize`:@@b484583f0ce10f3341ab36750d05271d9d22c9a1:Accelerated`, flag: TransactionFlags.acceleration, important: false } : undefined,
    /* data */
    op_return: { key: 'op_return', label: 'OP_RETURN', flag: TransactionFlags.op_return, important: true, tooltip: true, txPage: true, },
    fake_pubkey: { key: 'fake_pubkey', label: 'Fake pubkey', flag: TransactionFlags.fake_pubkey, tooltip: true, txPage: true, },
    fake_scripthash: { key: 'fake_scripthash', label: 'Fake scripthash', flag: TransactionFlags.fake_scripthash, tooltip: true, txPage: true,},
    /* heuristics */
    consolidation: { key: 'consolidation', label: $localize`Consolidation`, flag: TransactionFlags.consolidation, tooltip: true, txPage: true, },
    batch_payout: { key: 'batch_payout', label: $localize`Batch payment`, flag: TransactionFlags.batch_payout, tooltip: true, txPage: true, },
    /* sighash */
    sighash_all: { key: 'sighash_all', label: 'sighash_all', flag: TransactionFlags.sighash_all },
    sighash_none: { key: 'sighash_none', label: 'sighash_none', flag: TransactionFlags.sighash_none, tooltip: true },
    sighash_single: { key: 'sighash_single', label: 'sighash_single', flag: TransactionFlags.sighash_single, tooltip: true },
    sighash_acp: { key: 'sighash_acp', label: 'sighash_anyonecanpay', flag: TransactionFlags.sighash_acp, tooltip: true },
};

export const FilterGroups: { label: string, filters: Filter[]}[] = [
  // FreeBank: the gold oracle's filter only while gold is shown (freebank/gold-display.ts)
  { label: 'Credit', filters: ['credit', 'bill', 'house', 'note', 'term_deposit', 'pool', 'settlement', ...(GOLD_SHOWN ? ['oracle'] : [])] },
  { label: 'To and from eCash', filters: ['deposit_from_ecash', 'withdrawal_to_ecash', 'withdrawal_refund'] },
  { label: 'Assets', filters: ['asset_created'] },
  { label: $localize`:@@885666551418fd59011ceb09d5c481095940193b:Features`, filters: ['rbf', 'no_rbf', 'nonstandard'] },
  { label: $localize`Address Types`, filters: ['p2pk', 'p2ms', 'p2pkh', 'p2sh', 'p2wpkh', 'p2wsh'] },
  { label: $localize`Behavior`, filters: ['cpfp_parent', 'cpfp_child', 'replacement', 'acceleration'] },
  { label: $localize`Data`, filters: ['op_return', 'fake_pubkey', 'fake_scripthash'] },
  { label: $localize`Heuristics`, filters: ['consolidation', 'batch_payout'] },
  { label: $localize`Sighash Flags`, filters: ['sighash_all', 'sighash_none', 'sighash_single', 'sighash_acp'] },
].map(group => ({ label: group.label, filters: group.filters.map(filter => TransactionFilters[filter] || null).filter(f => f != null) }));

// FreeBank: toggle groups whose filters rule each other out only when all must match ('and').
// A tx is one credit family at most: 'Bill and Note' matches nothing, while 'Bill or Note' (any)
// and 'neither Bill nor Note' (none) are useful. The other group left in the menu, RBF
// enabled/disabled (one of the two on every tx), always toggles, as upstream: together they match
// every tx or none, whatever the mode.
const AND_ONLY_TOGGLES = ['credit_family'];

/**
 * FreeBank: the active filters after `key` is picked (the block filters' toggle rule, here so it
 * can be tested): the other filters of its toggle group are dropped, a credit family's only in
 * 'and' mode.
 */
export function pickFilter(active: string[], key: string, mode: FilterMode): string[] {
  const toggle = TransactionFilters[key]?.toggle;
  const exclusive = !!toggle && (mode === 'and' || !AND_ONLY_TOGGLES.includes(toggle));
  return [...active.filter(f => f !== key && !(exclusive && TransactionFilters[f]?.toggle === toggle)), key];
}

/** FreeBank: the active filters kept on a switch to `mode`: in 'and', the latest pick of each and-only toggle group. */
export function filtersForMode(active: string[], mode: FilterMode): string[] {
  if (mode !== 'and') {
    return active;
  }
  return active.filter((f, i) => {
    const toggle = TransactionFilters[f]?.toggle;
    return !toggle || !AND_ONLY_TOGGLES.includes(toggle) || !active.slice(i + 1).some(g => TransactionFilters[g]?.toggle === toggle);
  });
}
