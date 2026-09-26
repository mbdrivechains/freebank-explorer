import {
  PegBlockView, PegBundle, PegBundleRecord, PegDeposit, PegEcashPaymentRecord, PegNodeWithdrawal, PegRefund, PegTxOutputView,
  PegTxView, PegWithdrawal, PegWithdrawalStatus,
} from '@interfaces/freebank-peg.interface';
import { ecashExplorerUrl, shortTxid } from '@app/freebank/bmm-view';
import { isRefundRequest } from '@app/freebank/freebank-tx-flags';
import { formatSatsAsEcx, formatUnits, SATS_PER_ECX } from '@app/freebank/credit-units';

// Display helpers for FreeBank's peg with eCash: the output labels of coinbases and peg txs, the
// notes under peg outputs, the tx page's withdrawal panel, the block page's rows and the /peg
// page. Pure TypeScript (no Angular, no Node APIs), tested by tests/peg-view-test.ts.
//
// Words (operator, 2026-09-25): "Deposit from eCash", "Withdrawal to eCash", "Withdrawal bundle",
// "Withdrawal refund"; never "deposit" alone, which means the v14 term deposits in FreeBank. A
// bundle marked paid without a matching eCash payment reads "marked paid by the block producer;
// eCash transaction not found", never a link. Links to the eCash explorer are built from the
// explorer_url our API sends; the browser never fetches from that host.

/** Below this, amounts are shown in szats: 0.01 ECX. */
const SZATS_BELOW = SATS_PER_ECX / 100;
export const DEPOSIT_FEE_SZATS = 1000; // freebank sidechain.h SIDECHAIN_DEPOSIT_FEE
const MAX_BLOCK_LINES = 10;

/** 1 -> '1 szat', 3000 -> '3,000 szats' */
export function formatSzats(sats: number): string {
  return typeof sats === 'number' && isFinite(sats) ? formatUnits(sats) + (sats === 1 ? ' szat' : ' szats') : '';
}

/** An amount: szats below 0.01 ECX, ECX from there. 3000 -> '3,000 szats', 8999999000 -> '89.99999 ECX'. */
export function formatPegAmount(sats: number): string {
  if (typeof sats !== 'number' || !isFinite(sats)) {
    return '';
  }
  return Math.abs(sats) < SZATS_BELOW ? formatSzats(sats) : formatSatsAsEcx(sats) + ' ECX';
}

/** 'XDPTdcwk…aZK5' for long strings (addresses as typed may be anything, so it is cut). */
export function shortText(text: string, head = 8, tail = 4): string {
  const s = String(text ?? '');
  return s.length > head + tail + 3 ? s.slice(0, head) + '…' + s.slice(-tail) : s;
}

// ------------------------------------------------------------------------------ lines of parts

/** A piece of text, a link into this explorer (route) or a link to the eCash explorer (href). */
export interface PegPart {
  text: string;
  sep?: boolean;                  // a ' · ' goes before it
  href?: string | null;           // external: opens in a new tab
  route?: string | null;          // internal path, e.g. '/block/<hash>' (the page adds the network prefix)
  fragment?: string | null;
  title?: string | null;
}

export interface PegLine {
  parts: PegPart[];
  tone?: 'muted' | 'warn' | null;
}

/** A labelled row of lines (tx page panel, block page). */
export interface PegRow {
  label: string;
  help?: string;
  lines: PegLine[];
}

type Segment = string | PegPart | (string | PegPart)[] | null | undefined | false;

/** A line of segments shown with ' · ' between them; empty segments are left out. */
export function pegLine(tone: PegLine['tone'], ...segments: Segment[]): PegLine {
  const parts: PegPart[] = [];
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    const pieces = (Array.isArray(segment) ? segment : [segment]).map((p) => typeof p === 'string' ? { text: p } : { ...p });
    if (!pieces.length) {
      continue;
    }
    pieces[0].sep = parts.length > 0;
    parts.push(...pieces);
  }
  return { parts, tone: tone ?? null };
}

/** A link to the eCash explorer ('↗' marks it), or plain text when there is no explorer URL. */
function ext(text: string, base: string, path: 'block' | 'tx' | 'address', id: string, fragment?: string, title?: string): PegPart {
  const href = ecashExplorerUrl(base, path, id, fragment);
  return href ? { text: text + ' ↗', href, title: title ?? id } : { text, title: title ?? id };
}

function blockLink(text: string, hash: string): PegPart {
  return { text, route: '/block/' + hash, title: hash };
}

function txLink(text: string, txid: string, vout?: number): PegPart {
  return { text, route: '/tx/' + txid, fragment: typeof vout === 'number' ? 'vout=' + vout : null, title: txid };
}

function addressLink(address: string): PegPart {
  return { text: shortText(address, 10, 6), route: '/address/' + address, title: address };
}

// ------------------------------------------------------------------------------ coinbase labels

/** A deposit record's destination and amount (sidechain.h SidechainDeposit's first fields), or null. */
export function readDepositHead(script: string): { dest: string, amount: number } | null {
  if (typeof script !== 'string' || !/^6aacdcf66f44[0-9a-f]{2}/.test(script)) {
    return null;
  }
  let pos = 14; // OP_RETURN, the tag, 'D', the slot
  const byte = (): number => {
    const b = parseInt(script.slice(pos, pos + 2), 16);
    if (!(b >= 0) || pos + 2 > script.length) {
      throw new Error('short');
    }
    pos += 2;
    return b;
  };
  try {
    let len = byte();
    if (len === 0xfd) {
      len = byte() | (byte() << 8);
    } else if (len >= 0xfe) {
      return null; // no address is that long
    }
    let dest = '';
    for (let i = 0; i < len; i++) {
      dest += String.fromCharCode(byte());
    }
    let lo = 0;
    for (let i = 0; i < 4; i++) {
      lo += byte() * 2 ** (8 * i);
    }
    let hi = 0;
    for (let i = 0; i < 4; i++) {
      hi += byte() * 2 ** (8 * i);
    }
    if (hi >= 0x80000000) {
      hi -= 0x100000000;
    }
    return { dest, amount: hi * 0x100000000 + lo };
  } catch {
    return null;
  }
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
 * whitespace at both ends; whitespace left inside is no address. The same rule as the backend's
 * coinbase-split.ts and freebank-tx-flags.ts.
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

/** A deposit record that is a bundle's eCash payment: 'D' with nothing to pay (backend peg-parser.ts isBundlePayment). */
function isBundlePayment(head: { dest: string, amount: number }): boolean {
  return head.dest === 'D' && head.amount <= 0;
}

/** An output whose details come from /peg/tx (records, bundles, commitments, withdrawals, refund requests). */
export function isPegOutputScript(script: string): boolean {
  return typeof script === 'string' && (/^6a(acdcf66f(44|50|57)|fb5345de|fa86c689|ef5d1dfe)/.test(script) || isRefundRequest(script));
}

export interface PegOutputLabel {
  label: string;
  tooltip?: string;
  peg?: boolean; // the output's details come from /peg/tx
}

interface LabelledTx {
  vin?: { is_coinbase?: boolean }[];
  vout?: { value: number, scriptpubkey: string, scriptpubkey_address?: string }[];
}

type CoinbaseOutputs = NonNullable<LabelledTx['vout']>;

/**
 * A coinbase's deposit records, each with the output that pays it (-1: none), paired the way
 * consensus claims them (sidechain.cpp ClaimDepositPayoutOutput): amount less 1,000 szats to the
 * record's destination, each output once; never vout[0], the producer's. The builder puts the
 * payout right before its record, so that one is taken first. Bundle payments are left out.
 */
function claimDepositPayouts(vout: CoinbaseOutputs): { records: { vout: number, head: { dest: string, amount: number }, payout: number }[], claimed: Set<number> } {
  const claimed = new Set<number>([0]);
  const records: { vout: number, head: { dest: string, amount: number }, payout: number }[] = [];
  vout.forEach((o, i) => {
    const head = readDepositHead(o?.scriptpubkey);
    if (!head || isBundlePayment(head)) {
      return;
    }
    let payout = -1;
    if (head.dest !== 'D' && head.amount > DEPOSIT_FEE_SZATS) { // 'D' is never paid (sidechain.cpp)
      const want = head.amount - DEPOSIT_FEE_SZATS;
      const matches = (j: number): boolean => !claimed.has(j) && vout[j]?.value === want && sameAddress(vout[j]?.scriptpubkey_address, head.dest);
      payout = i - 1 >= 1 && matches(i - 1) ? i - 1 : -1;
      for (let j = 1; payout < 0 && j < vout.length; j++) {
        if (matches(j)) {
          payout = j;
        }
      }
    }
    if (payout >= 0) {
      claimed.add(payout);
    }
    records.push({ vout: i, head, payout });
  });
  return { records, claimed };
}

/**
 * A coinbase's positive outputs after vout[0] that pay no deposit (OP_RETURNs aside): each is a
 * withdrawal refund or more for the block producer, which only the block's refund requests can
 * tell, so the page asks /peg/tx (coinbasePayoutLines). Empty for any other tx.
 */
export function coinbaseOtherPayouts(tx: LabelledTx): number[] {
  const vout = tx?.vout || [];
  if (!tx?.vin?.[0]?.is_coinbase) {
    return [];
  }
  const { claimed } = claimDepositPayouts(vout);
  const other: number[] = [];
  vout.forEach((o, i) => {
    if (!claimed.has(i) && o?.value > 0 && !String(o?.scriptpubkey || '').startsWith('6a')) {
      other.push(i);
    }
  });
  return other;
}

/**
 * Labels that need the whole coinbase: the producer's output, deposit payouts and their records
 * (claimDepositPayouts), and bundle payment records. The other positive outputs are a withdrawal
 * refund or more for the producer, which the coinbase alone cannot tell: they are labelled
 * 'Coinbase payout', and the note under them (coinbasePayoutLines) says which. Also marks every
 * peg output (peg: true). Changes `labels` in place.
 */
export function applyPegLabels(tx: LabelledTx, labels: (PegOutputLabel | undefined)[]): void {
  const vout = tx?.vout || [];
  vout.forEach((o, i) => {
    if (labels[i] && isPegOutputScript(o?.scriptpubkey)) {
      labels[i] = { ...labels[i], peg: true };
    }
  });
  if (!tx?.vin?.[0]?.is_coinbase || !vout.length) {
    return;
  }
  vout.forEach((o, i) => {
    const head = readDepositHead(o?.scriptpubkey);
    if (head && isBundlePayment(head)) {
      labels[i] = { label: 'Withdrawal bundle paid on eCash (record)', tooltip: 'Records the eCash transaction that paid a withdrawal bundle', peg: true };
    }
  });
  for (const { vout: i, head, payout } of claimDepositPayouts(vout).records) {
    if (payout >= 0) {
      labels[payout] = { label: 'Deposit from eCash (payout)', tooltip: `Pays out the deposit from eCash recorded in output ${i}, less the 1,000-szat fee that goes to the block producer` };
      labels[i] = { label: 'Deposit from eCash (record)', tooltip: `Records a deposit from eCash: its eCash transaction and amount. Paid out in output ${payout}.`, peg: true };
    } else {
      labels[i] = {
        label: 'Deposit from eCash (record)',
        tooltip: head.dest !== 'D' && head.amount <= DEPOSIT_FEE_SZATS
          ? 'Records a deposit from eCash that is not paid out: it is no more than the 1,000-szat fee'
          : 'Records a deposit from eCash that is not paid out: its destination is not a FreeBank address, so the coins stay in the eCash treasury',
        peg: true,
      };
    }
  }
  if (!labels[0]) {
    labels[0] = { label: 'Block producer', tooltip: 'What the block producer earns: the transaction fees, plus 1,000 szats for each deposit from eCash paid out. FreeBank has no block subsidy.' };
  }
  for (const i of coinbaseOtherPayouts(tx)) {
    if (!labels[i]) {
      labels[i] = {
        label: 'Coinbase payout',
        tooltip: 'Paid by this block besides the block producer\'s first output: a withdrawal refund, or more for the block producer. The note under it says which.',
      };
    }
  }
}

// ------------------------------------------------------------------------------ status words

export function bundleStatusParts(bundle: PegBundle, base: string): { parts: (string | PegPart)[], warn: boolean } {
  switch (bundle.status) {
    case 'paid':
      return { parts: ['paid on eCash in ', ext('tx ' + shortTxid(bundle.ecash_payment.ecash_txid), base, 'tx', bundle.ecash_payment.ecash_txid)], warn: false };
    case 'marked-paid':
      return { parts: ['marked paid by the block producer; eCash transaction not found'], warn: true };
    case 'failed':
      return { parts: ['failed on eCash; its withdrawals are back in the queue'], warn: false };
    default:
      return { parts: ['waiting for approval on eCash'], warn: false };
  }
}

/** A withdrawal's status, capitalized, as one line. `bundle`: the bundle it is in, when known. */
export function withdrawalStatusLine(w: PegWithdrawal | undefined | null, bundle: PegBundle | undefined | null, confirmed: boolean, base: string): PegLine {
  if (!w) {
    return pegLine('muted', confirmed ? 'Status not known yet: the explorer is still reading the chain' : 'Not in a block yet');
  }
  const status: PegWithdrawalStatus = w.status;
  switch (status) {
    case 'in-bundle':
      return pegLine(null, [
        'In bundle ',
        bundle ? blockLink(shortTxid(w.bundle_hash), bundle.freebank_block) : { text: shortTxid(w.bundle_hash), title: w.bundle_hash },
        bundle ? `, FreeBank block ${bundle.freebank_height}` : '',
        '; waiting for approval on eCash',
      ]);
    case 'paid':
      return pegLine(null, [
        'Paid on eCash in ',
        ext('tx ' + shortTxid(w.ecash_payment.ecash_txid), base, 'tx', w.ecash_payment.ecash_txid,
          typeof w.ecash_payment.ecash_vout === 'number' ? 'vout=' + w.ecash_payment.ecash_vout : undefined),
        typeof w.ecash_payment.ecash_vout === 'number' ? ` output ${w.ecash_payment.ecash_vout}` : '',
      ]);
    case 'marked-paid':
      return pegLine('warn', 'Marked paid by the block producer; eCash transaction not found');
    case 'refunded':
      return pegLine(null, ['Refunded in FreeBank block ', w.refund ? blockLink(String(w.refund.freebank_height), w.refund.freebank_block) : '?']);
    case 'requeued':
      return pegLine(null, 'Bundle failed on eCash; back in the queue');
    default:
      return pegLine(null, 'Waiting for a bundle');
  }
}

export const WITHDRAWAL_STATUS_TEXT: Record<PegWithdrawalStatus, string> = {
  'waiting': 'Waiting for a bundle',
  'requeued': 'Back in the queue',
  'in-bundle': 'Waiting for approval on eCash',
  'paid': 'Paid on eCash',
  'marked-paid': 'Marked paid by the block producer; eCash transaction not found',
  'refunded': 'Refunded',
};

// ------------------------------------------------------------------------------ one line each

export function depositLine(d: PegDeposit, base: string, withLabel = true): PegLine {
  const paid = d.payout_vout !== null;
  return pegLine(paid ? null : 'warn',
    withLabel && 'Deposit from eCash',
    [paid ? formatPegAmount(d.paid) : formatPegAmount(d.amount), ' to ', paid ? addressLink(d.dest) : { text: shortText(d.dest, 20, 6), title: d.dest }],
    !paid && (d.unpaid_reason === 'at-or-below-fee'
      ? 'not paid: at or below the 1,000-szat fee'
      : 'not paid: not a FreeBank address; the coins stay in the eCash treasury'),
    ext('eCash tx ' + shortTxid(d.ecash_txid), base, 'tx', d.ecash_txid),
    ext('eCash block', base, 'block', d.ecash_block),
  );
}

/** An M6 record. `bundle`: the bundle it paid, when at hand (else only its hash is shown). */
export function paymentLine(p: PegEcashPaymentRecord, bundle: PegBundle | undefined | null, base: string): PegLine {
  if (!p.bundle_hash) {
    return pegLine('warn', 'An eCash payment of a withdrawal bundle', ext('tx ' + shortTxid(p.ecash_txid), base, 'tx', p.ecash_txid), 'no matching bundle found');
  }
  return pegLine(null,
    'Withdrawal bundle paid on eCash',
    ext('tx ' + shortTxid(p.ecash_txid), base, 'tx', p.ecash_txid),
    bundle
      ? ['bundle ', blockLink(shortTxid(bundle.bundle_hash), bundle.freebank_block), ` (FreeBank block ${bundle.freebank_height})`]
      : [{ text: 'bundle ' + shortTxid(p.bundle_hash), title: p.bundle_hash }],
  );
}

function withdrawalCount(n: number): string {
  return `${formatUnits(n)} ${n === 1 ? 'withdrawal' : 'withdrawals'}`;
}

export function bundleLine(bundle: PegBundle, base: string, withLabel = true): PegLine {
  const status = bundleStatusParts(bundle, base);
  return pegLine(status.warn ? 'warn' : null,
    withLabel && 'Withdrawal bundle created',
    withdrawalCount(bundle.withdrawal_ids.length),
    formatPegAmount(bundle.total),
    typeof bundle.ecash_fee === 'number' && 'eCash fee ' + formatSzats(bundle.ecash_fee),
    status.parts,
  );
}

function bundleRef(hash: string, bundle: PegBundle | undefined | null): PegPart[] {
  return bundle ? [{ text: 'Withdrawal bundle ' }, blockLink(shortTxid(hash), bundle.freebank_block)] : [{ text: 'Withdrawal bundle ' + shortTxid(hash), title: hash }];
}

/**
 * A 'paid' commitment: the bundle, and its eCash payment when a payment record matches it; else
 * only the block producer's word, never a link (freebankd can mark a bundle paid from an old
 * event). `known`: the explorer has read the chain up to this commitment, so a missing payment
 * is really missing.
 */
function bundlePaidLine(hash: string, bundle: PegBundle | undefined | null, base: string, known: boolean): PegLine {
  const created = bundle && `created in FreeBank block ${bundle.freebank_height}`;
  if (bundle?.ecash_payment) {
    return pegLine(null,
      [...bundleRef(hash, bundle), ' paid on eCash in ', ext('tx ' + shortTxid(bundle.ecash_payment.ecash_txid), base, 'tx', bundle.ecash_payment.ecash_txid)],
      created);
  }
  return known
    ? pegLine('warn', [...bundleRef(hash, bundle), ' marked paid by the block producer; eCash transaction not found'], created)
    : pegLine('muted', [...bundleRef(hash, bundle), ' marked paid by the block producer'], created);
}

/** The lines under one peg output of a tx (the tx page's output list, and the coinbase's). */
export function pegOutputLines(view: PegTxView | null, vout: number): PegLine[] {
  const found = view?.outputs?.find((o) => o.output.vout === vout);
  if (!view || !found) {
    return [];
  }
  const base = view.explorer_url;
  const out = found.output;
  switch (out.kind) {
    case 'deposit':
      if (found.deposit) {
        return [depositLine(found.deposit, base)];
      }
      if (found.payment) {
        return [paymentLine(found.payment, found.bundle, base)];
      }
      return [pegLine(null, out.bundle_payment ? 'eCash payment of a withdrawal bundle' : 'Deposit from eCash', ext('eCash tx ' + shortTxid(out.ecash_txid), base, 'tx', out.ecash_txid))];
    case 'bundle':
      return found.bundle ? [bundleLine(found.bundle, base)] : [bundleRecordLine(out)];
    case 'bundle-paid':
      return [bundlePaidLine(out.bundle_hash, found.bundle, base, view.indexed)];
    case 'bundle-failed':
      return [pegLine(null,
        [...bundleRef(out.bundle_hash, found.bundle), ' failed on eCash'],
        found.bundle && `created in FreeBank block ${found.bundle.freebank_height}`,
        'its withdrawals are back in the queue',
      )];
    case 'bundle-hash': {
      const status = found.bundle ? bundleStatusParts(found.bundle, base) : null;
      return [pegLine(status?.warn ? 'warn' : null,
        ['Current ', ...bundleRef(out.bundle_hash, found.bundle).map((p, i) => i === 0 ? { ...p, text: p.text.toLowerCase() } : p)],
        found.bundle && `created in FreeBank block ${found.bundle.freebank_height}`,
        status?.parts,
      )];
    }
    case 'withdrawal':
      return [pegLine(null,
        'Withdrawal to eCash',
        [formatPegAmount(out.payout), ...ecashAddressParts(found.node, base)],
        'eCash fee ' + formatSzats(out.ecash_fee),
      ), withdrawalStatusLine(found.withdrawal, found.bundle, view.confirmed, base)];
    case 'refund-request':
      return [refundRequestLine(found, view, base)];
    case 'stray':
      return []; // its label already says it (shared/transaction.utils.ts: 'Not a real deposit from eCash (outside the coinbase)')
    case 'unreadable':
      return [pegLine('warn', 'This FreeBank peg output could not be read')];
    default:
      return [];
  }
}

/** 'indexing: block N of M' while the explorer's peg index is behind the node, else null. */
export function indexingText(at: { tip_height?: number, behind_by?: number } | null | undefined): string | null {
  const behind = at?.behind_by ?? 0;
  if (!(behind > 0)) {
    return null;
  }
  const top = at.tip_height ?? 0; // -1 before the first block
  return `indexing: block ${formatUnits(Math.max(0, top))} of ${formatUnits(top + behind)}`;
}

/**
 * The note under a coinbase output that pays neither the producer's first output nor a deposit
 * (coinbaseOtherPayouts): a withdrawal refund when the block's refund requests claim it
 * (view.refund_payouts), else more for the block producer; unknown until the index has read the
 * block. `view`: /peg/tx of the coinbase.
 */
export function coinbasePayoutLines(view: PegTxView | null, vout: number): PegLine[] {
  if (!view?.coinbase) {
    return [];
  }
  const refund = (view.refund_payouts || []).find((r) => r.vout === vout);
  if (refund) {
    return [pegLine(null,
      'Withdrawal refund',
      ['for ', { text: 'withdrawal ' + shortTxid(refund.withdrawal_id), title: refund.withdrawal_id }],
      refund.request_txid ? txLink('request ' + shortTxid(refund.request_txid), refund.request_txid, refund.request_vout) : null,
    )];
  }
  const deposit = (view.deposit_payouts || []).find((d) => d.vout === vout);
  if (deposit) {
    return [pegLine(null, 'Deposit from eCash (payout)', `recorded in output ${deposit.record_vout}`)];
  }
  if (!view.indexed) {
    return [pegLine('muted', 'Withdrawal refund or block producer: not known yet', indexingText(view) || 'the explorer is still reading the chain')];
  }
  return [pegLine(null, 'Block producer', 'not a withdrawal refund')];
}

function bundleRecordLine(out: PegBundleRecord): PegLine {
  return pegLine(null, 'Withdrawal bundle created', withdrawalCount(out.withdrawal_ids.length), formatPegAmount(out.total));
}

function ecashAddressParts(node: PegNodeWithdrawal | null | undefined, base: string): (string | PegPart)[] {
  return node?.destination ? [' to ', ext(shortText(node.destination, 12, 6), base, 'address', node.destination)] : [];
}

function refundRequestLine(found: PegTxOutputView, view: PegTxView, base: string): PegLine {
  const w = found.withdrawal;
  const refund = found.refund;
  const id = found.output.kind === 'refund-request' ? found.output.withdrawal_id : '';
  return pegLine(null,
    'Withdrawal refund request',
    ['for ', w ? txLink('withdrawal ' + shortTxid(id), w.txid, w.vout) : { text: 'withdrawal ' + shortTxid(id), title: id }],
    w && [formatPegAmount(w.amount), ' back to ', addressLink(w.refund_dest)],
    refund
      ? ['refunded in FreeBank block ', blockLink(String(refund.freebank_height), refund.freebank_block)]
      : (view.confirmed ? '' : 'not in a block yet'),
  );
}

// ------------------------------------------------------------------------------ the tx page

/** The node's getwithdrawal status (sidechain.cpp GetStatusStr), in the page's words. */
const NODE_WITHDRAWAL_STATUS: Record<string, string> = {
  'Unspent': 'not paid or refunded yet',
  'Pending - in WithdrawalBundle': 'in a withdrawal bundle',
  'Spent': 'paid or refunded',
};

/**
 * While the explorer's peg index is behind the node, the status above may be old: a muted line
 * saying so, with the node's own status when it has one.
 */
function indexingLines(view: PegTxView, node: PegNodeWithdrawal | null | undefined): PegLine[] {
  const indexing = indexingText(view);
  if (!indexing) {
    return [];
  }
  const nodeStatus = node?.status ? NODE_WITHDRAWAL_STATUS[node.status] : undefined;
  return [pegLine('muted', indexing, nodeStatus && `the node says: ${nodeStatus}`)];
}

export interface PegPanel {
  title: string;                  // 'Withdrawal to eCash' or 'Withdrawal refund request'
  rows: PegRow[];
}

/**
 * The tx page's panels: one per withdrawal, and one per refund request, in output order (a block
 * producer may make either in its coinbase too).
 */
export function pegTxPanels(view: PegTxView | null): PegPanel[] {
  if (!view) {
    return [];
  }
  const base = view.explorer_url;
  const panels: PegPanel[] = [];
  for (const found of view.outputs) {
    const out = found.output;
    if (out.kind === 'withdrawal') {
      const rows: PegRow[] = [
        { label: 'eCash payout', help: 'What the eCash address receives when the withdrawal is paid: the amount burned here, less the eCash fee', lines: [pegLine(null, formatPegAmount(out.payout))] },
        {
          label: 'eCash address',
          lines: [found.node?.destination
            ? pegLine(null, ext(found.node.destination, base, 'address', found.node.destination))
            : pegLine('muted', 'shown once the withdrawal is in a block')],
        },
        { label: 'eCash fee', help: 'Paid to eCash miners when the withdrawal bundle is paid', lines: [pegLine(null, formatSzats(out.ecash_fee))] },
        { label: 'Refund address', help: 'Where the whole amount goes back if the withdrawal is refunded', lines: [pegLine(null, addressLink(out.refund_dest))] },
        { label: 'Status', lines: [withdrawalStatusLine(found.withdrawal, found.bundle, view.confirmed, base), ...indexingLines(view, found.node)] },
        { label: 'Withdrawal id', lines: [pegLine(null, { text: shortTxid(out.id), title: out.id })] },
      ];
      panels.push({ title: 'Withdrawal to eCash', rows });
    } else if (out.kind === 'refund-request') {
      const w = found.withdrawal;
      const rows: PegRow[] = [
        { label: 'Withdrawal', lines: [pegLine(null, w ? txLink(shortTxid(out.withdrawal_id), w.txid, w.vout) : { text: shortTxid(out.withdrawal_id), title: out.withdrawal_id })] },
      ];
      if (w) {
        rows.push({ label: 'Amount', help: 'The whole withdrawal, eCash fee included', lines: [pegLine(null, formatPegAmount(w.amount))] });
        rows.push({ label: 'Refund address', lines: [pegLine(null, addressLink(w.refund_dest))] });
      }
      rows.push({
        label: 'Status',
        lines: [found.refund
          ? pegLine(null, ['Refunded in FreeBank block ', blockLink(String(found.refund.freebank_height), found.refund.freebank_block)],
            typeof found.refund.payout_vout === 'number' && found.refund.coinbase_txid ? txLink(`coinbase output ${found.refund.payout_vout}`, found.refund.coinbase_txid, found.refund.payout_vout) : null)
          : pegLine('muted', view.confirmed ? 'Status not known yet' : 'Not in a block yet'), ...indexingLines(view, found.node)],
      });
      panels.push({ title: 'Withdrawal refund request', rows });
    }
  }
  return panels;
}

// ------------------------------------------------------------------------------ the block page

export interface BlockPegExtras {
  reward?: number;
  totalFees?: number;
  pegInCount?: number;
  pegInAmt?: number;
  pegInUnpaidCount?: number;
  refundCount?: number;
  refundAmt?: number;
  pegRecords?: number;
}

/** Whether the block page should ask for the block's peg events. */
export function blockHasPegEvents(extras: BlockPegExtras | undefined): boolean {
  return !!extras && ((extras.pegRecords ?? 0) > 0 || (extras.refundCount ?? 0) > 0);
}

function more(lines: PegLine[], total: number): PegLine[] {
  if (total > lines.length) {
    lines.push(pegLine('muted', `and ${formatUnits(total - lines.length)} more, in the coinbase`));
  }
  return lines;
}

/**
 * The block page's rows under Total fees: what the producer earned (only when it differs from
 * the fees), the deposits from eCash, the withdrawal refunds and the bundle events. The counts
 * come from the block (extras); the per-item lines from /peg/block/:hash when it has loaded.
 */
export function blockPegRows(extras: BlockPegExtras | undefined, view: PegBlockView | null): PegRow[] {
  const rows: PegRow[] = [];
  if (!extras) {
    return rows;
  }
  const base = view?.explorer_url || '';
  if (typeof extras.reward === 'number' && typeof extras.totalFees === 'number' && extras.reward !== extras.totalFees) {
    rows.push({
      label: 'Producer earned',
      help: 'Transaction fees + 1,000 szats per deposit from eCash paid out; FreeBank has no block subsidy',
      lines: [pegLine(null, formatPegAmount(extras.reward))],
    });
  }
  const paid = extras.pegInCount ?? 0;
  const unpaid = extras.pegInUnpaidCount ?? 0;
  if (paid + unpaid > 0) {
    const lines = [pegLine(null, `${formatUnits(paid)} · ${formatPegAmount(extras.pegInAmt ?? 0)}`, unpaid > 0 && `${formatUnits(unpaid)} recorded, not paid`)];
    const deposits = view?.deposits || [];
    lines.push(...more(deposits.slice(0, MAX_BLOCK_LINES).map((d) => depositLine(d, base, false)), deposits.length));
    rows.push({
      label: 'Deposits from eCash',
      help: 'Deposits made on eCash, credited in this block. Each depositor receives the deposit less 1,000 szats, which go to the block producer.',
      lines,
    });
  }
  const refunds = extras.refundCount ?? 0;
  if (refunds > 0) {
    const lines = [pegLine(null, `${formatUnits(refunds)} · ${formatPegAmount(extras.refundAmt ?? 0)}`)];
    const list = view?.refunds || [];
    lines.push(...more(list.slice(0, MAX_BLOCK_LINES).map((r) => refundLine(r)), list.length));
    rows.push({
      label: 'Withdrawal refunds',
      help: 'Withdrawals to eCash given back on FreeBank: the whole amount, eCash fee included',
      lines,
    });
  }
  const bundleLines: PegLine[] = [];
  for (const b of view?.bundles_created || []) {
    bundleLines.push(bundleLine(b, base));
  }
  for (const b of view?.bundles_paid || []) {
    bundleLines.push(bundlePaidLine(b.bundle_hash, b, base, true));
  }
  for (const b of view?.bundles_failed || []) {
    bundleLines.push(pegLine(null, [...bundleRef(b.bundle_hash, b), ' failed on eCash'], 'its withdrawals are back in the queue'));
  }
  // an eCash payment whose bundle is marked paid in this same block is on that bundle's line
  const paidHere = new Set((view?.bundles_paid || []).map((b) => b.bundle_hash));
  for (const p of view?.ecash_payments || []) {
    if (!p.bundle_hash || !paidHere.has(p.bundle_hash)) {
      bundleLines.push(paymentLine(p, null, base));
    }
  }
  if (bundleLines.length) {
    rows.push({ label: 'Withdrawal bundle', lines: bundleLines });
  }
  return rows;
}

function refundLine(r: PegRefund): PegLine {
  return pegLine(null,
    r.amount !== null ? [formatPegAmount(r.amount), ...(r.refund_dest ? [' to ', addressLink(r.refund_dest)] : [])] : null,
    txLink('request ' + shortTxid(r.request_txid), r.request_txid, r.request_vout),
  );
}

// ------------------------------------------------------------------------------ the /peg page

export interface PegTableRow {
  key: string;
  time: number;                   // FreeBank block time, for the age column
  cells: PegLine[];
}

/** Deposits from eCash: FreeBank block, amount, to, eCash tx. */
export function depositTableRow(d: PegDeposit, base: string): PegTableRow {
  const paid = d.payout_vout !== null;
  return {
    key: d.coinbase_txid + ':' + d.record_vout,
    time: d.freebank_time,
    cells: [
      pegLine(null, blockLink(String(d.freebank_height), d.freebank_block)),
      paid ? pegLine(null, formatPegAmount(d.paid)) : pegLine('warn', formatPegAmount(d.amount) + ', not paid'),
      pegLine(paid ? null : 'muted', paid ? addressLink(d.dest) : { text: shortText(d.dest, 12, 4), title: d.dest }),
      pegLine(null, ext(shortTxid(d.ecash_txid), base, 'tx', d.ecash_txid)),
    ],
  };
}

/** A withdrawal's status in a few words, with the link that proves it. */
export function withdrawalStatusShort(w: PegWithdrawal, base: string): PegLine {
  switch (w.status) {
    case 'paid':
      return pegLine(null, ext(WITHDRAWAL_STATUS_TEXT.paid, base, 'tx', w.ecash_payment.ecash_txid,
        typeof w.ecash_payment.ecash_vout === 'number' ? 'vout=' + w.ecash_payment.ecash_vout : undefined, w.ecash_payment.ecash_txid));
    case 'refunded':
      return pegLine(null, w.refund ? blockLink(WITHDRAWAL_STATUS_TEXT.refunded, w.refund.freebank_block) : WITHDRAWAL_STATUS_TEXT.refunded);
    case 'marked-paid':
      return pegLine('warn', WITHDRAWAL_STATUS_TEXT['marked-paid']);
    default:
      return pegLine(null, WITHDRAWAL_STATUS_TEXT[w.status] ?? w.status);
  }
}

/** Withdrawals to eCash: FreeBank tx, paid on eCash, eCash fee, status. */
export function withdrawalTableRow(w: PegWithdrawal, base: string): PegTableRow {
  return {
    key: w.id,
    time: w.freebank_time,
    cells: [
      pegLine(null, txLink(shortTxid(w.txid), w.txid, w.vout)),
      pegLine(null, formatPegAmount(w.payout)),
      pegLine(null, formatSzats(w.ecash_fee)),
      withdrawalStatusShort(w, base),
    ],
  };
}

/** Withdrawal bundles: FreeBank block, withdrawals, amount, eCash fee, status. */
export function bundleTableRow(b: PegBundle, base: string): PegTableRow {
  const status = bundleStatusParts(b, base);
  const first = status.parts[0];
  const parts = status.parts.map((p, i) => i === 0 && typeof first === 'string' ? first.charAt(0).toUpperCase() + first.slice(1) : p);
  return {
    key: b.bundle_hash,
    time: b.freebank_time,
    cells: [
      pegLine(null, blockLink(String(b.freebank_height), b.freebank_block)),
      pegLine(null, formatUnits(b.withdrawal_ids.length)),
      pegLine(null, formatPegAmount(b.total)),
      pegLine(null, typeof b.ecash_fee === 'number' ? formatSzats(b.ecash_fee) : ''),
      pegLine(status.warn ? 'warn' : null, parts),
    ],
  };
}

/** The treasury tile: its value linked to the eCash output that holds it. */
export function treasuryLine(t: { ecash_txid: string, ecash_vout: number, value: number | null } | null, base: string): PegLine | null {
  if (!t || typeof t.value !== 'number') {
    return null;
  }
  return pegLine(null, ext(formatPegAmount(t.value), base, 'tx', t.ecash_txid, 'vout=' + t.ecash_vout, `${t.ecash_txid} output ${t.ecash_vout}`));
}
