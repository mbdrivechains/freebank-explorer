import { parsePegOutput, parsePegOutputs, readDepositHead } from '../../../api/freebank/peg-parser';
import { PegBundleRecord, PegDepositRecord, PegWithdrawalObject } from '../../../api/freebank/peg.interfaces';
import {
  bitcoinTxid, bundleScript, commitScript, cusfFeeScript, depositScript, display, hash32, i32, legacyFeeScript,
  P2PKH, P2WPKH, refundRequestScript, sha256d, TxSpec, txBytes, withdrawalObject,
} from './peg-builders';

// Real deposit records from the explorer spike's chain (see the fixture's `source`)
const real = require('../test-data/freebank-peg-coinbases.json');

const ECASH_BLOCK = hash32('ecash block');

describe('FreeBank peg parser', () => {
  describe('real deposit records (spike chain)', () => {
    test.each<[number, any]>(real.coinbases.map((c: any): [number, any] => [c.height, c]))('block %i: every field of the record', (_h, c: any) => {
      const record = parsePegOutput(c.vout[c.expected.record_vout].scriptpubkey, c.expected.record_vout, true) as PegDepositRecord;
      expect(record.kind).toEqual('deposit');
      expect(record).toMatchObject({
        vout: c.expected.record_vout,
        slot: 130,
        dest: c.expected.dest,
        amount: c.expected.amount,
        ecash_txid: c.expected.ecash_txid,
        ecash_block: c.expected.ecash_block,
        ecash_tx_index: c.expected.ecash_tx_index,
        burn_index: c.expected.burn_index,
        treasury_value: c.expected.treasury_value,
        bundle_payment: false,
      });
      expect(record.ecash_outputs).toBeUndefined();
      expect(readDepositHead(c.vout[c.expected.record_vout].scriptpubkey)).toEqual({ slot: 130, dest: c.expected.dest, amount: c.expected.amount });
    });

    test('the second deposit: the record holds what it added, the dtx the treasury after it', () => {
      const [first, second] = real.coinbases;
      expect(second.expected.treasury_value).toEqual(first.expected.treasury_value + second.expected.amount);
    });

    test('the other coinbase outputs are not peg outputs (commitments of other kinds, payouts, witness)', () => {
      const [c] = real.coinbases;
      const kinds = parsePegOutputs(c.vout, true).map((o) => o.kind);
      expect(kinds).toEqual(['deposit']);
    });
  });

  describe('deposit records (built from sidechain.h)', () => {
    const dtx: TxSpec = {
      version: 2,
      vin: [{ txid: hash32('prev ctip'), vout: 0 }, { txid: hash32('funding'), vout: 3 }],
      vout: [{ value: 25_000, scriptpubkey: P2WPKH('change') }, { value: 0, scriptpubkey: '6a' }, { value: 7_000_000_000, scriptpubkey: 'b7018251' }],
    };

    test('a segwit mainchain tx: the eCash txid leaves the witness out', () => {
      const segwit: TxSpec = { ...dtx, vin: dtx.vin!.map((i) => ({ ...i, witness: ['3044' + '00'.repeat(70), '02' + '11'.repeat(32)] })) };
      const record = parsePegOutput(depositScript({ dest: 'fbk1qdest', amount: 2_000_000_000, dtx: segwit, burn: 2, ntx: 7, block: ECASH_BLOCK }), 5, true) as PegDepositRecord;
      expect(record.ecash_txid).toEqual(bitcoinTxid(segwit));
      expect(record.ecash_txid).not.toEqual(display(sha256d(txBytes(segwit)))); // not the wtxid
      expect(record).toMatchObject({ dest: 'fbk1qdest', amount: 2_000_000_000, burn_index: 2, ecash_tx_index: 7, ecash_block: ECASH_BLOCK, treasury_value: 7_000_000_000 });
    });

    test('a version-3 mainchain tx carrying FreeBank\'s replay byte: the eCash txid leaves it out', () => {
      const v3: TxSpec = { ...dtx, version: 3, replay: 0x3f };
      const record = parsePegOutput(depositScript({ dest: 'fbk1qdest', amount: 1, dtx: v3, burn: 2, block: ECASH_BLOCK }), 1, true) as PegDepositRecord;
      expect(record.ecash_txid).toEqual(bitcoinTxid(v3));
      expect(record.treasury_value).toEqual(7_000_000_000);
    });

    test('the bundle payment ("D" destination): the eCash tx is the M6, its outputs are kept', () => {
      const m6: TxSpec = { version: 2, vin: [{ txid: hash32('ctip'), vout: 0 }], vout: [{ value: 5_000_000_000, scriptpubkey: 'b7018251' }, { value: 900_000, scriptpubkey: P2WPKH('a') }] };
      const record = parsePegOutput(depositScript({ dest: 'D', amount: 0, dtx: m6, burn: 0, block: ECASH_BLOCK }), 3, true) as PegDepositRecord;
      expect(record.bundle_payment).toBe(true);
      expect(record.ecash_txid).toEqual(bitcoinTxid(m6));
      expect(record.ecash_outputs).toEqual(m6.vout);
      expect(record.treasury_value).toEqual(5_000_000_000);
    });

    test('the bundle payment may carry a negative amount (the node accepts it); a positive one is a deposit to "D"', () => {
      const m6: TxSpec = { version: 2, vin: [{ txid: hash32('ctip'), vout: 0 }], vout: [{ value: 5_000_000_000, scriptpubkey: 'b7018251' }] };
      const negative = parsePegOutput(depositScript({ dest: 'D', amount: -3_000_000, dtx: m6, burn: 0, block: ECASH_BLOCK }), 3, true) as PegDepositRecord;
      expect(negative).toMatchObject({ amount: -3_000_000, bundle_payment: true });
      const zero = parsePegOutput(depositScript({ dest: 'D', amount: 0, dtx: m6, burn: 0, block: ECASH_BLOCK }), 3, true) as PegDepositRecord;
      expect(zero.bundle_payment).toBe(true);
      const positive = parsePegOutput(depositScript({ dest: 'D', amount: 500_000_000, dtx: m6, burn: 0, block: ECASH_BLOCK }), 3, true) as PegDepositRecord;
      expect(positive).toMatchObject({ kind: 'deposit', dest: 'D', amount: 500_000_000, bundle_payment: false });
      expect(positive.ecash_outputs).toBeUndefined();
    });

    test('a burn index past the outputs gives no treasury value', () => {
      const record = parsePegOutput(depositScript({ dest: 'x', amount: 5, dtx, burn: 9, block: ECASH_BLOCK }), 1, true) as PegDepositRecord;
      expect(record.treasury_value).toBeNull();
    });

    test('bytes after the fields are ignored, as the node does', () => {
      const record = parsePegOutput(depositScript({ dest: 'x', amount: 5, dtx, burn: 2, block: ECASH_BLOCK }) + 'ff00', 1, true);
      expect(record?.kind).toEqual('deposit');
    });

    test('outside a coinbase it is not a real deposit from eCash', () => {
      expect(parsePegOutput(depositScript({ dest: 'x', amount: 5, dtx, burn: 2, block: ECASH_BLOCK }), 2, false)).toEqual({
        kind: 'stray', vout: 2, object: 'deposit', note: 'not a real deposit from eCash (outside the coinbase)',
      });
    });
  });

  describe('withdrawal bundles', () => {
    const ids = [hash32('w1'), hash32('w2')];
    const payouts = [{ value: 900_000, scriptpubkey: P2WPKH('a') }, { value: 400_000, scriptpubkey: P2PKH('b') }];

    test('CUSF: fee in vout[0] (big-endian), payouts after it, m6id = txid without the input', () => {
      const tx: TxSpec = { version: 2, vin: [{ txid: '00'.repeat(32), vout: 0, scriptsig: '00' }], vout: [{ value: 0, scriptpubkey: cusfFeeScript(3000) }, ...payouts] };
      const record = parsePegOutput(bundleScript({ tx, ids }), 4, true) as PegBundleRecord;
      expect(record).toMatchObject({ kind: 'bundle', slot: 130, format: 'cusf', ecash_fee: 3000, total: 1_300_000, withdrawal_ids: ids });
      expect(record.bundle_hash).toEqual(bitcoinTxid(tx));
      expect(record.m6id).toEqual(bitcoinTxid({ ...tx, vin: [] }));
      expect(record.m6id).not.toEqual(record.bundle_hash);
      expect(record.payouts).toEqual([
        { vout: 1, ...payouts[0], withdrawal_id: ids[0] },
        { vout: 2, ...payouts[1], withdrawal_id: ids[1] },
      ]);
    });

    test('legacy: OP_RETURN "D" at vout[0], fee (little-endian) at vout[1], payouts from vout[2]', () => {
      const tx: TxSpec = { version: 2, vin: [{ txid: '00'.repeat(32), vout: 0, scriptsig: '00' }], vout: [{ value: 0, scriptpubkey: '6a0144' }, { value: 0, scriptpubkey: legacyFeeScript(2500) }, ...payouts] };
      const record = parsePegOutput(bundleScript({ tx, ids }), 4, true) as PegBundleRecord;
      expect(record).toMatchObject({ format: 'legacy', ecash_fee: 2500, total: 1_300_000 });
      expect(record.payouts.map((p) => p.vout)).toEqual([2, 3]);
      expect(record.payouts.map((p) => p.withdrawal_id)).toEqual(ids);
    });

    test('nHeight and nFailHeight are not read (the coinbase copy carries garbage)', () => {
      const tx: TxSpec = { version: 2, vin: [{ txid: '00'.repeat(32), vout: 0 }], vout: [{ value: 0, scriptpubkey: cusfFeeScript(1) }, payouts[0]] };
      const a = parsePegOutput(bundleScript({ tx, ids: [ids[0]], height: 5 }), 1, true);
      const b = parsePegOutput(bundleScript({ tx, ids: [ids[0]], height: 99 }), 1, true);
      expect(a).toEqual(b);
    });

    test('outside a coinbase it is still the bundle (the node takes a bundle from any tx)', () => {
      const tx: TxSpec = { version: 2, vin: [{ txid: '00'.repeat(32), vout: 0, scriptsig: '00' }], vout: [{ value: 0, scriptpubkey: cusfFeeScript(3000) }, payouts[0]] };
      expect(parsePegOutput(bundleScript({ tx, ids: [ids[0]] }), 1, false)).toEqual(parsePegOutput(bundleScript({ tx, ids: [ids[0]] }), 1, true));
      expect(parsePegOutput(bundleScript({ tx, ids: [ids[0]] }), 1, false)).toMatchObject({ kind: 'bundle', bundle_hash: bitcoinTxid(tx), withdrawal_ids: [ids[0]] });
    });
  });

  describe('withdrawals and refund requests', () => {
    test('a withdrawal: its id is the hash of the object with status "u"', () => {
      const w = withdrawalObject({ dest: 'ecash:qdest', refund: 'XRefund', amount: 1_000_000, fee: 3000 });
      const record = parsePegOutput(w.script, 1, false) as PegWithdrawalObject;
      expect(record).toEqual({
        kind: 'withdrawal', vout: 1, slot: 130, id: w.id, dest_raw: 'ecash:qdest', refund_dest: 'XRefund',
        amount: 1_000_000, ecash_fee: 3000, payout: 997_000,
      });
    });

    test('the id does not change with the stored status', () => {
      const spent = withdrawalObject({ dest: 'd', refund: 'r', amount: 10, fee: 1, status: 's' });
      const unspent = withdrawalObject({ dest: 'd', refund: 'r', amount: 10, fee: 1, status: 'u' });
      expect((parsePegOutput(spent.script, 0, false) as PegWithdrawalObject).id).toEqual(unspent.id);
    });

    test('a withdrawal in a coinbase is a real one (the node reads every tx of a block)', () => {
      const w = withdrawalObject({ dest: 'd', refund: 'r', amount: 10, fee: 1 });
      expect(parsePegOutput(w.script, 0, true)).toMatchObject({ kind: 'withdrawal', id: w.id });
    });

    test('a refund request names the withdrawal id, in any tx', () => {
      const id = hash32('withdrawal');
      expect(parsePegOutput(refundRequestScript(id), 0, false)).toEqual({ kind: 'refund-request', vout: 0, withdrawal_id: id });
      expect(parsePegOutput(refundRequestScript(id), 3, true)).toEqual({ kind: 'refund-request', vout: 3, withdrawal_id: id });
      expect(parsePegOutput(refundRequestScript(id).slice(0, -2), 0, false)).toBeNull(); // 101 bytes: not one
    });
  });

  describe('commitments', () => {
    test.each(['bundle-hash', 'bundle-paid', 'bundle-failed'] as const)('%s: the bundle hash, coinbase only', (kind) => {
      const hash = hash32(kind);
      expect(parsePegOutput(commitScript(kind, hash), 2, true)).toEqual({ kind, vout: 2, bundle_hash: hash });
      expect(parsePegOutput(commitScript(kind, hash), 2, false)).toBeNull();
    });

    test('a null hash is no commitment', () => {
      expect(parsePegOutput(commitScript('bundle-paid', '00'.repeat(32)), 0, true)).toBeNull();
    });
  });

  describe('garbage never throws', () => {
    const cases: [string, string][] = [
      ['a record cut short', depositScript({ dest: 'x', amount: 5, dtx: { vout: [{ value: 1, scriptpubkey: '51' }] }, burn: 0, block: ECASH_BLOCK }).slice(0, 60)],
      ['a record with a huge string length', '6aacdcf66f4482fe00000001'],
      ['a bundle cut inside its tx', '6aacdcf66f5082' + i32(2).toString('hex') + '05'],
      ['a withdrawal cut short', '6aacdcf66f5782036162'],
    ];
    test.each(cases)('%s is unreadable', (_label, script) => {
      const out = parsePegOutput(script, 0, !script.startsWith('6aacdcf66f57'));
      expect(out?.kind).toEqual('unreadable');
    });

    test('an unknown object type or a plain OP_RETURN is not a peg output', () => {
      expect(parsePegOutput('6aacdcf66f4182', 0, true)).toBeNull();
      expect(parsePegOutput('6a0474657374', 0, true)).toBeNull();
      expect(parsePegOutput('', 0, true)).toBeNull();
      expect(parsePegOutput(undefined as any, 0, true)).toBeNull();
      expect(readDepositHead('6aacdcf66f4482ff')).toBeNull();
    });
  });
});
