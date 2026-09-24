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
