import { createHash } from 'crypto';
import { parseFreebankTx } from '../../api/freebank/freebank-tx-parser';
import {
  CoinTag, coinTags, CustodyDirectory, CustodyLabel, custodyLabel, custodyPush, poolEscrowPush, reverseHex,
} from '../../api/freebank/custody-tags';
import { buildDirectory, CUSTODY_MAX_INPUTS, CustodyNode, FreebankCustody } from '../../api/freebank/custody';

// Custody labels: a table of synthetic transactions, one per tagging branch the tagger copies
// from freebank/src/coins.cpp:93-297 (AddCoins), bill.cpp:168-203 (ApplyBillCoinTags) and
// pool.cpp:156-255 (ApplyPoolCoinTags), plus look-alikes; then the real transactions of the
// explorer spike's chain against that chain's own listhouses / listbills / listpools /
// listoraclesubmitters; then the resolver behind GET /api/v1/freebank/custody.

const fixtures = require('./test-data/freebank-txs.json');
const rpc = require('./test-data/freebank-credit-rpc.json');

// ---- a small writer for FreeBank's serialization (freebank/src/primitives/transaction.h) ----

class Writer {
  private parts: Buffer[] = [];

  u8(n: number): this {
    this.parts.push(Buffer.from([n]));
    return this;
  }

  u16(n: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    this.parts.push(b);
    return this;
  }

  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    this.parts.push(b);
    return this;
  }

  i32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    this.parts.push(b);
    return this;
  }

  u64(n: number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    this.parts.push(b);
    return this;
  }

  compact(n: number): this {
    if (n < 0xfd) {
      return this.u8(n);
    }
    return this.u8(0xfd).u16(n);
  }

  bytes(b: Buffer | string): this {
    this.parts.push(typeof b === 'string' ? Buffer.from(b, 'hex') : b);
    return this;
  }

  varBytes(b: Buffer | string): this {
    const buf = typeof b === 'string' ? Buffer.from(b, 'hex') : b;
    return this.compact(buf.length).bytes(buf);
  }

  u64Vec(values: number[]): this {
    this.compact(values.length);
    values.forEach((v) => this.u64(v));
    return this;
  }

  buf(): Buffer {
    return Buffer.concat(this.parts);
  }
}

interface TxSpec {
  version: number;
  vin?: { txid: string, vout: number }[];
  vout: { value?: number, script: string }[];
  op?: number;
  payload?: Buffer;
}

const COINBASE_TXID = '0'.repeat(64);

function rawTx(spec: TxSpec): string {
  const w = new Writer().i32(spec.version);
  if (spec.version === 3) {
    w.u8(0x3f); // replay byte
  }
  const vin = spec.vin || [{ txid: 'aa'.repeat(32), vout: 0 }];
  w.compact(vin.length);
  for (const input of vin) {
    w.bytes(reverseHex(input.txid)).u32(input.vout).varBytes('').u32(0xffffffff);
  }
  w.compact(spec.vout.length);
  for (const output of spec.vout) {
    w.u64(output.value ?? 1000).varBytes(output.script);
  }
  w.u32(0); // nLockTime
  if (spec.version >= 11 && spec.version <= 17) {
    w.u8(spec.op as number).varBytes(spec.payload || Buffer.alloc(0));
  }
  return w.buf().toString('hex');
}

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
const sha256d = (b: Buffer): Buffer => sha256(sha256(b));
const hash160 = (b: Buffer): Buffer => createHash('ripemd160').update(sha256(b)).digest();

/** `<push> OP_DROP OP_TRUE` */
function custody(push: string): string {
  return (push.length / 2).toString(16).padStart(2, '0') + push + '7551';
}

function p2pkh(seed: number): string {
  return '76a914' + seed.toString(16).padStart(2, '0').repeat(20) + '88ac';
}

function pubkey(seed: number): string {
  return '02' + seed.toString(16).padStart(2, '0').repeat(32);
}

// Houses of the synthetic tests: house 3's escrow push, and house 4's for "another house".
const HOUSE3_HASH = 'a3'.repeat(32); // display order, as listhouses prints it
const HOUSE4_HASH = 'b4'.repeat(32);
const HOUSE3_PUSH = reverseHex(HOUSE3_HASH);
const HOUSE4_PUSH = reverseHex(HOUSE4_HASH);

function directory(extra: Partial<CustodyDirectory> = {}): CustodyDirectory {
  return {
    houseIdByHash: (h) => ({ [HOUSE3_HASH]: 3, [HOUSE4_HASH]: 4 } as Record<string, number>)[h],
    houseHashById: (id) => ({ 3: HOUSE3_HASH, 4: HOUSE4_HASH } as Record<number, string>)[id],
    partnerIndex: (id, pk) => (id === 3 && pk === pubkey(0x42) ? 2 : undefined),
    billIdByHash: () => undefined,
    poolListed: (id) => id === 2,
    submitterIdByPubkey: (pk) => (pk === pubkey(0x44) ? 4 : undefined),
    ...extra,
  };
}

function labels(spec: TxSpec, dir: CustodyDirectory = directory()): (CustodyLabel | null)[] {
  const tx = parseFreebankTx(rawTx(spec));
  const tags = coinTags(tx);
  return tx.vout.map((o, n) => custodyLabel(o.scriptpubkey, tags[n], dir));
}

const texts = (spec: TxSpec, dir?: CustodyDirectory): (string | null)[] => labels(spec, dir).map((l) => l?.text ?? null);

const LOOKALIKE = 'Unlocked look-alike (anyone can spend)';

// ---- payloads (field order: freebank/src/{house,note,deposit,bill,pool,oracle}.h) ----

function houseRegister(partners: string[], pledges: number[]): { payload: Buffer, hash: string } {
  const decl = new Writer().u8(0).u32(1).varBytes(Buffer.from('hsyn')).u64(1000).varBytes(pubkey(0x30));
  decl.compact(partners.length);
  partners.forEach((pk) => decl.varBytes(pk));
  decl.compact(pledges.length);
  pledges.forEach((v) => decl.u64(v));
  const declaration = decl.buf();
  const tag = Buffer.concat([Buffer.from([25]), Buffer.from('FreeBankHouse/declaration')]);
  const hash = sha256d(Buffer.concat([tag, declaration])).toString('hex'); // script order
  const sigs = new Writer().compact(partners.length);
  partners.forEach(() => sigs.varBytes('30'.repeat(70)));
  return { payload: Buffer.concat([declaration, sigs.buf()]), hash };
}

const approvals = (): Buffer => new Writer().compact(1).u32(0).compact(1).varBytes('30'.repeat(70)).buf();

const houseTopup = (houseId: number, partner: number): Buffer => new Writer().u32(houseId).u32(partner).varBytes('30'.repeat(70)).buf();
const houseAdmit = (houseId: number, pk: string): Buffer => new Writer().u32(houseId).varBytes(pk).varBytes('30'.repeat(70)).bytes(approvals()).buf();
const houseDefer = (houseId: number): Buffer => new Writer().u32(houseId).u32(0).bytes(approvals()).buf();
const houseOnly = (houseId: number): Buffer => new Writer().u32(houseId).bytes(approvals()).buf();

function noteRedeem(houseId: number, brassage: number): Buffer {
  return new Writer().u32(houseId).u8(brassage).varBytes(pubkey(0x50)).varBytes('30'.repeat(70))
    .u8(0).u64Vec([]).varBytes('').varBytes('').buf();
}

const noteClaim = (houseId: number, change: number): Buffer => new Writer().u32(houseId).u8(change).varBytes(pubkey(0x50)).varBytes('30'.repeat(70)).buf();

function noteDemand(houseId: number, units: number[], holder: string, preAuth: number): Buffer {
  return new Writer().u32(houseId).u64Vec(units).varBytes(holder).varBytes('30'.repeat(70))
    .u8(preAuth).u32(0).varBytes(preAuth ? p2pkh(0x51) : '').varBytes(preAuth ? '30'.repeat(70) : '').buf();
}

function noteProtest(houseId: number, units: number[], holder: string, tag: number): Buffer {
  return new Writer().u32(houseId).u64Vec(units).varBytes(holder).varBytes('30'.repeat(70))
    .u32(tag).u32(0).u32(0).u32(0).buf();
}

const noteMint = (houseId: number, units: number[]): Buffer => new Writer().u32(houseId).u64Vec(units).u32(10).compact(0).bytes(approvals()).buf();

const depositClaim = (houseId: number, change: number): Buffer => new Writer().u32(houseId).u8(change).varBytes(pubkey(0x52)).varBytes('30'.repeat(70)).buf();
const depositOriginate = (houseId: number, principals: number[]): Buffer => new Writer().u32(houseId).u64Vec(principals)
  .compact(principals.length).bytes(Buffer.alloc(4 * principals.length)).compact(principals.length).bytes(Buffer.alloc(4 * principals.length))
  .bytes(approvals()).buf();

function billIssue(body: Buffer): Buffer {
  return new Writer().varBytes(body).u64(100000000).u32(500).u32(5).varBytes(pubkey(0x60)).varBytes(pubkey(0x61))
    .varBytes(pubkey(0x62)).varBytes('30'.repeat(70)).varBytes('30'.repeat(70)).buf();
}

function billDiscount(billId: number, houseId: number, units: number[]): Buffer {
  return new Writer().u32(billId).u32(houseId).u64(90000).u64(100000).u32(500).u16(units.length).u64Vec(units)
    .varBytes(pubkey(0x63)).u32(600).u32(10).compact(0).u64(0).u64(0).u64(0).u64(0).buf();
}

const poolCreate = (poolId: number, notes: number, ecx: number, change: number): Buffer =>
  new Writer().u32(poolId).u32(30).u64(notes).u64(ecx).u64(change).varBytes(pubkey(0x70)).varBytes('30'.repeat(70)).bytes(approvals()).buf();
const poolAdd = (poolId: number, priorNotes: number, addNotes: number, change: number): Buffer =>
  new Writer().u32(poolId).u64(priorNotes).u64(5000).u64(5000).u64(addNotes).u64(1000).u64(900).u64(change).varBytes(pubkey(0x70)).varBytes('30'.repeat(70)).buf();
const poolRemove = (poolId: number, priorNotes: number, noteOut: number, ecxOut: number, lpChange: number): Buffer =>
  new Writer().u32(poolId).u64(priorNotes).u64(5000).u64(5000).u64(500).u64(noteOut).u64(ecxOut).u64(lpChange).varBytes(pubkey(0x70)).varBytes('30'.repeat(70)).buf();
const poolSwap = (poolId: number, priorNotes: number, direction: number, amountIn: number, amountOut: number, change: number): Buffer =>
  new Writer().u32(poolId).u64(priorNotes).u64(5000).u64(5000).u8(direction).u64(amountIn).u64(0).u64(amountOut).u64(change).varBytes(pubkey(0x70)).varBytes('30'.repeat(70)).buf();
const poolRetire = (poolId: number): Buffer => new Writer().u32(poolId).u64(1000).u64(1000).u64(1000).u32(30).i32(5).u32(0).varBytes('30'.repeat(70)).bytes(approvals()).buf();

const oracleBond = (submitterId: number, pk: string): Buffer => new Writer().u32(submitterId).u32(100).varBytes(pk).u32(0).u32(0).u32(0)
  .bytes(Buffer.alloc(36)).varBytes('30'.repeat(70)).buf();
const oracleSubmit = (submitterId: number): Buffer => new Writer().u32(submitterId).u32(100).u64(800000000).varBytes('30'.repeat(70)).buf();

const POOL2_PUSH = poolEscrowPush(2);

describe('FreeBank custody tags and labels', () => {
  describe('the custody script shape', () => {
    test('a 20-, 32- or 33-byte push, then OP_DROP OP_TRUE', () => {
      expect(custodyPush(custody('11'.repeat(20)))).toEqual('11'.repeat(20));
      expect(custodyPush(custody('22'.repeat(32)))).toEqual('22'.repeat(32));
      expect(custodyPush(custody('33'.repeat(33)))).toEqual('33'.repeat(33));
      expect(custodyPush(custody('44'.repeat(21)))).toBeNull();
      expect(custodyPush('20' + '22'.repeat(32) + '75')).toBeNull();
      expect(custodyPush(p2pkh(1))).toBeNull();
      expect(custodyPush('')).toBeNull();
    });

    test('PoolEscrowTag(1) matches the pool 1 escrow script on the spike chain (spike/probe-9-m4.json)', () => {
      expect(poolEscrowPush(1)).toEqual('3d5f9a5adf1d3b6c6b0d362574d19d9e3c6e467eb10b723b82b4c6c86de7cb9d');
    });
  });

  describe('house (v12): AddCoins fHouseTx', () => {
    const partners = [pubkey(0x31), pubkey(0x32)];
    const reg = houseRegister(partners, [100000000, 50000000]);
    const register: TxSpec = {
      version: 12, op: 1, payload: reg.payload,
      vout: [{ script: custody(reg.hash) }, { script: custody(reg.hash) }, { script: p2pkh(1) }, { script: custody('99'.repeat(32)) }],
    };

    test('REGISTER: one pledge per partner at vout[0..N-1]; a stray custody-shaped output is a look-alike', () => {
      const dir = directory({ houseIdByHash: (h) => (h === reverseHex(reg.hash) ? 7 : undefined) });
      const got = labels(register, dir);
      expect(got.map((l) => l?.text ?? null)).toEqual([
        'House 7 · pledge (partner 0)', 'House 7 · pledge (partner 1)', null, LOOKALIKE,
      ]);
      expect(got[0]).toMatchObject({ kind: 'house_pledge', house_id: 7, partner_index: 0, link: '/house/7' });
      expect(got[3]).toMatchObject({ kind: 'lookalike', link: null });
    });

    test('REGISTER not connected yet (the house is not listed): "new house", no link', () => {
      const got = labels(register);
      expect(got[0]).toMatchObject({ kind: 'house_pledge', text: 'House pledge (new house)', link: null });
      expect(got[1]?.text).toEqual('House pledge (new house)');
    });

    test('REGISTER with a pledge output that is not this house\'s escrow script: look-alike', () => {
      expect(texts({ ...register, vout: [{ script: custody(HOUSE4_PUSH) }, { script: custody(reg.hash) }] })).toEqual([LOOKALIKE, 'House pledge (new house)']);
    });

    test('TOPUP: vout[0] is the partner\'s pledge', () => {
      const got = labels({ version: 12, op: 2, payload: houseTopup(3, 1), vout: [{ script: custody(HOUSE3_PUSH) }, { script: p2pkh(2) }] });
      expect(got[0]).toMatchObject({ kind: 'house_pledge', text: 'House 3 · pledge (partner 1)', house_id: 3, partner_index: 1, link: '/house/3' });
      expect(got[1]).toBeNull();
    });

    test('TOPUP paying another house\'s escrow script: look-alike', () => {
      expect(texts({ version: 12, op: 2, payload: houseTopup(3, 1), vout: [{ script: custody(HOUSE4_PUSH) }] })).toEqual([LOOKALIKE]);
    });

    test('ADMIT: vout[0] is the new partner\'s pledge, numbered from listhouses when it is listed', () => {
      expect(texts({ version: 12, op: 3, payload: houseAdmit(3, pubkey(0x42)), vout: [{ script: custody(HOUSE3_PUSH) }] }))
        .toEqual(['House 3 · pledge (partner 2)']);
      expect(texts({ version: 12, op: 3, payload: houseAdmit(3, pubkey(0x43)), vout: [{ script: custody(HOUSE3_PUSH) }] }))
        .toEqual(['House 3 · pledge (new partner)']);
    });

    test('DEFER: vout[0] is the till locked at deferral', () => {
      const [till] = labels({ version: 12, op: 8, payload: houseDefer(3), vout: [{ script: custody(HOUSE3_PUSH) }, { script: custody(HOUSE3_PUSH) }] });
      expect(till).toMatchObject({ kind: 'house_till', text: 'House 3 · till locked at deferral', link: '/house/3' });
    });

    test('ops that tag nothing (ATTEST, RECLAIM, RELEASE, WINDDOWN): custody-shaped outputs are look-alikes', () => {
      for (const op of [5, 6, 7, 10]) {
        expect(texts({ version: 12, op, payload: houseOnly(3), vout: [{ script: custody(HOUSE3_PUSH) }, { script: p2pkh(3) }] })).toEqual([LOOKALIKE, null]);
      }
    });

    test('an op the node does not define tags nothing', () => {
      expect(texts({ version: 12, op: 99, payload: houseOnly(3), vout: [{ script: custody(HOUSE3_PUSH) }] })).toEqual([LOOKALIKE]);
    });

    test('a house whose hash is not listed: the pledge is trusted by position (the node pins its script)', () => {
      expect(texts({ version: 12, op: 2, payload: houseTopup(9, 0), vout: [{ script: custody('77'.repeat(32)) }] }))
        .toEqual(['House 9 · pledge (partner 0)']);
    });
  });

  describe('notes (v13) and term deposits (v14): escrow change and demanded notes', () => {
    test('REDEEM with a spread: vout[1] is house escrow; without one, a custody-shaped vout[1] is a look-alike', () => {
      const spec = (brassage: number): TxSpec => ({
        version: 13, op: 3, payload: noteRedeem(3, brassage), vout: [{ script: p2pkh(4) }, { script: custody(HOUSE3_PUSH) }],
      });
      expect(labels(spec(1))[1]).toMatchObject({ kind: 'house_spread', text: 'House 3 · escrow (redemption spread)', house_id: 3 });
      expect(texts(spec(0))).toEqual([null, LOOKALIKE]);
    });

    test('REDEEM whose vout[1] is another house\'s escrow script: look-alike', () => {
      expect(texts({ version: 13, op: 3, payload: noteRedeem(3, 1), vout: [{ script: p2pkh(4) }, { script: custody(HOUSE4_PUSH) }] }))
        .toEqual([null, LOOKALIKE]);
    });

    test('note CLAIM with change: vout[1] is house escrow', () => {
      expect(texts({ version: 13, op: 6, payload: noteClaim(3, 1), vout: [{ script: p2pkh(5) }, { script: custody(HOUSE3_PUSH) }] }))
        .toEqual([null, 'House 3 · escrow (claim change)']);
      expect(texts({ version: 13, op: 6, payload: noteClaim(3, 0), vout: [{ script: p2pkh(5) }, { script: custody(HOUSE3_PUSH) }] }))
        .toEqual([null, LOOKALIKE]);
    });

    test('term-deposit CLAIM with change: vout[1] is house escrow', () => {
      const got = labels({ version: 14, op: 4, payload: depositClaim(3, 1), vout: [{ script: p2pkh(6) }, { script: custody(HOUSE3_PUSH) }] });
      expect(got[1]).toMatchObject({ kind: 'house_claim_change', text: 'House 3 · escrow (claim change)', link: '/house/3' });
    });

    const holder = pubkey(0x55);
    const keyid = hash160(Buffer.from(holder, 'hex')).toString('hex');

    test('pre-auth DEMAND: the re-issued notes sit in custody on the holder\'s keyid', () => {
      const got = labels({ version: 13, op: 7, payload: noteDemand(3, [1000, 250], holder, 1), vout: [{ script: custody(keyid) }, { script: custody(keyid) }, { script: p2pkh(7) }] });
      expect(got.map((l) => l?.text ?? null)).toEqual([
        'House 3 notes · demanded, held in custody (1,000 units)', 'House 3 notes · demanded, held in custody (250 units)', null,
      ]);
      expect(got[0]).toMatchObject({ kind: 'note_custody', house_id: 3, units: 1000, link: '/house/3' });
      expect(got[0]?.protested).toBeUndefined();
    });

    test('pre-auth DEMAND on another holder\'s keyid: look-alike', () => {
      const other = hash160(Buffer.from(pubkey(0x56), 'hex')).toString('hex');
      expect(texts({ version: 13, op: 7, payload: noteDemand(3, [1000], holder, 1), vout: [{ script: custody(other) }] })).toEqual([LOOKALIKE]);
    });

    test('plain DEMAND: the notes stay on the holder\'s key (claim coins, not custody)', () => {
      expect(texts({ version: 13, op: 7, payload: noteDemand(3, [1000], holder, 0), vout: [{ script: p2pkh(8) }] })).toEqual([null]);
    });

    test('PROTEST: re-issued in custody, marked protested', () => {
      const tag = (0x80000000 | 0x40000000 | 120) >>> 0;
      const got = labels({ version: 13, op: 8, payload: noteProtest(3, [250], holder, tag), vout: [{ script: custody(keyid) }] });
      expect(got[0]).toMatchObject({
        kind: 'note_custody', text: 'House 3 notes · demanded and protested, held in custody (250 units)', protested: true, units: 250,
      });
    });

    test('MINT outputs are notes (claim coins): no label, even on a custody-shaped script', () => {
      expect(texts({ version: 13, op: 1, payload: noteMint(3, [5000]), vout: [{ script: custody(keyid) }, { script: custody(HOUSE3_PUSH) }] }))
        .toEqual([null, LOOKALIKE]);
    });

    test('term-deposit ORIGINATE receipts are claim coins: no label', () => {
      expect(texts({ version: 14, op: 1, payload: depositOriginate(3, [1000000]), vout: [{ script: p2pkh(9) }, { script: custody(HOUSE3_PUSH) }] }))
        .toEqual([null, LOOKALIKE]);
    });
  });

  describe('bills (v11): ApplyBillCoinTags', () => {
    const body = Buffer.from('an encrypted bill body');
    const billPush = sha256(body).toString('hex');
    const issue: TxSpec = {
      version: 11, op: 1, payload: billIssue(body),
      vout: [{ script: p2pkh(10) }, { script: custody(billPush) }, { script: custody(billPush) }],
    };

    test('ISSUE: vout[1] is the escrow bond; a stray custody-shaped vout[2] is a look-alike', () => {
      const dir = directory({ billIdByHash: (h) => (h === reverseHex(billPush) ? 12 : undefined) });
      const got = labels(issue, dir);
      expect(got[0]).toBeNull(); // the title, on the holder's key
      expect(got[1]).toMatchObject({ kind: 'bill_escrow', text: 'Bill 12 · escrow bond', bill_id: 12, link: '/bill/12' });
      expect(got[2]).toMatchObject({ kind: 'lookalike' });
    });

    test('ISSUE not connected yet: "new bill", no link', () => {
      expect(labels(issue)[1]).toMatchObject({ kind: 'bill_escrow', text: 'Bill escrow (new bill)', link: null });
    });

    test('ISSUE whose vout[1] does not push sha256 of the body: look-alike', () => {
      expect(texts({ ...issue, vout: [{ script: p2pkh(10) }, { script: custody(HOUSE3_PUSH) }] })).toEqual([null, LOOKALIKE]);
    });

    test('ISSUE with a payload cut short still tags vout[1] by position', () => {
      const tx = parseFreebankTx(rawTx({ ...issue, payload: Buffer.alloc(0) }));
      expect(coinTags(tx).map((t) => t?.kind ?? null)).toEqual(['bill_title', 'bill_escrow', null]);
      expect(custodyLabel(tx.vout[1].scriptpubkey, coinTags(tx)[1], directory())?.text).toEqual('Bill escrow bond');
    });

    test('ENDORSE and DISCOUNT create no custody (title and notes are claim coins)', () => {
      const endorse = parseFreebankTx(rawTx({ version: 11, op: 2, payload: new Writer().u32(12).buf(), vout: [{ script: p2pkh(11) }] }));
      expect(coinTags(endorse)).toEqual([{ kind: 'bill_title', billId: 12 }]);
      const discount = parseFreebankTx(rawTx({ version: 11, op: 5, payload: billDiscount(12, 3, [60000, 30000]), vout: [{ script: p2pkh(12) }, { script: p2pkh(13) }, { script: p2pkh(14) }, { script: custody(billPush) }] }));
      expect(coinTags(discount).map((t) => t?.kind ?? null)).toEqual(['bill_title', 'note', 'note', null]);
      expect(coinTags(discount)[2]).toMatchObject({ houseId: 3, units: 30000 });
    });

    test('RETIRE, CLAIM, HRETIRE, HCLAIM, RECOURSE tag nothing', () => {
      for (const op of [3, 4, 6, 7, 8]) {
        expect(texts({ version: 11, op, payload: new Writer().u32(12).buf(), vout: [{ script: custody(billPush) }] })).toEqual([LOOKALIKE]);
      }
    });
  });

  describe('pools (v15): ApplyPoolCoinTags', () => {
    const reserves = (priorOrNew: number): (string | null)[] => [`Pool 2 · note reserve (${priorOrNew.toLocaleString('en-US')} units)`, 'Pool 2 · ECX reserve'];
    const escrowPair = [{ script: custody(POOL2_PUSH) }, { script: custody(POOL2_PUSH) }];

    test('CREATE: vout[0] note reserve, vout[1] ECX reserve; LP shares and note change are claim coins', () => {
      const got = labels({ version: 15, op: 1, payload: poolCreate(2, 5000, 5000, 300), vout: [...escrowPair, { script: p2pkh(15) }, { script: p2pkh(16) }] });
      expect(got.map((l) => l?.text ?? null)).toEqual([...reserves(5000), null, null]);
      expect(got[0]).toMatchObject({ kind: 'pool_note_reserve', pool_id: 2, units: 5000, link: '/pool/2' });
      expect(got[1]).toMatchObject({ kind: 'pool_ecx_reserve', pool_id: 2, link: '/pool/2' });
    });

    test('ADD_LIQ: the note reserve grows by the notes added', () => {
      expect(texts({ version: 15, op: 2, payload: poolAdd(2, 5000, 1000, 0), vout: [...escrowPair, { script: p2pkh(17) }] })).toEqual([...reserves(6000), null]);
    });

    test('REMOVE_LIQ: the note reserve shrinks by the notes paid out', () => {
      expect(texts({ version: 15, op: 3, payload: poolRemove(2, 6000, 600, 500, 10), vout: [...escrowPair, { script: p2pkh(18) }, { script: p2pkh(19) }, { script: p2pkh(20) }] }))
        .toEqual([...reserves(5400), null, null, null]);
      const tx = parseFreebankTx(rawTx({ version: 15, op: 3, payload: poolRemove(2, 6000, 0, 500, 10), vout: [...escrowPair, { script: p2pkh(18) }, { script: p2pkh(19) }] }));
      expect(coinTags(tx).map((t) => t?.kind ?? null)).toEqual(['pool_note_reserve', 'pool_ecx_reserve', null, 'lp_share']);
    });

    test('REMOVE_LIQ paying out more notes than the reserve holds tags nothing (the node rejects it)', () => {
      expect(texts({ version: 15, op: 3, payload: poolRemove(2, 100, 600, 0, 0), vout: escrowPair })).toEqual([LOOKALIKE, LOOKALIKE]);
    });

    test('SWAP notes for ECX: reserve + notes in; SWAP ECX for notes: reserve - notes out', () => {
      expect(texts({ version: 15, op: 4, payload: poolSwap(2, 5000, 1, 100, 95, 0), vout: [...escrowPair, { script: p2pkh(21) }] })).toEqual([...reserves(5100), null]);
      expect(texts({ version: 15, op: 4, payload: poolSwap(2, 5000, 2, 50, 53, 0), vout: [...escrowPair, { script: p2pkh(22) }] })).toEqual([...reserves(4947), null]);
    });

    test('a retired pool (not in listpools) has no page to link', () => {
      const got = labels({ version: 15, op: 1, payload: poolCreate(2, 5000, 5000, 0), vout: escrowPair }, directory({ poolListed: () => false }));
      expect(got[0]).toMatchObject({ text: 'Pool 2 · note reserve (5,000 units)', link: null });
    });

    test('RETIRE re-issues nothing: custody-shaped outputs are look-alikes', () => {
      expect(texts({ version: 15, op: 5, payload: poolRetire(2), vout: escrowPair })).toEqual([LOOKALIKE, LOOKALIKE]);
    });

    test('a pool output with another pool\'s escrow script: look-alike', () => {
      expect(texts({ version: 15, op: 1, payload: poolCreate(2, 5000, 5000, 0), vout: [{ script: custody(poolEscrowPush(3)) }, { script: custody(POOL2_PUSH) }] }))
        .toEqual([LOOKALIKE, 'Pool 2 · ECX reserve']);
    });
  });

  describe('oracle (v17)', () => {
    test('BOND: vout[0] is the bond; a new submitter is numbered from listoraclesubmitters', () => {
      const got = labels({ version: 17, op: 1, payload: oracleBond(0, pubkey(0x44)), vout: [{ script: custody(pubkey(0x44)) }, { script: p2pkh(23) }] });
      expect(got[0]).toMatchObject({ kind: 'oracle_bond', text: 'Oracle bond · submitter 4', submitter_id: 4, link: '/gold' });
      expect(got[1]).toBeNull();
      expect(texts({ version: 17, op: 1, payload: oracleBond(0, pubkey(0x45)), vout: [{ script: custody(pubkey(0x45)) }] })).toEqual(['Oracle bond (new submitter)']);
      expect(texts({ version: 17, op: 1, payload: oracleBond(6, pubkey(0x45)), vout: [{ script: custody(pubkey(0x45)) }] })).toEqual(['Oracle bond · submitter 6']);
    });

    test('BOND whose vout[0] holds another key: look-alike; SUBMIT tags nothing', () => {
      expect(texts({ version: 17, op: 1, payload: oracleBond(0, pubkey(0x44)), vout: [{ script: custody(pubkey(0x46)) }] })).toEqual([LOOKALIKE]);
      expect(texts({ version: 17, op: 2, payload: oracleSubmit(4), vout: [{ script: custody(pubkey(0x44)) }] })).toEqual([LOOKALIKE]);
    });
  });

  describe('transactions that tag nothing', () => {
    test('a plain v3 transaction: every custody shape is a look-alike', () => {
      const got = labels({ version: 3, vout: [{ script: custody(HOUSE3_PUSH) }, { script: custody('11'.repeat(20)) }, { script: custody(pubkey(0x44)) }, { script: p2pkh(24) }] });
      expect(got.map((l) => l?.kind ?? null)).toEqual(['lookalike', 'lookalike', 'lookalike', null]);
      expect(got[0]?.tooltip).toMatch(/anyone can spend/);
    });

    test('a coinbase', () => {
      expect(texts({ version: 3, vin: [{ txid: COINBASE_TXID, vout: 0xffffffff }], vout: [{ script: custody(HOUSE3_PUSH) }, { script: p2pkh(25) }] }))
        .toEqual([LOOKALIKE, null]);
    });

    test('a settlement (v16)', () => {
      expect(texts({ version: 16, op: 1, payload: Buffer.alloc(8), vout: [{ script: custody(HOUSE3_PUSH) }] })).toEqual([LOOKALIKE]);
    });
  });
});

// ---- the spike chain's own transactions and RPC answers ----

interface CreditFixture {
  txid: string;
  family: string;
  op_name: string;
  hex: string;
}

const credit: CreditFixture[] = fixtures.credit;
const spikeDirectory = buildDirectory(rpc.listhouses, rpc.listbills, rpc.listpools, rpc.listoraclesubmitters);
const byKind = (family: string, opName: string): CreditFixture[] => credit.filter((t) => t.family === family && t.op_name === opName);

function spikeLabels(t: { hex: string }): (CustodyLabel | null)[] {
  const tx = parseFreebankTx(t.hex);
  const tags = coinTags(tx);
  return tx.vout.map((o, n) => custodyLabel(o.scriptpubkey, tags[n], spikeDirectory));
}

describe('FreeBank custody on the spike chain', () => {
  test('house REGISTER: the hash from the declaration is listhouses\' househash, and the pledge script pushes it', () => {
    const registers = byKind('house', 'register');
    expect(registers.length).toEqual(3);
    for (const t of registers) {
      const house = rpc.listhouses.find((h: any) => h.txidregister === t.txid);
      const tx = parseFreebankTx(t.hex);
      const tag = coinTags(tx)[0] as CoinTag;
      expect(tag.houseHash).toEqual(house.househash);
      expect(custodyPush(tx.vout[0].scriptpubkey)).toEqual(reverseHex(house.househash));
      expect(tag.partnerPubkey).toEqual(house.partners[0].pubkey);
      expect(spikeLabels(t)[0]).toMatchObject({ kind: 'house_pledge', text: `House ${house.id} · pledge (partner 0)`, link: `/house/${house.id}` });
    }
  });

  test('bill ISSUE: sha256 of the body is listbills\' bill_id, and the escrow bond at vout[1] pushes it', () => {
    const issues = byKind('bill', 'issue');
    expect(issues.length).toEqual(5);
    for (const t of issues) {
      const bill = rpc.listbills.find((b: any) => b.issue_txid === t.txid);
      expect(bill.escrow_outpoint).toEqual(`${t.txid}:1`);
      const tx = parseFreebankTx(t.hex);
      expect((coinTags(tx)[1] as CoinTag).billHash).toEqual(bill.bill_id);
      expect(spikeLabels(t)[1]).toMatchObject({ kind: 'bill_escrow', text: `Bill ${bill.id} · escrow bond`, bill_id: bill.id, link: `/bill/${bill.id}` });
    }
  });

  test('pool CREATE and both SWAPs: the note reserve follows the payloads to listpools\' note_reserve', () => {
    const [create] = byKind('pool', 'create');
    expect(spikeLabels(create).slice(0, 2).map((l) => l?.text)).toEqual(['Pool 1 · note reserve (2,000,000 units)', 'Pool 1 · ECX reserve']);
    const swaps = byKind('pool', 'swap'); // notes for ECX (100,000 in), then ECX for notes (53,550 out)
    expect(spikeLabels(swaps[0])[0]?.text).toEqual('Pool 1 · note reserve (2,100,000 units)');
    const last = spikeLabels(swaps[1]);
    expect(last[0]).toMatchObject({ units: rpc.listpools[0].note_reserve, text: 'Pool 1 · note reserve (2,046,450 units)' });
    expect(swaps[1].txid).toEqual(rpc.listpools[0].note_escrow_txid);
  });

  test('oracle BONDs: each submitter numbered by its key', () => {
    const bonds = byKind('oracle', 'bond');
    for (const t of bonds) {
      const submitter = rpc.listoraclesubmitters.find((s: any) => s.bondtxid === t.txid);
      expect(spikeLabels(t)[0]).toMatchObject({ kind: 'oracle_bond', text: `Oracle bond · submitter ${submitter.id}`, link: '/gold' });
    }
  });

  test('every custody-shaped output on the chain is a real custody coin (the chain has no look-alikes), and nothing else is labelled', () => {
    let custodyOutputs = 0;
    for (const t of [...credit, ...fixtures.other]) {
      const tx = parseFreebankTx(t.hex);
      spikeLabels(t).forEach((label, n) => {
        const shaped = custodyPush(tx.vout[n].scriptpubkey) !== null;
        expect(label !== null).toEqual(shaped);
        if (label) {
          custodyOutputs++;
          expect(label.kind).not.toEqual('lookalike');
        }
      });
    }
    // 3 pledges + 5 bill bonds + 3 pool pairs + 3 oracle bonds
    expect(custodyOutputs).toEqual(3 + 5 + 3 * 2 + 3);
  });
});

// ---- the resolver behind GET /api/v1/freebank/custody ----

function fakeNode(txs: { txid: string, hex: string }[], calls: string[] = []): CustodyNode {
  const byId = new Map(txs.map((t) => [t.txid, t.hex]));
  return {
    getTip: async () => ({ height: 454, hash: 'ff'.repeat(32) }),
    getRawTransaction: async (txid) => {
      calls.push(`tx:${txid}`);
      return byId.get(txid) ?? null;
    },
    listHouses: async () => {
      calls.push('listhouses');
      return rpc.listhouses;
    },
    listBills: async () => rpc.listbills,
    listPools: async () => rpc.listpools,
    listOracleSubmitters: async () => rpc.listoraclesubmitters,
  };
}

describe('FreeBank custody resolver', () => {
  const all = [...credit, ...fixtures.other];

  test('pool SWAP inputs: the coins they spend are the pool\'s reserves, as the funding txs left them', async () => {
    const [create] = byKind('pool', 'create');
    const swaps = byKind('pool', 'swap');
    const custody = new FreebankCustody(fakeNode(all));
    const res = await custody.$getCustody([swaps[0].txid, swaps[1].txid]);
    expect(res.tip_height).toEqual(454);
    const first = res.txs[swaps[0].txid];
    expect(parseFreebankTx(swaps[0].hex).vin[0].txid).toEqual(create.txid);
    expect(first?.vin.slice(0, 2).map((l) => l?.text)).toEqual(['Pool 1 · note reserve (2,000,000 units)', 'Pool 1 · ECX reserve']);
    expect(first?.vout.slice(0, 2).map((l) => l?.text)).toEqual(['Pool 1 · note reserve (2,100,000 units)', 'Pool 1 · ECX reserve']);
    expect(res.txs[swaps[1].txid]?.vin[0]).toMatchObject({ kind: 'pool_note_reserve', units: 2100000, link: '/pool/1' });
  });

  test('a plain tx and a coinbase: no labels; an unknown txid: null', async () => {
    const custody = new FreebankCustody(fakeNode(all));
    const [plain, , coinbase] = fixtures.other;
    const unknown = '12'.repeat(32);
    const res = await custody.$getCustody([plain.txid, coinbase.txid, unknown]);
    const plainTx = parseFreebankTx(plain.hex);
    expect(res.txs[plain.txid]).toEqual({ vin: plainTx.vin.map(() => null), vout: plainTx.vout.map(() => null) });
    expect(res.txs[coinbase.txid]?.vin).toEqual([null]);
    expect(res.txs[coinbase.txid]?.vout.every((l) => l === null)).toBe(true);
    expect(res.txs[unknown]).toBeNull();
  });

  test('credit RPCs are read once per tip, and only when a custody-shaped script turns up', async () => {
    const calls: string[] = [];
    const custody = new FreebankCustody(fakeNode(all, calls));
    await custody.$getCustody([fixtures.other[0].txid]);
    expect(calls.filter((c) => c === 'listhouses')).toEqual([]);
    const [register] = byKind('house', 'register');
    await custody.$getCustody([register.txid]);
    await custody.$getCustody([register.txid]);
    expect(calls.filter((c) => c === 'listhouses')).toEqual(['listhouses']);
    // parsed txs are kept: the second ask read no tx again
    expect(calls.filter((c) => c === `tx:${register.txid}`)).toEqual([`tx:${register.txid}`]);
  });

  test(`inputs past the first ${CUSTODY_MAX_INPUTS} are not looked up`, async () => {
    const [create] = byKind('pool', 'create');
    const vin = Array.from({ length: CUSTODY_MAX_INPUTS + 2 }, (_, i) => ({ txid: create.txid, vout: i % 2 }));
    const big = rawTx({ version: 3, vin, vout: [{ script: p2pkh(26) }] });
    const bigTxid = parseFreebankTx(big).txid;
    const custody = new FreebankCustody(fakeNode([...all, { txid: bigTxid, hex: big }]));
    const res = await custody.$getCustody([bigTxid]);
    const entry = res.txs[bigTxid];
    expect(entry?.truncated).toBe(true);
    expect(entry?.vin.length).toEqual(CUSTODY_MAX_INPUTS + 2);
    // a plain tx spending the pool's escrow coins: the coins carry their tags; the tx is only
    // invalid, but the labels describe the coins
    expect(entry?.vin[0]?.text).toEqual('Pool 1 · note reserve (2,000,000 units)');
    expect(entry?.vin[CUSTODY_MAX_INPUTS]).toBeNull();
  });

  test('a node error rejects (the route answers 500)', async () => {
    const node = fakeNode(all);
    node.getRawTransaction = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(new FreebankCustody(node).$getCustody([fixtures.other[0].txid])).rejects.toThrow('ECONNREFUSED');
  });
});
