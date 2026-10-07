import {
  ByteReader, creditOpName, decodeCreditPayload, FreebankParseError, parseFreebankTx,
} from '../../api/freebank/freebank-tx-parser';

// Real transactions from the explorer spike's FreeBank regtest chain (getblock <hash> 2):
// every credit tx on that chain (v11-v17: 34 txs, 13 kinds of op), plus a plain v3 tx
// without witness, a v3 segwit spend and a segwit coinbase. txid / wtxid are the node's.
const fixtures = require('./test-data/freebank-txs.json');

interface CreditFixture {
  txid: string;
  height: number;
  version: number;
  family: string;
  op: number;
  op_name: string;
  decoded: { [field: string]: any };
  hex: string;
}

const credit: CreditFixture[] = fixtures.credit;
const byKind = (family: string, opName: string): CreditFixture[] => credit.filter((t) => t.family === family && t.op_name === opName);

describe('FreeBank tx parser', () => {
  describe('credit transactions (v11-v17)', () => {
    test('covers every credit family', () => {
      const families = new Set(credit.map((t) => t.family));
      expect([...families].sort()).toEqual(['bill', 'deposit', 'house', 'note', 'oracle', 'pool', 'settle']);
    });

    test.each(credit.map((t): [string, CreditFixture] => [`${t.family} ${t.op_name} at ${t.height} (${t.txid.slice(0, 12)})`, t]))(
      '%s: txid, version, op and payload',
      (_label, t) => {
        const tx = parseFreebankTx(t.hex);
        // the txid is sha256d of the no-witness serialization INCLUDING the credit trailer
        expect(tx.txid).toEqual(t.txid);
        expect(tx.version).toEqual(t.version);
        expect(tx.replayByte).toBeNull(); // only v3 carries the replay byte
        expect(tx.family).toEqual(t.family);
        expect(tx.op).toEqual(t.op);
        expect(creditOpName(tx.family as any, tx.op as number)).toEqual(t.op_name);
        expect(tx.payload).not.toBeNull();
        expect(tx.size).toEqual(t.hex.length / 2);
        expect(decodeCreditPayload(tx.family, tx.op, tx.payload)).toEqual(t.decoded);
      },
    );

    test('accepts a Buffer as well as hex', () => {
      const t = credit[0];
      expect(parseFreebankTx(Buffer.from(t.hex, 'hex')).txid).toEqual(t.txid);
    });
  });

  describe('decoded payloads match the node\'s own records', () => {
    test('v16 settle exchange: both houses, both note amounts, the residual and its direction', () => {
      const [settle] = byKind('settle', 'exchange');
      const tx = parseFreebankTx(settle.hex);
      expect(decodeCreditPayload(tx.family, tx.op, tx.payload)).toEqual({
        house_a_id: 1,
        house_b_id: 2,
        mode: 1,
        house_a_notes_units: 60000,
        house_b_notes_units: 45000,
        residual_sats: 15000, // = 60000 - 45000: par, no spread
        debtor_house_id: 1, // more of house 1's paper came home
        creditor_house_id: 2,
        expiry_height: 140,
      });
    });

    test('v12 house register carries the class ids listhouses reports', () => {
      const classids = byKind('house', 'register').map((t) => {
        const tx = parseFreebankTx(t.hex);
        return decodeCreditPayload(tx.family, tx.op, tx.payload).classid;
      });
      expect(classids).toEqual(['hone', 'htwo', 'hthree']);
    });

    test('v12 house attest: reserves equal gethouse lastattestreserves (27.675566 ECX at 452)', () => {
      const attest = byKind('house', 'attest').find((t) => t.height === 452) as CreditFixture;
      const tx = parseFreebankTx(attest.hex);
      expect(decodeCreditPayload(tx.family, tx.op, tx.payload)).toEqual({ house_id: 1, as_of_height: 451, reserves_sats: 2767556600 });
    });

    test('v11 bill discount: bill 3 into house 1\'s loan book, as listloanbook shows', () => {
      const [discount] = byKind('bill', 'discount');
      const tx = parseFreebankTx(discount.hex);
      expect(decodeCreditPayload(tx.family, tx.op, tx.payload)).toEqual({
        bill_id: 3, house_id: 1, price_units: 90000000, face_sats: 100000000, maturity_height: 519,
      });
    });

    test('v17 oracle submits at 113: the three prices whose median is the gold fix', () => {
      const prices = byKind('oracle', 'submit').filter((t) => t.height === 113).map((t) => {
        const tx = parseFreebankTx(t.hex);
        return decodeCreditPayload(tx.family, tx.op, tx.payload).price_mg;
      });
      expect(prices.sort()).toEqual([790000000, 800000000, 810000000]); // getgoldfix raw 800000000
    });

    test('v15 pool swaps in both directions', () => {
      const directions = byKind('pool', 'swap').map((t) => {
        const tx = parseFreebankTx(t.hex);
        return decodeCreditPayload(tx.family, tx.op, tx.payload).direction;
      });
      expect(directions).toEqual(['notes_for_ecx', 'ecx_for_notes']);
    });
  });

  describe('other transactions', () => {
    test.each<[string, any]>(fixtures.other.map((t: any): [string, any] => [`v${t.version}${t.has_witness ? ' with witness' : ''} at ${t.height}`, t]))(
      '%s: txid, wtxid, size and output values',
      (_label, t: any) => {
        const tx = parseFreebankTx(t.hex);
        expect(tx.txid).toEqual(t.txid);
        expect(tx.wtxid).toEqual(t.wtxid);
        expect(tx.version).toEqual(3);
        expect(tx.replayByte).toEqual(0x3f);
        expect(tx.hasWitness).toEqual(t.has_witness);
        expect(tx.size).toEqual(t.size);
        expect(tx.vout.map((o) => o.value)).toEqual(t.output_values);
        expect(tx.family).toBeNull();
        expect(tx.op).toBeNull();
        expect(decodeCreditPayload(tx.family, tx.op, tx.payload)).toEqual({});
      },
    );

    test('a segwit tx: the txid leaves out marker, flag and witness; the wtxid does not', () => {
      const t = fixtures.other.find((o: any) => o.has_witness);
      const tx = parseFreebankTx(t.hex);
      expect(tx.strippedSize).toBeLessThan(tx.size);
      expect(tx.txid).not.toEqual(tx.wtxid);
      expect(tx.vin.some((i) => i.witness.length > 0)).toBe(true);
    });
  });

  describe('v0.2.18 transactions (ecash/credit-cycle.sh on the v0.2.18 release)', () => {
    const v0218: { label: string, txid: string, version: number, hex: string, asset_genesis: any }[] = require('./test-data/freebank-v0218-txs.json').txs;
    const get = (label: string): any => v0218.find((t) => t.label === label);

    test.each(v0218.map((t): [string, any] => [t.label, t]))('%s: txid and the whole tx read', (_label, t) => {
      const tx = parseFreebankTx(t.hex);
      expect(tx.txid).toEqual(t.txid);
      expect(tx.version).toEqual(t.version);
    });

    test('an asset genesis (v10) carries the decimals byte after the payload', () => {
      const t = get('asset-gold');
      const tx = parseFreebankTx(t.hex);
      expect(tx.bitasset).toEqual({
        ticker: 'GOLD', headline: t.asset_genesis.headline, payload: t.asset_genesis.payload, decimals: 3,
      });
      expect(tx.vout[1].value).toEqual(t.asset_genesis.supply);
    });

    test('note demands decode their mode (0 plain, 1 pre-authorised, 2 queue) and an upgrade its prior height', () => {
      const mode = (label: string): any => {
        const tx = parseFreebankTx(get(label).hex);
        const d = decodeCreditPayload(tx.family, tx.op, tx.payload);
        return [d.demand_mode, d.prior_demand_height];
      };
      expect(mode('demand-plain-b')).toEqual(['plain', 0]);
      expect(mode('demand-preauth')).toEqual(['preauth', 0]);
      expect(mode('demand-queue')).toEqual(['preauth_queue', 0]);
      const [upgrade, prior] = mode('demand-upgrade-d');
      expect(upgrade).toEqual('preauth_queue');
      expect(prior).toBeGreaterThan(0);
    });
  });

  describe('v0.2.20 token records (note.h NoteLock / NoteUnlock layouts)', () => {
    const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const vec = (items: Buffer[]): Buffer => Buffer.concat([Buffer.from([items.length]), ...items]);
    const bytes = (hex: string): Buffer => Buffer.concat([Buffer.from([hex.length / 2]), Buffer.from(hex, 'hex')]);

    test('LOCK, the mint record: units into the backing, the change notes', () => {
      const payload = Buffer.concat([u32(3), u64(500000), vec([u64(1000), u64(2000)]), bytes('02' + 'ab'.repeat(32)), bytes('30' + '00'.repeat(70)),
        vec([u32(0)]), vec([bytes('30' + '11'.repeat(70))])]);
      expect(decodeCreditPayload('note', 4, payload)).toEqual({ house_id: 3, units: 500000, change_units: 3000, outputs: 2 });
      expect(creditOpName('note', 4)).toEqual('lock');
    });

    test('UNLOCK, the burn record: the backing released as note coins', () => {
      const payload = Buffer.concat([u32(3), vec([u64(300000), u64(100000)]), vec([u32(0)]), vec([bytes('30' + '22'.repeat(70))])]);
      expect(decodeCreditPayload('note', 5, payload)).toEqual({ house_id: 3, units: 400000, outputs: 2 });
      expect(creditOpName('note', 5)).toEqual('unlock');
    });
  });

  describe('v0.2.21 token claim ops (token.h layouts)', () => {
    const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
    const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n: number | bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const vec = (items: Buffer[]): Buffer => Buffer.concat([Buffer.from([items.length]), ...items]);
    const bytes = (len: number, fill = 1): Buffer => Buffer.concat([Buffer.from([len]), Buffer.alloc(len, fill)]);
    const approvals = Buffer.concat([vec([u32(0)]), vec([bytes(71)])]);

    test('TOKEN_KEYSET: the keys and the largest amount', () => {
      const keys = [0, 1, 2, 10].map((e) => Buffer.concat([Buffer.from([e]), bytes(33)]));
      const payload = Buffer.concat([u32(2), bytes(33), vec(keys), approvals]);
      expect(decodeCreditPayload('note', 9, payload)).toEqual({ house_id: 2, keys: 4, largest_amount: 1024 });
      expect(creditOpName('note', 9)).toEqual('token_keyset');
    });

    test('TOKEN_POST: keyset id as gettokenclaims prints it, issued units, spent count; the payload is left as it was', () => {
      const issued = [Buffer.concat([bytes(33), u64(64)]), Buffer.concat([bytes(33), u64(8)])];
      const spent = [Buffer.alloc(32, 7), Buffer.alloc(32, 8), Buffer.alloc(32, 9)];
      const payload = Buffer.concat([u32(2), u64(0x0123456789abcdefn), vec(issued), vec(spent), bytes(64)]);
      const before = Buffer.from(payload);
      expect(decodeCreditPayload('note', 10, payload)).toEqual({ house_id: 2, keyset_id: '0123456789abcdef', issued: 2, issued_units: 72, spent: 3 });
      expect(payload.equals(before)).toBe(true);
    });

    test('TOKEN_CLAIM: tokens and claimed units', () => {
      const entry = (amount: number): Buffer => Buffer.concat([u64(1), u64(amount), bytes(64), bytes(33), bytes(33), bytes(32), bytes(32),
        bytes(25), u16(100), bytes(25), bytes(64)]);
      const payload = Buffer.concat([u32(2), vec([entry(32), entry(4)])]);
      expect(decodeCreditPayload('note', 11, payload)).toEqual({ house_id: 2, tokens: 2, claimed_units: 36 });
    });

    test('TOKEN_COLLECT: claims paid, escrow change', () => {
      const payload = Buffer.concat([u32(2), Buffer.from([1]), vec([Buffer.alloc(32, 1), Buffer.alloc(32, 2)])]);
      expect(decodeCreditPayload('note', 12, payload)).toEqual({ house_id: 2, claims: 2, escrow_change: true });
      expect(creditOpName('note', 12)).toEqual('token_collect');
    });
  });

  describe('malformed input', () => {
    const settleHex: string = byKind('settle', 'exchange')[0].hex;

    test('truncated tx throws FreebankParseError', () => {
      expect(() => parseFreebankTx(settleHex.slice(0, settleHex.length - 2))).toThrow(FreebankParseError);
      expect(() => parseFreebankTx('10000000')).toThrow(FreebankParseError);
    });

    test('trailing bytes throw', () => {
      expect(() => parseFreebankTx(settleHex + '00')).toThrow(/trailing/);
    });

    test('non-hex input throws', () => {
      expect(() => parseFreebankTx('zz')).toThrow(FreebankParseError);
      expect(() => parseFreebankTx('abc')).toThrow(FreebankParseError);
    });

    test('a payload that does not fit its layout decodes to {} instead of throwing', () => {
      expect(decodeCreditPayload('settle', 1, Buffer.from('0100', 'hex'))).toEqual({});
      expect(decodeCreditPayload('house', 7, Buffer.alloc(0))).toEqual({});
      expect(decodeCreditPayload('settle', 2, Buffer.alloc(64))).toEqual({}); // reserved op
      expect(decodeCreditPayload(null, null, null)).toEqual({});
    });

    test('unknown op bytes get a neutral name', () => {
      expect(creditOpName('house', 7)).toEqual('attest');
      expect(creditOpName('pool', 2)).toEqual('add_liq');
      expect(creditOpName('settle', 9)).toEqual('op_9');
    });
  });

  describe('ByteReader', () => {
    test('compact sizes: canonical encodings only', () => {
      expect(new ByteReader(Buffer.from('fc', 'hex')).compactSize()).toEqual(0xfc);
      expect(new ByteReader(Buffer.from('fdfd00', 'hex')).compactSize()).toEqual(0xfd);
      expect(() => new ByteReader(Buffer.from('fd1000', 'hex')).compactSize()).toThrow(/non-canonical/);
      expect(() => new ByteReader(Buffer.from('fe00000003', 'hex')).compactSize()).toThrow(/too large/);
    });

    test('64-bit values as numbers, signed and unsigned', () => {
      expect(new ByteReader(Buffer.from('00e1f50500000000', 'hex')).u64()).toEqual(100000000);
      expect(new ByteReader(Buffer.from('ffffffffffffffff', 'hex')).i64()).toEqual(-1);
    });
  });
});
