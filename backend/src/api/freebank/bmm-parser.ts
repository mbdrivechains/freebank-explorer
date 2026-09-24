import { createHash } from 'crypto';
import { ByteReader, FreebankParseError } from './freebank-tx-parser';

// FreeBank: finds the blind-merged-mining records (BIP301) in a raw eCash block, for the BMM
// view (/api/v1/freebank/bmm*, see bmm.ts). eCash blocks use Bitcoin's serialization:
//
//   80-byte header (int32 version, prev block hash, merkle root, time, bits, nonce)
//   compact-size tx count, then each tx: int32 version, [0x00 0x01 segwit marker and flag],
//   vin, vout, [witness], uint32 locktime
//
// M7 (BMM accept) - an output of the coinbase (tx 0), 39 bytes:
//   6a 25 d1 61 73 68 <slot:1> <h*:32>
// M8 (BMM request, the bid) - output 0 of any tx, 70 bytes (71 with its length byte):
//   6a 44 00 bf 00 <slot:1> <h*:32> <prev mainchain block hash:32>
//
// h* is the sidechain block's merkle root. Every hash is returned in display order (bytes
// reversed, as Core prints it). Outputs that are not M7/M8 are skipped; only a malformed
// block throws (FreebankParseError). No dependency beyond node's crypto and the tx parser's
// ByteReader, so it is unit-tested on its own (src/__tests__/api/freebank/bmm-parser.test.ts).

export interface BmmAccept {
  slot: number;
  hstar: string;
}

export interface BmmRequest {
  slot: number;
  hstar: string;
  prev: string; // the mainchain block this bid is valid on top of
  txid: string;
  index: number; // position of the tx in the block
}

export interface BmmBlockRecords {
  hash: string; // the block's own hash (sha256d of the header)
  prevBlock: string; // the block header's previous block hash
  coinbaseM7: BmmAccept[];
  m8: BmmRequest[];
}

const HEADER_BYTES = 80;
const M7_SCRIPT_BYTES = 39;
const M7_PREFIX = Buffer.from('6a25d1617368', 'hex');
const M8_SCRIPT_BYTES = 70;
const M8_PREFIX = Buffer.from('6a4400bf00', 'hex');

function reverseHex(b: Buffer): string {
  return Buffer.from(b).reverse().toString('hex');
}

function sha256d(b: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

function isM7(script: Buffer): boolean {
  return script.length === M7_SCRIPT_BYTES && script.subarray(0, M7_PREFIX.length).equals(M7_PREFIX);
}

function isM8(script: Buffer): boolean {
  return script.length === M8_SCRIPT_BYTES && script.subarray(0, M8_PREFIX.length).equals(M8_PREFIX);
}

/** The M7s in the coinbase and every M8 in a raw eCash block. Throws FreebankParseError. */
export function parseBmmBlock(raw: Buffer): BmmBlockRecords {
  const r = new ByteReader(raw);
  r.skip(4); // version
  const prevBlock = r.hash256();
  r.skip(HEADER_BYTES - 36); // merkle root, time, bits, nonce
  const hash = reverseHex(sha256d(raw.subarray(0, HEADER_BYTES)));

  const coinbaseM7: BmmAccept[] = [];
  const m8: BmmRequest[] = [];
  const txCount = r.compactSize();
  if (txCount === 0) {
    throw new FreebankParseError('block has no transactions');
  }
  for (let index = 0; index < txCount; index++) {
    const txStart = r.pos;
    r.skip(4); // version
    let segwit = false;
    if (r.remaining >= 2 && raw[r.pos] === 0x00 && raw[r.pos + 1] === 0x01) {
      segwit = true;
      r.skip(2);
    }
    const bodyStart = r.pos;

    const vinCount = r.compactSize();
    for (let i = 0; i < vinCount; i++) {
      r.skip(36); // prev txid, vout
      r.varBytes(); // scriptSig
      r.skip(4); // sequence
    }

    let request: { slot: number, hstar: string, prev: string } | null = null;
    const voutCount = r.compactSize();
    for (let o = 0; o < voutCount; o++) {
      r.skip(8); // value
      const script = r.varBytes();
      if (index === 0 && isM7(script)) {
        coinbaseM7.push({ slot: script[6], hstar: reverseHex(script.subarray(7, 39)) });
      }
      if (o === 0 && isM8(script)) {
        request = {
          slot: script[5],
          hstar: reverseHex(script.subarray(6, 38)),
          prev: reverseHex(script.subarray(38, 70)),
        };
      }
    }
    const bodyEnd = r.pos;

    if (segwit) {
      for (let i = 0; i < vinCount; i++) {
        const items = r.compactSize();
        for (let j = 0; j < items; j++) {
          r.varBytes();
        }
      }
    }
    r.skip(4); // locktime

    if (request) {
      // txid: sha256d of version + vin + vout + locktime, i.e. without marker, flag and witness
      const stripped = Buffer.concat([
        raw.subarray(txStart, txStart + 4),
        raw.subarray(bodyStart, bodyEnd),
        raw.subarray(r.pos - 4, r.pos),
      ]);
      m8.push({ ...request, txid: reverseHex(sha256d(stripped)), index });
    }
  }
  return { hash, prevBlock, coinbaseM7, m8 };
}
