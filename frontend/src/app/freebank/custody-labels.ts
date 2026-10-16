// FreeBank custody labels on transaction inputs and outputs: the coins the credit rules hold
// (house pledges, a house's till and escrow, bill escrow bonds, pool reserves, oracle bonds,
// demanded notes and term deposits held in custody), and the noteholders' mutual fund. Pure TypeScript, no Angular.
//
// A custody coin sits on `<push> OP_DROP OP_TRUE` (a 20-, 32- or 33-byte push), which anyone can
// spend at the script level; a tag the node puts on the coin locks it. Two tiers:
// - here, at once and from the page's own data: the family, from the push length and the tx
//   version. Only certain credit versions can create or spend a tagged coin of each shape
//   (freebank tx_verify.cpp:474-600), so any other tx's custody-shaped coin is an unlocked
//   look-alike, which is exact; for a credit tx the family is a best guess;
// - then, for credit txs, the exact coin from GET /api/v1/freebank/custody (the backend's
//   api/freebank/custody-tags.ts): which house, bill, pool or submitter, with a link.

export type FreebankCustodyKind =
  | 'house_pledge' | 'house_till' | 'house_spread' | 'house_claim_change' | 'house_bill_escrow' | 'bill_escrow'
  | 'pool_note_reserve' | 'pool_ecx_reserve' | 'oracle_bond' | 'note_custody' | 'deposit_custody'
  | 'mutual_fund' // v0.2.28: locked by consensus whatever made it, so labelled by its script alone
  | 'lookalike' // custody-shaped, but nothing locks it
  | 'custody'; // the family only (this file), until the exact label arrives

export interface FreebankCustodyLabel {
  kind: FreebankCustodyKind;
  text: string; // 'House 3 · pledge (partner 0)'
  tooltip: string;
  link?: string | null; // a page of this explorer: /house/3, /bill/12, /pool/2, /gold
  house_id?: number;
  partner_index?: number;
  bill_id?: number;
  pool_id?: number;
  submitter_id?: number;
  units?: number;
  protested?: boolean;
}

/** GET /api/v1/freebank/custody: one tx's labels by input and output index. */
export interface FreebankCustodyTx {
  vin: (FreebankCustodyLabel | null)[];
  vout: (FreebankCustodyLabel | null)[];
  truncated?: boolean; // only the first 50 inputs are looked up
}

export interface FreebankCustodyResponse {
  tip_height: number;
  txs: { [txid: string]: FreebankCustodyTx | null }; // null: the node does not know the txid
}

const CUSTODY_SCRIPT = /^(14[0-9a-f]{40}|20[0-9a-f]{64}|21[0-9a-f]{66})7551$/;

/** The push size of a custody-shaped script (20, 32 or 33 bytes), or null. */
export function custodyPushBytes(scriptpubkey: string | undefined): number | null {
  const m = CUSTODY_SCRIPT.exec(scriptpubkey || '');
  return m ? (m[1].length - 2) / 2 : null;
}

// The family of a tagged custody coin of each push size that a tx of each version can create or
// spend: the same versions both ways (freebank coins.cpp AddCoins; tx_verify.cpp spend guards).
//   32  bill escrow v11, and from v0.2.28 house escrow v11 (a failed house's bills repaid into it) ·
//       house escrow v12 (pledges, till; the close spends it), v13 (spread, claim change) and v14 (claim change) ·
//       pool reserves v15
//   33  oracle bond v17
//   20  demanded notes in custody v13 · demanded term deposits in custody v14 (v0.2.29)
const CUSTODY_FAMILIES: { [pushBytes: number]: { [version: number]: string } } = {
  32: { 11: 'Bill or house escrow', 12: 'House escrow', 13: 'House escrow', 14: 'House escrow', 15: 'Pool reserve' },
  33: { 17: 'Oracle bond' },
  20: { 13: 'Demanded notes (custody)', 14: 'Demanded term deposit (custody)' },
};

/** house.cpp MutualFundScript (v0.2.28): <"FreeBank mutual fund v1"> OP_DROP OP_TRUE. */
export const MUTUAL_FUND_SCRIPT = '17' + '4672656542616e6b206d757475616c2066756e64207631' + '7551';

export const MUTUAL_FUND_LABEL: FreebankCustodyLabel = {
  kind: 'mutual_fund',
  text: 'FreeBank mutual fund (locked)',
  tooltip: 'The noteholders\' mutual fund: what was left of a failed house\'s escrow when it closed, after its partners\' residual. Consensus refuses every spend of it for now.',
  link: null,
};

export const CUSTODY_TOOLTIP = 'Locked by the FreeBank credit rules, not by a key';

export const CUSTODY_LOOKALIKE: FreebankCustodyLabel = {
  kind: 'lookalike',
  text: 'Unlocked look-alike (anyone can spend)',
  tooltip: 'Shaped like a FreeBank custody output, but no credit rule locks it: anyone can spend it.',
  link: null,
};

/**
 * The label of a custody-shaped script in a tx of this version (an output's own script, or the
 * script of the coin an input spends), or undefined when it is not custody-shaped. A coinbase
 * tags nothing.
 */
export function custodyFamilyLabel(scriptpubkey: string | undefined, version: number, isCoinbase = false): FreebankCustodyLabel | undefined {
  if (scriptpubkey === MUTUAL_FUND_SCRIPT) {
    return MUTUAL_FUND_LABEL;
  }
  const pushBytes = custodyPushBytes(scriptpubkey);
  if (pushBytes === null) {
    return undefined;
  }
  const family = isCoinbase ? undefined : CUSTODY_FAMILIES[pushBytes]?.[version];
  return family ? { kind: 'custody', text: family, tooltip: CUSTODY_TOOLTIP, link: null } : CUSTODY_LOOKALIKE;
}

interface CustodyTxLike {
  version: number;
  vin: { is_coinbase?: boolean, prevout?: { scriptpubkey?: string } | null }[];
  vout: { scriptpubkey?: string }[];
}

/** The family labels of every input and output of a tx (undefined where there is none). */
export function getFreebankCustodyLabels(tx: CustodyTxLike): { vin: (FreebankCustodyLabel | undefined)[], vout: (FreebankCustodyLabel | undefined)[] } {
  const isCoinbase = !!tx?.vin?.[0]?.is_coinbase;
  return {
    vin: (tx?.vin || []).map((vin) => vin?.is_coinbase ? undefined : custodyFamilyLabel(vin?.prevout?.scriptpubkey, tx.version)),
    vout: (tx?.vout || []).map((vout) => custodyFamilyLabel(vout?.scriptpubkey, tx.version, isCoinbase)),
  };
}

/**
 * The labels to show: the exact one where the backend gave one, else the family label (the
 * backend gives none past its input cap, or for a coin it could not look up).
 */
export function mergeCustodyLabels(family: (FreebankCustodyLabel | undefined)[], exact: (FreebankCustodyLabel | null)[] | undefined): (FreebankCustodyLabel | undefined)[] {
  return family.map((label, i) => exact?.[i] || label);
}
