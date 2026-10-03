import { createHash } from 'crypto';

// FreeBank transaction parser: reads freebankd's own serialization, which stock Bitcoin
// parsers (bitcoinjs-lib, rust-bitcoin, electrs) reject. Source of truth:
// freebank/src/primitives/transaction.h (SerializeTransaction / UnserializeTransaction).
//
//   int32   nVersion                  (little-endian)
//   uint8   replay byte 0x3f          ONLY when nVersion == 3 (the default tx version);
//                                     credit versions 11-17 do not carry it
//   [0x00 marker, uint8 flags]        segwit extended format, as in Bitcoin Core
//   vin     compact-size count, each: 32-byte prev txid, uint32 vout, compact-size script,
//           uint32 sequence
//   vout    compact-size count, each: int64 value (sats), compact-size script
//   witness one stack per input, when flags & 1
//   uint32  nLockTime
//   trailer by version:
//     10 (asset genesis):            string ticker, string headline, uint256 payload, uint8 decimals
//                                     (the decimals byte is new in v0.2.18; earlier nodes had no v10 txs)
//     11-17 (credit):                uint8 op, compact-size-length payload
//
// The txid is sha256d over the serialization WITHOUT the witness, and that serialization
// keeps the replay byte and the credit trailer - so a parser that drops either computes the
// wrong txid. This module has no dependency beyond node's crypto, so it can be unit-tested
// on its own (src/__tests__/api/freebank-tx-parser.test.ts).

export type CreditFamily = 'bill' | 'house' | 'note' | 'deposit' | 'pool' | 'settle' | 'oracle';

export const CREDIT_FAMILIES: readonly CreditFamily[] = ['bill', 'house', 'note', 'deposit', 'pool', 'settle', 'oracle'];

// transaction.h: TRANSACTION_BILL_VERSION = 11 ... TRANSACTION_ORACLE_VERSION = 17
export const CREDIT_FAMILY_BY_VERSION: Readonly<Record<number, CreditFamily>> = {
  11: 'bill',
  12: 'house',
  13: 'note',
  14: 'deposit',
  15: 'pool',
  16: 'settle',
  17: 'oracle',
};

export const BITASSET_CREATE_VERSION = 10;

// Op bytes, named after the header constants with the family prefix dropped and lower-cased
// (HOUSE_OP_ATTEST -> 'attest', POOL_OP_ADD_LIQ -> 'add_liq'):
//   bill.h BILL_OP_*, house.h HOUSE_OP_*, note.h NOTE_OP_*, deposit.h DEPOSIT_OP_*,
//   pool.h POOL_OP_*, settle.h SETTLE_OP_* (2 PRESENT and 3 DRAW are reserved, not live),
//   oracle.h ORACLE_OP_*
export const CREDIT_OP_NAMES: Readonly<Record<CreditFamily, Readonly<Record<number, string>>>> = {
  bill: { 1: 'issue', 2: 'endorse', 3: 'retire', 4: 'claim', 5: 'discount', 6: 'recourse', 7: 'hretire', 8: 'hclaim' },
  house: { 1: 'register', 2: 'topup', 3: 'admit', 4: 'exit', 5: 'winddown', 6: 'reclaim', 7: 'attest', 8: 'defer', 9: 'renew', 10: 'release' },
  note: { 1: 'mint', 2: 'transfer', 3: 'redeem', 4: 'lock', 5: 'unlock', 6: 'claim', 7: 'demand', 8: 'protest' },
  deposit: { 1: 'originate', 2: 'transfer', 3: 'withdraw', 4: 'claim' },
  pool: { 1: 'create', 2: 'add_liq', 3: 'remove_liq', 4: 'swap', 5: 'retire' },
  settle: { 1: 'exchange' },
  oracle: { 1: 'bond', 2: 'submit' },
};

/** The op's name for display, or 'op_<n>' for a byte the headers do not define. */
export function creditOpName(family: CreditFamily, op: number): string {
  const names = CREDIT_OP_NAMES[family];
  return (names && names[op]) || `op_${op}`;
}

export function isCreditVersion(version: number): boolean {
  return CREDIT_FAMILY_BY_VERSION[version] !== undefined;
}

export class FreebankParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreebankParseError';
  }
}

// serialize.h MAX_SIZE: the largest compact-size length ReadCompactSize accepts
const MAX_COMPACT_SIZE = 0x02000000;
const TWO_POW_32 = 0x100000000;

/** Sequential little-endian reader over a Buffer; every read is bounds-checked. */
export class ByteReader {
  public pos = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new FreebankParseError(`truncated: need ${n} byte(s) at offset ${this.pos}, ${this.buf.length - this.pos} left`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  // 64-bit reads return a JS number: exact up to 2^53, which covers every amount and unit
  // count consensus allows (the largest ceiling, SETTLE_MAX_UNITS = 3 * MAX_MONEY, is < 2^53).
  u64(): number {
    this.need(8);
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * TWO_POW_32 + lo;
  }

  i64(): number {
    this.need(8);
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * TWO_POW_32 + lo;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** serialize.h ReadCompactSize, including its canonical-encoding and MAX_SIZE checks. */
  compactSize(): number {
    const first = this.u8();
    let v: number;
    if (first < 0xfd) {
      v = first;
    } else if (first === 0xfd) {
      v = this.u16();
      if (v < 0xfd) {
        throw new FreebankParseError('non-canonical compact size');
      }
    } else if (first === 0xfe) {
      v = this.u32();
      if (v < 0x10000) {
        throw new FreebankParseError('non-canonical compact size');
      }
    } else {
      v = this.u64();
      if (v < TWO_POW_32) {
        throw new FreebankParseError('non-canonical compact size');
      }
    }
    if (v > MAX_COMPACT_SIZE) {
      throw new FreebankParseError('compact size too large');
    }
    return v;
  }

  /** A std::vector<unsigned char> (compact-size length + bytes). */
  varBytes(): Buffer {
    return this.bytes(this.compactSize());
  }

  /** A std::string (same encoding as varBytes). */
  varString(): string {
    return this.varBytes().toString('utf8');
  }

  /** A std::vector of 64-bit unsigned values: returns the count and the sum. */
  u64VectorSum(): { count: number, sum: number } {
    const count = this.compactSize();
    let sum = 0;
    for (let i = 0; i < count; i++) {
      sum += this.u64();
    }
    return { count, sum };
  }

  /** A 32-byte hash as Core prints it (byte-reversed hex). */
  hash256(): string {
    return reverseHex(this.bytes(32));
  }
}

function reverseHex(b: Buffer): string {
  const copy = Buffer.from(b);
  copy.reverse();
  return copy.toString('hex');
}

function sha256d(b: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

export interface FreebankTxInput {
  txid: string;
  vout: number;
  scriptsig: string;
  sequence: number;
  witness: string[];
}

export interface FreebankTxOutput {
  value: number; // sats
  scriptpubkey: string;
}

export interface FreebankParsedTx {
  txid: string;
  wtxid: string;
  version: number;
  replayByte: number | null; // v3 only (0x3f)
  hasWitness: boolean;
  vin: FreebankTxInput[];
  vout: FreebankTxOutput[];
  locktime: number;
  size: number; // full serialized size, bytes
  strippedSize: number; // size without the witness, bytes
  family: CreditFamily | null; // credit family for v11-v17, else null
  op: number | null; // credit op byte (v11-v17), else null
  payload: Buffer | null; // credit payload (v11-v17), else null
  bitasset: { ticker: string, headline: string, payload: string, decimals: number } | null; // v10 trailer
}

/** Parse a FreeBank transaction from raw hex (or bytes). Throws FreebankParseError. */
export function parseFreebankTx(raw: string | Buffer): FreebankParsedTx {
  let buf: Buffer;
  if (typeof raw === 'string') {
    if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
      throw new FreebankParseError('not a hex string');
    }
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = raw;
  }
  const r = new ByteReader(buf);
  const { tx } = readFreebankTx(r, buf);
  if (r.remaining !== 0) {
    throw new FreebankParseError(`${r.remaining} trailing byte(s) after the transaction`);
  }
  return tx;
}

/** Where the parts of a transaction read by readFreebankTx lie in its buffer (absolute offsets). */
export interface FreebankTxSpan {
  start: number; // nVersion
  headerEnd: number; // after nVersion and the v3 replay byte
  bodyStart: number; // vin count (after the segwit marker and flags, if any)
  bodyEnd: number; // after the last output
  locktimeStart: number;
  end: number; // after the credit or BitAsset trailer
}

/**
 * Read one FreeBank transaction at the reader's position (a transaction embedded in a larger
 * object, such as a deposit record's mainchain tx), leaving the reader just after it. `buf` is
 * the reader's buffer. Returns the transaction and where its parts lie. Throws FreebankParseError.
 */
export function readFreebankTx(r: ByteReader, buf: Buffer): { tx: FreebankParsedTx, span: FreebankTxSpan } {
  const start = r.pos;
  const version = r.i32();
  let replayByte: number | null = null;
  if (version === 3) {
    replayByte = r.u8();
  }
  const headerEnd = r.pos;

  // Mirrors UnserializeTransaction: an empty vin followed by a non-zero flags byte is the
  // extended (segwit) format; the real vin and vout follow the flags.
  let bodyStart = headerEnd;
  let flags = 0;
  let vinCount = r.compactSize();
  let readVout = true;
  if (vinCount === 0) {
    flags = r.u8();
    if (flags !== 0) {
      bodyStart = r.pos;
      vinCount = r.compactSize();
    } else {
      readVout = false; // Core reads neither vin nor vout again in this (degenerate) case
    }
  }

  const vin: FreebankTxInput[] = [];
  for (let i = 0; i < vinCount; i++) {
    const txid = r.hash256();
    const vout = r.u32();
    const scriptsig = r.varBytes().toString('hex');
    const sequence = r.u32();
    vin.push({ txid, vout, scriptsig, sequence, witness: [] });
  }

  const vout: FreebankTxOutput[] = [];
  if (readVout) {
    const voutCount = r.compactSize();
    for (let i = 0; i < voutCount; i++) {
      const value = r.i64();
      const scriptpubkey = r.varBytes().toString('hex');
      vout.push({ value, scriptpubkey });
    }
  }
  const bodyEnd = r.pos;

  let hasWitness = false;
  if (flags & 1) {
    flags ^= 1;
    hasWitness = true;
    for (const input of vin) {
      const items = r.compactSize();
      for (let j = 0; j < items; j++) {
        input.witness.push(r.varBytes().toString('hex'));
      }
    }
  }
  if (flags) {
    throw new FreebankParseError('unknown transaction optional data');
  }

  const locktimeStart = r.pos;
  const locktime = r.u32();

  let family: CreditFamily | null = null;
  let op: number | null = null;
  let payload: Buffer | null = null;
  let bitasset: FreebankParsedTx['bitasset'] = null;
  if (version === BITASSET_CREATE_VERSION) {
    const ticker = r.varString();
    const headline = r.varString();
    const bitassetPayload = r.hash256();
    const decimals = r.u8();
    bitasset = { ticker, headline, payload: bitassetPayload, decimals };
  } else if (isCreditVersion(version)) {
    family = CREDIT_FAMILY_BY_VERSION[version];
    op = r.u8();
    payload = r.varBytes();
  }
  const end = r.pos;

  // The no-witness serialization: version (+ replay byte), vin, vout, then locktime and the
  // trailer - i.e. everything except the marker/flags and the witness stacks.
  const full = buf.subarray(start, end);
  const stripped = hasWitness
    ? Buffer.concat([buf.subarray(start, headerEnd), buf.subarray(bodyStart, bodyEnd), buf.subarray(locktimeStart, end)])
    : full;

  return {
    tx: {
      txid: reverseHex(sha256d(stripped)),
      wtxid: reverseHex(sha256d(full)),
      version,
      replayByte,
      hasWitness,
      vin,
      vout,
      locktime,
      size: full.length,
      strippedSize: stripped.length,
      family,
      op,
      payload,
      bitasset,
    },
    span: { start, headerEnd, bodyStart, bodyEnd, locktimeStart, end },
  };
}

export type DecodedPayload = { [field: string]: number | string | boolean | null };

/**
 * Best-effort decode of a credit payload's leading fields - enough to say which house, bill,
 * pool or submitter an op touches, and the amounts it moves. Reads only as far as it needs
 * (signatures and undo priors that follow are skipped). Returns {} for an op it does not know
 * or a payload that does not fit the layout; never throws.
 *
 * Units, as the node's structs define them:
 *   *_sats   base-coin (ECX) amounts in satoshis (CAmount)
 *   *units   note units (1 unit of face = 1 sat, par by consensus)
 *   heights  block heights
 * Layouts: bill.h, house.h, note.h, deposit.h, pool.h, settle.h, oracle.h (the payload
 * structs' SerializationOp field order).
 */
export function decodeCreditPayload(family: CreditFamily | null, op: number | null, payload: Buffer | null): DecodedPayload {
  if (family === null || op === null || payload === null) {
    return {};
  }
  try {
    const r = new ByteReader(payload);
    switch (family) {
      case 'bill': return decodeBill(r, op);
      case 'house': return decodeHouse(r, op);
      case 'note': return decodeNote(r, op);
      case 'deposit': return decodeDeposit(r, op);
      case 'pool': return decodePool(r, op);
      case 'settle': return decodeSettle(r, op);
      case 'oracle': return decodeOracle(r, op);
      default: return {};
    }
  } catch {
    return {};
  }
}

function decodeBill(r: ByteReader, op: number): DecodedPayload {
  switch (op) {
    case 1: { // BillIssue: the bill id is assigned by the node, not carried in the payload
      r.varBytes(); // vchEncryptedBody
      const face_sats = r.i64();
      const maturity_height = r.u32();
      const grace_blocks = r.u32();
      return { face_sats, maturity_height, grace_blocks };
    }
    case 2: { // BillEndorse: nBillID, BillEndorsement { vchFrom, vchTo, nAtHeight, vchSig }
      const bill_id = r.u32();
      const from_pubkey = r.varBytes().toString('hex');
      const to_pubkey = r.varBytes().toString('hex');
      return { bill_id, from_pubkey, to_pubkey };
    }
    case 3: // BillRetire
    case 4: // BillClaim
    case 6: // BillRecourse
      return { bill_id: r.u32() };
    case 5: { // BillDiscount: a house buys the bill into its loan book, paying in its notes
      const bill_id = r.u32();
      const house_id = r.u32();
      const price_units = r.i64();
      const face_sats = r.i64();
      const maturity_height = r.u32();
      return { bill_id, house_id, price_units, face_sats, maturity_height };
    }
    case 7: // BillHRetire: the acceptor pays a house-held bill
    case 8: { // BillHClaim: a house claims the escrow of a house-held bill
      const bill_id = r.u32();
      const house_id = r.u32(); // nOwnerHouseID
      const face_sats = r.i64();
      const maturity_height = r.u32();
      return { bill_id, house_id, face_sats, maturity_height };
    }
    default:
      return {};
  }
}

function decodeHouse(r: ByteReader, op: number): DecodedPayload {
  switch (op) {
    case 1: { // HouseRegister: the house id is assigned by the node
      const tier = r.u8();
      const threshold = r.u32();
      const classid = r.varString();
      const denominationmggold = r.u64();
      r.varBytes(); // vchRedemptionDestPK
      const partners = r.compactSize(); // vPartnerPubKey
      for (let i = 0; i < partners; i++) {
        r.varBytes();
      }
      const pledges = r.compactSize(); // vPledgeAmount (CAmount each)
      let pledge_sats = 0;
      for (let i = 0; i < pledges; i++) {
        pledge_sats += r.i64();
      }
      return { tier, threshold, classid, denominationmggold, partners, pledge_sats };
    }
    case 2: // HouseTopup
    case 4: // HouseExit
    case 6: { // HouseReclaim
      const house_id = r.u32();
      const partner_index = r.u32();
      return { house_id, partner_index };
    }
    case 7: { // HouseAttest
      const house_id = r.u32();
      const schema = r.u8();
      const as_of_height = r.u32();
      r.skip(4 + 4); // nPrevLastAttestHeight, nPrevStressSince
      r.skip(8); // amountPrevReserves
      r.skip(4 * 4); // nPrevDeferInvokedHeight, nPrevDeferRenewals, nPrevDeferCumBlocks, nPrevDeferEndedHeight
      if (schema !== 1) {
        return { house_id, as_of_height };
      }
      const reserves_sats = r.i64();
      return { house_id, as_of_height, reserves_sats };
    }
    case 3: // HouseAdmit
    case 5: // HouseWinddown
    case 8: // HouseDefer
    case 9: // HouseRenew
    case 10: // HouseRelease
      return { house_id: r.u32() };
    default:
      return {};
  }
}

// note.h NOTE_DEMAND_MODE_* (v0.2.18; the byte was 0/1 before): plain demands exist only while the house is suspended
// (deferred); pre-authorised ones at open or stressed; the queue mode is a pre-authorised demand filed while
// suspended, or the upgrade of a plain one.
export const NOTE_DEMAND_MODES: Readonly<Record<number, string>> = { 0: 'plain', 1: 'preauth', 2: 'preauth_queue' };

function decodeNote(r: ByteReader, op: number): DecodedPayload {
  const house_id = r.u32(); // every note payload leads with nHouseID
  switch (op) {
    case 7: { // NoteDemand: vUnits, holder pubkey and sig, then the mode byte and the prior demand height
      const units = r.u64VectorSum();
      r.varBytes(); // vchHolderPubKey
      r.varBytes(); // vchHolderSig
      const mode = r.u8(); // fPreAuth: NOTE_DEMAND_MODE_* (0 plain, 1 pre-authorised, 2 pre-authorised queue)
      const prior_demand_height = r.u32(); // non-zero only on an upgrade of a plain demand (keeps its clock)
      return {
        house_id, units: units.sum, outputs: units.count,
        demand_mode: NOTE_DEMAND_MODES[mode] || `mode_${mode}`, prior_demand_height,
      };
    }
    case 1: // NoteMint
    case 2: // NoteTransfer
    case 8: { // NoteProtest
      const units = r.u64VectorSum(); // vUnits, one per note output
      return { house_id, units: units.sum, outputs: units.count };
    }
    default: // NoteRedeem, NoteClaim (and the inert LOCK/UNLOCK)
      return { house_id };
  }
}

function decodeDeposit(r: ByteReader, op: number): DecodedPayload {
  const house_id = r.u32(); // every deposit payload leads with nHouseID
  switch (op) {
    case 1: { // DepositOriginate: one or more receipts
      const principal = r.u64VectorSum();
      return { house_id, principal_units: principal.sum, receipts: principal.count };
    }
    case 2: { // DepositTransfer: one whole receipt changes hands
      const principal_units = r.u64();
      const rate_bps = r.u32();
      const maturity_height = r.u32();
      return { house_id, principal_units, rate_bps, maturity_height };
    }
    default: // DepositWithdraw, DepositClaim
      return { house_id };
  }
}

function decodePool(r: ByteReader, op: number): DecodedPayload {
  const pool_id = r.u32(); // == the house id (v1: one pool per house)
  const base = { pool_id, house_id: pool_id };
  switch (op) {
    case 1: { // PoolCreate
      const fee_bps = r.u32();
      const note_units = r.u64();
      const ecx_sats = r.i64();
      return { ...base, fee_bps, note_units, ecx_sats };
    }
    case 2: { // PoolAddLiq
      r.skip(8 * 3); // prior X, Y, S
      const note_units = r.u64();
      const ecx_sats = r.i64();
      const lp_minted = r.u64();
      return { ...base, note_units, ecx_sats, lp_minted };
    }
    case 3: { // PoolRemoveLiq
      r.skip(8 * 3); // prior X, Y, S
      const lp_burned = r.u64();
      const note_units_out = r.u64();
      const ecx_sats_out = r.i64();
      return { ...base, lp_burned, note_units_out, ecx_sats_out };
    }
    case 4: { // PoolSwap: direction 1 = notes in, ECX out; 2 = ECX in, notes out
      r.skip(8 * 3); // prior X, Y, S
      const direction = r.u8();
      const amount_in = r.u64();
      r.skip(8); // nMinOut
      const amount_out = r.u64();
      const directionName = direction === 1 ? 'notes_for_ecx' : direction === 2 ? 'ecx_for_notes' : `direction_${direction}`;
      return { ...base, direction: directionName, amount_in, amount_out };
    }
    default: // PoolRetire
      return base;
  }
}

function decodeSettle(r: ByteReader, op: number): DecodedPayload {
  if (op !== 1) {
    return {};
  }
  // SettleExchange: two houses exchange each other's notes at par. House A (the lower id)
  // presents B's notes and B presents A's; the net difference is paid in ECX by the house
  // whose paper came home more (the debtor) to the other (the creditor).
  const house_a_id = r.u32();
  const house_b_id = r.u32();
  const mode = r.u8(); // 0 = pure swap (equal amounts), 1 = with a residual payment
  const house_a_notes_units = r.u64(); // units of A-issued notes presented
  const house_b_notes_units = r.u64(); // units of B-issued notes presented
  r.skip(2 + 2); // bundle sizes
  r.varBytes(); // presentment key of the A-note bundle
  r.varBytes(); // presentment key of the B-note bundle
  const residual_sats = r.i64();
  r.skip(8 + 8 + 4 + 4); // undo priors: minted units A/B, last settle height A/B
  const expiry_height = r.u32();
  const diff = house_a_notes_units - house_b_notes_units;
  return {
    house_a_id,
    house_b_id,
    mode,
    house_a_notes_units,
    house_b_notes_units,
    residual_sats,
    debtor_house_id: diff > 0 ? house_a_id : diff < 0 ? house_b_id : null,
    creditor_house_id: diff > 0 ? house_b_id : diff < 0 ? house_a_id : null,
    expiry_height,
  };
}

function decodeOracle(r: ByteReader, op: number): DecodedPayload {
  const submitter_id = r.u32(); // bond: 0 = a new submitter registering
  const target_height = r.u32();
  switch (op) {
    case 1: { // OracleBond
      const pubkey = r.varBytes().toString('hex');
      return { submitter_id, target_height, pubkey };
    }
    case 2: { // OracleSubmit: price in milligrams of gold per 1000 ECX (the getgoldfix unit)
      const price_mg = r.u64();
      return { submitter_id, target_height, price_mg };
    }
    default:
      return { submitter_id, target_height };
  }
}
