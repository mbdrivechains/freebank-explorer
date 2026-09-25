import { createHash } from 'crypto';
import { parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';

// Builders for FreeBank peg outputs, written byte by byte from freebank/src/sidechain.h (the
// objects' SerializationOp field order), sidechain.cpp SidechainObj::GetScript, validation.cpp
// Generate*Commit and primitives/transaction.h. Independent of the explorer's parser, which the
// tests check against them. Also used by peg-*.test.ts.

export function sha256d(b: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

/** Display-order hex of a hash. */
export function display(b: Buffer): string {
  return Buffer.from(b).reverse().toString('hex');
}

/** Internal-order bytes of a display-order hash. */
export function internal(hex: string): Buffer {
  return Buffer.from(hex, 'hex').reverse();
}

export function hash32(seed: string): string {
  return display(sha256d(Buffer.from(seed)));
}

export function compactSize(n: number): Buffer {
  if (n < 0xfd) {
    return Buffer.from([n]);
  }
  const b = Buffer.alloc(3);
  b[0] = 0xfd;
  b.writeUInt16LE(n, 1);
  return b;
}

export function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

export function i64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n)); // negative amounts too (a 'D' record may carry one)
  return b;
}

export function varBytes(b: Buffer): Buffer {
  return Buffer.concat([compactSize(b.length), b]);
}

export function varString(s: string): Buffer {
  return varBytes(Buffer.from(s, 'utf8'));
}

export interface TxSpec {
  version?: number;
  replay?: number; // v3 only (FreeBank's replay byte)
  vin?: { txid: string, vout: number, scriptsig?: string, sequence?: number, witness?: string[] }[];
  vout: { value: number, scriptpubkey: string }[];
  locktime?: number;
}

function outputsBytes(vout: TxSpec['vout']): Buffer {
  return Buffer.concat([compactSize(vout.length), ...vout.map((o) => Buffer.concat([i64(o.value), varBytes(Buffer.from(o.scriptpubkey, 'hex'))]))]);
}

/** A tx in FreeBank's serialization (with the witness when any input has one). */
export function txBytes(spec: TxSpec, withWitness = true): Buffer {
  const version = spec.version ?? 2;
  const vin = spec.vin ?? [];
  const segwit = withWitness && vin.some((i) => i.witness?.length);
  const parts: Buffer[] = [i32(version)];
  if (version === 3) {
    parts.push(Buffer.from([spec.replay ?? 0x3f]));
  }
  if (segwit) {
    parts.push(Buffer.from([0x00, 0x01]));
  }
  parts.push(compactSize(vin.length));
  for (const input of vin) {
    parts.push(internal(input.txid), u32(input.vout), varBytes(Buffer.from(input.scriptsig ?? '', 'hex')), u32(input.sequence ?? 0xffffffff));
  }
  parts.push(outputsBytes(spec.vout));
  if (segwit) {
    for (const input of vin) {
      const items = input.witness ?? [];
      parts.push(compactSize(items.length), ...items.map((w) => varBytes(Buffer.from(w, 'hex'))));
    }
  }
  parts.push(u32(spec.locktime ?? 0));
  return Buffer.concat(parts);
}

/** The txid an eCash (Bitcoin-style) node computes: version, vin, vout, locktime; no replay byte. */
export function bitcoinTxid(spec: TxSpec): string {
  const vin = spec.vin ?? [];
  const parts: Buffer[] = [i32(spec.version ?? 2), compactSize(vin.length)];
  for (const input of vin) {
    parts.push(internal(input.txid), u32(input.vout), varBytes(Buffer.from(input.scriptsig ?? '', 'hex')), u32(input.sequence ?? 0xffffffff));
  }
  parts.push(outputsBytes(spec.vout), u32(spec.locktime ?? 0));
  return display(sha256d(Buffer.concat(parts)));
}

const OBJECT_HEADER = '6aacdcf66f';

/** A deposit record (SidechainDeposit), as GetScript writes it. */
export function depositScript(d: { dest: string, amount: number, dtx: TxSpec, burn: number, ntx?: number, block: string, slot?: number }): string {
  return OBJECT_HEADER + Buffer.concat([
    Buffer.from('D'),
    Buffer.from([d.slot ?? 130]),
    varString(d.dest),
    i64(d.amount),
    txBytes(d.dtx),
    u32(d.burn),
    u32(d.ntx ?? 1),
    internal(d.block),
  ]).toString('hex');
}

/** A withdrawal bundle record (SidechainWithdrawalBundle). nFailHeight is left as garbage, as the producer does. */
export function bundleScript(b: { tx: TxSpec, ids: string[], slot?: number, height?: number }): string {
  return OBJECT_HEADER + Buffer.concat([
    Buffer.from('P'),
    Buffer.from([b.slot ?? 130]),
    txBytes(b.tx),
    compactSize(b.ids.length),
    ...b.ids.map(internal),
    Buffer.from('c'),
    i32(b.height ?? 0),
    Buffer.from([0xde, 0xad, 0xbe, 0xef]), // nFailHeight: never set in the coinbase copy
  ]).toString('hex');
}

/** A withdrawal object (SidechainWithdrawal) and its id (GetID: the hash with status 'u'). */
export function withdrawalObject(w: { dest: string, refund: string, amount: number, fee: number, status?: string, blind?: string, slot?: number }): { script: string, id: string } {
  const fields = (status: string) => Buffer.concat([
    Buffer.from('W'),
    Buffer.from([w.slot ?? 130]),
    varString(w.dest),
    varString(w.refund),
    i64(w.amount),
    i64(w.fee),
    Buffer.from(status),
    internal(w.blind ?? hash32('blind')),
  ]);
  return { script: OBJECT_HEADER + fields(w.status ?? 'u').toString('hex'), id: display(sha256d(fields('u'))) };
}

export function commitScript(kind: 'bundle-hash' | 'bundle-paid' | 'bundle-failed', bundleHash: string): string {
  const tag = { 'bundle-hash': 'ef5d1dfe', 'bundle-paid': 'fb5345de', 'bundle-failed': 'fa86c689' }[kind];
  return '6a' + tag + internal(bundleHash).toString('hex');
}

export function refundRequestScript(withdrawalId: string): string {
  return '6afcd2e546' + internal(withdrawalId).toString('hex') + '11'.repeat(65);
}

/** OP_RETURN PUSH8(fee, big-endian): the CUSF bundle's vout[0]. */
export function cusfFeeScript(fee: number): string {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(fee / 0x100000000));
  b.writeUInt32BE(fee % 0x100000000, 4);
  return '6a08' + b.toString('hex');
}

/** OP_RETURN PUSH8(fee, little-endian): the legacy bundle's vout[1]. */
export function legacyFeeScript(fee: number): string {
  return '6a08' + i64(fee).toString('hex');
}

export const P2PKH = (seed: string): string => '76a914' + sha256d(Buffer.from(seed)).subarray(0, 20).toString('hex') + '88ac';
export const P2WPKH = (seed: string): string => '0014' + sha256d(Buffer.from(seed)).subarray(0, 20).toString('hex');

describe('peg test builders', () => {
  test('a built tx reads back through the FreeBank parser with the same txid', () => {
    const spec: TxSpec = { version: 2, vin: [{ txid: hash32('a'), vout: 1 }], vout: [{ value: 5000, scriptpubkey: P2PKH('x') }] };
    expect(parseFreebankTx(txBytes(spec)).txid).toEqual(bitcoinTxid(spec));
  });
});
