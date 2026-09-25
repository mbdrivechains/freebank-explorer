import { createHash } from 'crypto';
import { ByteReader, FreebankParsedTx, FreebankParseError, FreebankTxSpan, readFreebankTx } from './freebank-tx-parser';
import {
  PegBundlePayout, PegBundleRecord, PegDepositRecord, PegOutput, PegWithdrawalObject,
} from './peg.interfaces';

// FreeBank's peg outputs, decoded from their script hex. Sources (freebank, read only):
//   sidechain.h / sidechain.cpp  SidechainDeposit ('D'), SidechainWithdrawalBundle ('P'),
//                                SidechainWithdrawal ('W') and SidechainObj::GetScript:
//                                OP_RETURN, the RAW tag acdcf66f (not a push), then the object
//                                serialized as the node stores it (SER_DISK: a tx with its witness)
//   validation.cpp               Generate*Commit (37-byte commitments) and
//                                GenerateWithdrawalRefundRequest (102 bytes)
//   miner.cpp                    which of them a block producer writes into the coinbase
//
// Deposit records and bundles are written by block producers and count only in a coinbase.
// Consensus still accepts a deposit or bundle object in an ordinary tx (only the mempool refuses
// them since v0.2.14), so one found there is returned as 'stray', never as a deposit. Withdrawals
// and refund requests count in any tx, the coinbase included, as the node reads them from every
// tx of a block (validation.cpp ConnectBlock).
//
// Pure: no node calls, never throws. A tagged output whose contents do not decode is returned
// as 'unreadable'; an output that is not a peg output gives null.

export const SIDECHAIN_DEPOSIT_FEE = 1000; // sidechain.h: 0.00001 COIN, kept by the block producer
export const BUNDLE_RETURN_DEST = 'D'; // sidechain.h SIDECHAIN_WITHDRAWAL_BUNDLE_RETURN_DEST

const OBJECT_TAG = 'acdcf66f';
const COMMIT_TAGS: Readonly<Record<string, 'bundle-hash' | 'bundle-paid' | 'bundle-failed'>> = {
  'ef5d1dfe': 'bundle-hash',
  'fb5345de': 'bundle-paid',
  'fa86c689': 'bundle-failed',
};
const REFUND_TAG = 'fcd2e546';
const ZERO_HASH = '0'.repeat(64);
const WITHDRAWAL_UNSPENT = 0x75; // 'u'
const TWO_POW_32 = 0x100000000;

const OBJECT_NAMES: Readonly<Record<number, 'deposit' | 'bundle' | 'withdrawal'>> = {
  0x44: 'deposit', // 'D'
  0x50: 'bundle', // 'P'
  0x57: 'withdrawal', // 'W'
};

function sha256d(b: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

function reverseHex(b: Buffer): string {
  return Buffer.from(b).reverse().toString('hex');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** serialize.h WriteCompactSize */
function compactSize(n: number): Buffer {
  if (n < 0xfd) {
    return Buffer.from([n]);
  }
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}

/** A vector of CTxOut as the node serializes it. */
function serializeOutputs(vout: { value: number, scriptpubkey: string }[]): Buffer {
  const parts: Buffer[] = [compactSize(vout.length)];
  for (const out of vout) {
    const value = Buffer.alloc(8);
    const hi = Math.floor(out.value / TWO_POW_32);
    value.writeUInt32LE(out.value - hi * TWO_POW_32, 0);
    value.writeInt32LE(hi, 4);
    const script = Buffer.from(out.scriptpubkey, 'hex');
    parts.push(value, compactSize(script.length), script);
  }
  return Buffer.concat(parts);
}

/**
 * The txid an eCash node gives this transaction: sha256d of version, vin, vout and locktime.
 * FreeBank's own serialization adds a replay byte to version-3 txs and a trailer to versions
 * 10-17, which eCash txs do not have, so both are left out here (for a version 1 or 2 tx this
 * equals FreeBank's txid).
 */
export function mainchainTxid(buf: Buffer, span: FreebankTxSpan): string {
  return reverseHex(sha256d(Buffer.concat([
    buf.subarray(span.start, span.start + 4),
    buf.subarray(span.bodyStart, span.bodyEnd),
    buf.subarray(span.locktimeStart, span.locktimeStart + 4),
  ])));
}

/**
 * A bundle's m6id: the txid of the same tx with its (dummy) input removed, which is what the
 * enforcer computes for the blinded M6 (freebank l1client.cpp BlindedM6IdForBundle).
 */
function bundleM6id(buf: Buffer, span: FreebankTxSpan, tx: FreebankParsedTx): string {
  return reverseHex(sha256d(Buffer.concat([
    buf.subarray(span.start, span.headerEnd),
    compactSize(0),
    serializeOutputs(tx.vout),
    buf.subarray(span.locktimeStart, span.end),
  ])));
}

/** The leading fields of a deposit record, enough to pair it with its payout (coinbase-split.ts). */
export interface DepositHead {
  slot: number;
  dest: string;
  amount: number;
}

/**
 * Read a deposit record's slot, destination and amount without reading its eCash tx. Null for
 * a script that is not a deposit record or is cut short.
 */
export function readDepositHead(scriptHex: string): DepositHead | null {
  if (!scriptHex || !scriptHex.startsWith('6a' + OBJECT_TAG + '44')) {
    return null;
  }
  try {
    const r = new ByteReader(Buffer.from(scriptHex, 'hex'));
    r.skip(6); // OP_RETURN, the tag, 'D'
    const slot = r.u8();
    const dest = r.varString();
    const amount = r.i64();
    return { slot, dest, amount };
  } catch {
    return null;
  }
}

/** Decode one output's script. `inCoinbase`: the output belongs to a coinbase. */
export function parsePegOutput(scriptHex: string, vout: number, inCoinbase: boolean): PegOutput | null {
  if (typeof scriptHex !== 'string' || !scriptHex.startsWith('6a') || scriptHex.length < 10) {
    return null;
  }
  const tag = scriptHex.slice(2, 10).toLowerCase();

  if (COMMIT_TAGS[tag]) {
    if (!inCoinbase || scriptHex.length !== 74) {
      return null; // not a commitment the node would read (validation.cpp reads the coinbase only)
    }
    const bundle_hash = reverseHex(Buffer.from(scriptHex.slice(10), 'hex'));
    return bundle_hash === ZERO_HASH ? null : { kind: COMMIT_TAGS[tag], vout, bundle_hash };
  }

  if (tag === REFUND_TAG) {
    if (scriptHex.length !== 204) {
      return null; // script.cpp IsWithdrawalRefundRequest: exactly 102 bytes
    }
    const withdrawal_id = reverseHex(Buffer.from(scriptHex.slice(10, 74), 'hex'));
    return withdrawal_id === ZERO_HASH ? null : { kind: 'refund-request', vout, withdrawal_id };
  }

  if (tag !== OBJECT_TAG || scriptHex.length < 12) {
    return null;
  }
  const object = OBJECT_NAMES[parseInt(scriptHex.slice(10, 12), 16)];
  if (!object) {
    return null; // ParseSidechainObj: not an object
  }
  if (object !== 'withdrawal' && !inCoinbase) {
    return {
      kind: 'stray',
      vout,
      object,
      note: object === 'deposit' ? 'not a real deposit (outside the coinbase)' : 'not a real withdrawal bundle (outside the coinbase)',
    };
  }

  try {
    const buf = Buffer.from(scriptHex, 'hex');
    const r = new ByteReader(buf);
    r.skip(5); // OP_RETURN and the tag
    switch (object) {
      case 'deposit': return readDeposit(r, buf, vout);
      case 'bundle': return readBundle(r, buf, vout);
      default: return readWithdrawal(r, buf, vout);
    }
  } catch (e) {
    return { kind: 'unreadable', vout, tag: OBJECT_TAG, error: e instanceof FreebankParseError ? e.message : errMsg(e) };
  }
}

/** Decode every peg output of a transaction, in output order. */
export function parsePegOutputs(vout: { scriptpubkey?: string }[], inCoinbase: boolean): PegOutput[] {
  const out: PegOutput[] = [];
  (vout || []).forEach((output, i) => {
    const peg = parsePegOutput(output?.scriptpubkey || '', i, inCoinbase);
    if (peg) {
      out.push(peg);
    }
  });
  return out;
}

// The node reads the fields and ignores any bytes after them (ParseSidechainObj), so these do too.

function readDeposit(r: ByteReader, buf: Buffer, vout: number): PegDepositRecord {
  r.u8(); // 'D'
  const slot = r.u8();
  const dest = r.varString();
  const amount = r.i64();
  const { tx, span } = readFreebankTx(r, buf);
  const burn_index = r.u32();
  const ecash_tx_index = r.u32();
  const ecash_block = r.hash256();
  const bundle_payment = dest === BUNDLE_RETURN_DEST;
  const burn = tx.vout[burn_index];
  const record: PegDepositRecord = {
    kind: 'deposit',
    vout,
    slot,
    dest,
    amount,
    ecash_txid: mainchainTxid(buf, span),
    ecash_block,
    ecash_tx_index,
    burn_index,
    treasury_value: burn ? burn.value : null,
    bundle_payment,
  };
  if (bundle_payment) {
    record.ecash_outputs = tx.vout.map((o) => ({ value: o.value, scriptpubkey: o.scriptpubkey }));
  }
  return record;
}

function readBundle(r: ByteReader, buf: Buffer, vout: number): PegBundleRecord {
  r.u8(); // 'P'
  const slot = r.u8();
  const { tx, span } = readFreebankTx(r, buf);
  const count = r.compactSize();
  const withdrawal_ids: string[] = [];
  for (let i = 0; i < count; i++) {
    withdrawal_ids.push(r.hash256());
  }
  // status, nHeight and nFailHeight follow; the producer never sets nFailHeight in the coinbase
  // copy (validation.cpp CreateWithdrawalBundleTx), so none of the three is read.

  // validation.cpp CreateWithdrawalBundleTx: CUSF puts OP_RETURN PUSH8(total fee, big-endian) at
  // vout[0] and the payouts after it; legacy puts OP_RETURN 'D' at vout[0], OP_RETURN PUSH8(fee,
  // little-endian) at vout[1] and the payouts after them. Payouts follow withdrawal_ids' order.
  let format: PegBundleRecord['format'] = 'unknown';
  let ecash_fee: number | null = null;
  let first = 0;
  const script0 = tx.vout[0]?.scriptpubkey || '';
  const script1 = tx.vout[1]?.scriptpubkey || '';
  if (/^6a08[0-9a-f]{16}$/.test(script0)) {
    format = 'cusf';
    const fee = Buffer.from(script0.slice(4), 'hex');
    ecash_fee = fee.readUInt32BE(0) * TWO_POW_32 + fee.readUInt32BE(4);
    first = 1;
  } else if (script0 === '6a0144') {
    format = 'legacy';
    first = 2;
    if (/^6a08[0-9a-f]{16}$/.test(script1)) {
      ecash_fee = new ByteReader(Buffer.from(script1.slice(4), 'hex')).i64();
    }
  }
  const payouts: PegBundlePayout[] = [];
  tx.vout.forEach((o, i) => {
    if (format === 'unknown' ? o.value > 0 : i >= first) {
      payouts.push({ vout: i, value: o.value, scriptpubkey: o.scriptpubkey, withdrawal_id: withdrawal_ids[payouts.length] ?? null });
    }
  });
  return {
    kind: 'bundle',
    vout,
    slot,
    bundle_hash: tx.txid,
    m6id: bundleM6id(buf, span, tx),
    format,
    ecash_fee,
    payouts,
    withdrawal_ids,
    total: payouts.reduce((sum, p) => sum + p.value, 0),
  };
}

function readWithdrawal(r: ByteReader, buf: Buffer, vout: number): PegWithdrawalObject {
  const start = r.pos;
  r.u8(); // 'W'
  const slot = r.u8();
  const dest_raw = r.varString();
  const refund_dest = r.varString();
  const amount = r.i64();
  const ecash_fee = r.i64();
  const statusAt = r.pos;
  r.u8(); // status
  r.skip(32); // hashBlindTx
  // GetID: the hash of the object with status 'u', over its fields only
  const object = Buffer.from(buf.subarray(start, r.pos));
  object[statusAt - start] = WITHDRAWAL_UNSPENT;
  return {
    kind: 'withdrawal',
    vout,
    slot,
    id: reverseHex(sha256d(object)),
    dest_raw,
    refund_dest,
    amount,
    ecash_fee,
    payout: amount - ecash_fee,
  };
}
