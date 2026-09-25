import {
  $blockRefundsDue, coinbaseMayPayRefunds, CoinbaseOutput, freebankRewardExtras, RefundDue, RefundNode, sameAddress, splitFreebankCoinbase,
  unexpectedReward,
} from '../../../api/freebank/coinbase-split';
import { commitScript, depositScript, hash32, P2PKH, refundRequestScript, TxSpec } from './peg-builders';

// Real coinbases with a deposit from eCash (the explorer spike's chain)
const real = require('../test-data/freebank-peg-coinbases.json');

const ECASH_BLOCK = hash32('ecash block');
const DTX: TxSpec = { version: 2, vin: [{ txid: hash32('in'), vout: 0 }], vout: [{ value: 1, scriptpubkey: 'b7018251' }] };
const PRODUCER_P2PK = '2102e5447fbb19d0d014c3725c7458e79bdf49f8bc4bb45fb6b8c4e2c2d1a5fa0d7fac';

// The stock builder's zero-value outputs (miner.cpp)
const PREV_COMMIT: CoinbaseOutput = { value: 0, scriptpubkey: '6afd7ad1ef' + '11'.repeat(64) };
const VERSION_COMMIT: CoinbaseOutput = { value: 0, scriptpubkey: '6aa7e67e1f00000020' };
const WITNESS_COMMIT: CoinbaseOutput = { value: 0, scriptpubkey: '6a24aa21a9ed' + '22'.repeat(32) };

function record(dest: string, amount: number): CoinbaseOutput {
  return { value: 0, scriptpubkey: depositScript({ dest, amount, dtx: DTX, burn: 0, block: ECASH_BLOCK }) };
}

function pay(value: number, address: string): CoinbaseOutput {
  return { value, scriptpubkey: P2PKH(address), scriptpubkey_address: address };
}

function due(amount: number, dest: string, id = hash32('withdrawal ' + dest)): RefundDue {
  return { withdrawal_id: id, amount, dest };
}

// A FreeBank base58 address and a bech32 one, as the node spells them
const B58 = 'XDPTdcwkAe8ToyugJaNxU8BXoLcyUVaZK5';
const BECH = 'fbk1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

describe('FreeBank destination strings, as the node reads them (base58.cpp DecodeDestination)', () => {
  test.each<[string, string, string, boolean]>([
    ['base58, as spelled', B58, B58, true],
    ['base58, C whitespace at both ends is skipped', B58, ' \t' + B58 + '\n\r\v\f', true],
    ['base58, cut at the first NUL (c_str)', B58, B58 + '\0junk', true],
    ['base58, spaces then a NUL', B58, B58 + ' \0 junk', true],
    ['base58, whitespace inside is no address', B58, B58.slice(0, 10) + ' ' + B58.slice(10), false],
    ['base58, NBSP is not C whitespace', B58, B58 + '\u00a0', false],
    ['base58, U+FEFF is not C whitespace', B58, '\ufeff' + B58, false],
    ['base58, case matters', B58, B58.toLowerCase(), false],
    ['base58, nothing before the NUL', B58, '\0' + B58, false],
    ['bech32, as spelled', BECH, BECH, true],
    ['bech32, all capitals', BECH, BECH.toUpperCase(), true],
    ['bech32, mixed case is no address', BECH, 'FBK1' + BECH.slice(4), false],
    ['bech32, no whitespace skipped', BECH, BECH + ' ', false],
    ['bech32, no NUL cut', BECH, BECH + '\0', false],
    ['bech32, a KELVIN SIGN is not K (the node takes printable ASCII only)', BECH, BECH.toUpperCase().replace('K', '\u212a'), false],
    ['empty', B58, '', false],
  ])('%s', (_name, output, dest, want) => {
    expect(sameAddress(output, dest)).toBe(want);
  });

  test('no output address, no match', () => {
    expect(sameAddress(undefined, B58)).toBe(false);
    expect(sameAddress(null, B58)).toBe(false);
  });
});

describe('FreeBank coinbase split', () => {
  test('the live beta tip: four zero outputs, nothing earned', () => {
    const split = splitFreebankCoinbase([{ value: 0, scriptpubkey: PRODUCER_P2PK }, PREV_COMMIT, VERSION_COMMIT, WITNESS_COMMIT]);
    expect(split).toMatchObject({ total: 0, producerAmt: 0, pegInCount: 0, pegInAmt: 0, pegInFees: 0, refundCount: 0, refundAmt: 0, pegRecords: 0 });
  });

  test('fees only: the producer earns them', () => {
    const split = splitFreebankCoinbase([pay(12_345, 'XProducer'), PREV_COMMIT, VERSION_COMMIT, WITNESS_COMMIT]);
    expect(split).toMatchObject({ total: 12_345, producerAmt: 12_345, refundCount: 0 });
  });

  test.each<[number, any]>(real.coinbases.map((c: any): [number, any] => [c.height, c]))('real block %i: one deposit paid, 1,000 szats to the producer', (_h, c: any) => {
    const split = splitFreebankCoinbase(c.vout);
    expect(split).toMatchObject({
      producerAmt: 1000,
      pegInCount: 1,
      pegInAmt: c.expected.amount - 1000,
      pegInFees: 1000,
      pegInUnpaidCount: 0,
      refundCount: 0,
      refundAmt: 0,
    });
    expect(split.pegIns).toEqual([{
      record_vout: c.expected.record_vout, payout_vout: c.expected.payout_vout, dest: c.expected.dest,
      amount: c.expected.amount, paid: c.expected.amount - 1000, unpaid_reason: null,
    }]);
    expect(freebankRewardExtras(c.vout).reward).toEqual(1000);
  });

  test('two identical deposits in one block need two outputs (D-1)', () => {
    const split = splitFreebankCoinbase([
      pay(3000 + 2000, 'XProducer'), PREV_COMMIT, VERSION_COMMIT,
      pay(49_000, 'XAlice'), record('XAlice', 50_000),
      pay(49_000, 'XAlice'), record('XAlice', 50_000),
      WITNESS_COMMIT,
    ]);
    expect(split).toMatchObject({ producerAmt: 5000, pegInCount: 2, pegInAmt: 98_000, pegInFees: 2000, refundCount: 0 });
    expect(split.pegIns.map((p) => p.payout_vout)).toEqual([3, 5]);
  });

  test('the second of two identical deposits without its own output is not paid, and the output is not counted twice', () => {
    const split = splitFreebankCoinbase([pay(1000, 'XProducer'), pay(49_000, 'XAlice'), record('XAlice', 50_000), record('XAlice', 50_000)]);
    expect(split.pegIns.map((p) => p.payout_vout)).toEqual([1, null]);
    expect(split).toMatchObject({ pegInCount: 1, pegInUnpaidCount: 1, pegInAmt: 49_000 });
  });

  test('a deposit at or below the 1,000-szat fee is recorded, not paid', () => {
    const split = splitFreebankCoinbase([pay(0, 'XProducer'), record('XAlice', 1000), record('XBob', 400)]);
    expect(split).toMatchObject({ producerAmt: 0, pegInCount: 0, pegInUnpaidCount: 2, pegInFees: 0 });
    expect(split.pegIns.map((p) => p.unpaid_reason)).toEqual(['at-or-below-fee', 'at-or-below-fee']);
  });

  test('a deposit to something that is not a FreeBank address is recorded, not paid', () => {
    const split = splitFreebankCoinbase([pay(0, 'XProducer'), record('not an address', 7_000_000)]);
    expect(split).toMatchObject({ pegInCount: 0, pegInUnpaidCount: 1, producerAmt: 0 });
    expect(split.pegIns[0].unpaid_reason).toEqual('not-a-freebank-address');
  });

  test('a bech32 destination typed in capitals still matches its payout', () => {
    const split = splitFreebankCoinbase([pay(1000, 'XProducer'), pay(9000, BECH), record(BECH.toUpperCase(), 10_000)]);
    expect(split.pegIns[0].payout_vout).toEqual(1);
  });

  test.each([B58 + ' ', ' ' + B58, B58 + '\n', B58 + '\0junk'])('a destination the node decodes to the payout address is paid: %j', (dest) => {
    const split = splitFreebankCoinbase([pay(1000, 'XProducer'), pay(99_000, B58), record(dest, 100_000)]);
    expect(split).toMatchObject({ pegInCount: 1, pegInAmt: 99_000, pegInUnpaidCount: 0, producerAmt: 1000, otherVouts: [] });
    expect(split.pegIns[0]).toMatchObject({ payout_vout: 1, unpaid_reason: null });
  });

  test('a destination with NBSP is not the address: recorded, not paid', () => {
    const split = splitFreebankCoinbase([pay(1000, 'XProducer'), record(B58 + '\u00a0', 100_000)]);
    expect(split.pegIns[0]).toMatchObject({ payout_vout: null, unpaid_reason: 'not-a-freebank-address' });
  });

  test('a bundle payment ("D", amount 0) is no deposit and pays nobody', () => {
    const split = splitFreebankCoinbase([pay(500, 'XProducer'), commitScriptOutput(), record('D', 0)]);
    expect(split).toMatchObject({ bundleReturnCount: 1, pegInCount: 0, pegInUnpaidCount: 0, producerAmt: 500, pegRecords: 2 });
  });

  test('a "D" record with a negative amount is a bundle payment too (the node accepts it)', () => {
    const split = splitFreebankCoinbase([pay(500, 'XProducer'), record('D', -2_000_000)]);
    expect(split).toMatchObject({ bundleReturnCount: 1, pegInCount: 0, pegInUnpaidCount: 0 });
  });

  test.each([500_000_000, 500])('a "D" record with a positive amount (%i) is a deposit from eCash, recorded and never paid', (amount) => {
    const split = splitFreebankCoinbase([pay(500, 'XProducer'), record('D', amount)]);
    expect(split).toMatchObject({ bundleReturnCount: 0, pegInCount: 0, pegInUnpaidCount: 1, producerAmt: 500 });
    expect(split.pegIns).toEqual([{ record_vout: 1, payout_vout: null, dest: 'D', amount, paid: 0, unpaid_reason: 'not-a-freebank-address' }]);
  });

  test('peg records: records and bundle status commitments count, the current-bundle commitment does not', () => {
    const current: CoinbaseOutput = { value: 0, scriptpubkey: commitScript('bundle-hash', hash32('bundle')) };
    expect(splitFreebankCoinbase([pay(0, 'XProducer'), PREV_COMMIT, current, VERSION_COMMIT, WITNESS_COMMIT]).pegRecords).toEqual(0);
    expect(splitFreebankCoinbase([pay(0, 'XProducer'), current, record('XAlice', 10)]).pegRecords).toEqual(1);
  });

  test('a withdrawal refund in a zero-fee block', () => {
    const vout = [{ value: 0, scriptpubkey: PRODUCER_P2PK }, PREV_COMMIT, VERSION_COMMIT, pay(1_003_000, 'XRefund'), WITNESS_COMMIT];
    expect(coinbaseMayPayRefunds(vout)).toBe(true);
    const split = splitFreebankCoinbase(vout, [due(1_003_000, 'XRefund')]);
    expect(split).toMatchObject({ producerAmt: 0, refundCount: 1, refundAmt: 1_003_000, refundVouts: [3], otherVouts: [] });
    expect(freebankRewardExtras(vout, [due(1_003_000, 'XRefund')])).toMatchObject({ reward: 0, refundCount: 1, refundAmt: 1_003_000 });
  });

  test('without its refund request, a positive output is the producer\'s, never a refund', () => {
    const vout = [{ value: 0, scriptpubkey: PRODUCER_P2PK }, PREV_COMMIT, pay(1_003_000, 'XRefund')];
    expect(splitFreebankCoinbase(vout)).toMatchObject({ producerAmt: 1_003_000, refundCount: 0, refundAmt: 0, refundVouts: [], otherVouts: [2] });
    expect(freebankRewardExtras(vout).reward).toEqual(1_003_000);
  });

  test('a producer splitting its earnings over two outputs earns both', () => {
    const vout = [pay(1500, 'XProducer'), pay(1500, 'XPartner'), PREV_COMMIT, WITNESS_COMMIT];
    expect(splitFreebankCoinbase(vout, [])).toMatchObject({ producerAmt: 3000, refundCount: 0, otherVouts: [1] });
  });

  test('a refund claims only an output of exactly its amount to its refund address', () => {
    const vout = [pay(0, 'XProducer'), pay(1_003_001, 'XRefund'), pay(1_003_000, 'XOther'), pay(1_003_000, 'XRefund')];
    const split = splitFreebankCoinbase(vout, [due(1_003_000, 'XRefund')]);
    expect(split).toMatchObject({ refundCount: 1, refundAmt: 1_003_000, refundVouts: [3], otherVouts: [1, 2], producerAmt: 2_006_001 });
  });

  test('a refund address the node decodes with whitespace around it still claims its payout', () => {
    const split = splitFreebankCoinbase([pay(0, 'XProducer'), pay(5000, B58)], [due(5000, ' ' + B58 + '\n')]);
    expect(split).toMatchObject({ refundCount: 1, refundVouts: [1], producerAmt: 0 });
  });

  test('two identical refunds need two outputs; a refund with none is not counted', () => {
    const vout = [pay(0, 'XProducer'), pay(5000, 'XRefund'), pay(5000, 'XRefund')];
    expect(splitFreebankCoinbase(vout, [due(5000, 'XRefund', hash32('a')), due(5000, 'XRefund', hash32('b'))]))
      .toMatchObject({ refundCount: 2, refundAmt: 10_000, refundVouts: [1, 2], producerAmt: 0 });
    expect(splitFreebankCoinbase(vout.slice(0, 2), [due(5000, 'XRefund', hash32('a')), due(5000, 'XRefund', hash32('b'))]))
      .toMatchObject({ refundCount: 1, refundAmt: 5000 });
  });

  test('a refund worth exactly a deposit payout, before a deposit that paid nothing, stays a refund', () => {
    const split = splitFreebankCoinbase([pay(0, 'XProducer'), pay(9000, 'XRefund'), record('garbage', 10_000)], [due(9000, 'XRefund')]);
    expect(split).toMatchObject({ refundCount: 1, refundAmt: 9000, pegInCount: 0, pegInUnpaidCount: 1 });
  });

  test('a deposit payout is not taken for a refund, nor vout[0]', () => {
    const vout = [pay(9000, 'XSame'), pay(9000, 'XSame'), record('XSame', 10_000)];
    expect(coinbaseMayPayRefunds(vout)).toBe(false);
    expect(splitFreebankCoinbase(vout, [due(9000, 'XSame')])).toMatchObject({ pegInCount: 1, refundCount: 0, producerAmt: 9000 });
  });

  test('a burn in the coinbase (a withdrawal the producer makes from its earnings) is no refund', () => {
    const burn: CoinbaseOutput = { value: 4000, scriptpubkey: '6a' };
    const vout = [pay(1000, 'XProducer'), burn, PREV_COMMIT];
    expect(splitFreebankCoinbase(vout)).toMatchObject({ total: 5000, producerAmt: 5000, refundCount: 0, refundAmt: 0, otherVouts: [] });
    expect(coinbaseMayPayRefunds(vout)).toBe(false);
  });

  test('the depositor is the producer: vout[0] is never claimed for the deposit', () => {
    const split = splitFreebankCoinbase([pay(9000, 'XSame'), pay(9000, 'XSame'), record('XSame', 10_000)]);
    expect(split.pegIns[0].payout_vout).toEqual(1);
    expect(split).toMatchObject({ producerAmt: 9000, pegInAmt: 9000, refundCount: 0 });
  });

  test('unexpectedReward: silent for the stock builder, a line otherwise', () => {
    expect(unexpectedReward(5, { reward: 3000, totalFees: 2000, pegInFees: 1000 })).toBeNull();
    expect(unexpectedReward(0, { reward: 50, totalFees: 0, pegInFees: 0 })).toBeNull(); // genesis
    expect(unexpectedReward(5, { reward: 3500, totalFees: 2000, pegInFees: 1000 })).toContain('block 5');
  });
});

describe('the refunds a block pays ($blockRefundsDue)', () => {
  const ID1 = hash32('w1');
  const ID2 = hash32('w2');

  class FakeRefundNode implements RefundNode {
    public calls: string[] = [];
    constructor(private withdrawals: Record<string, { refunddestination: string, amount: number } | Error>, private block: any = null) { }
    async getBlock(hash: string, verbosity: number): Promise<any> {
      this.calls.push(`getblock ${hash} ${verbosity}`);
      return this.block;
    }
    async getWithdrawal(id: string): Promise<{ refunddestination: string, amount: number }> {
      this.calls.push(`getwithdrawal ${id}`);
      const w = this.withdrawals[id];
      if (w instanceof Error) {
        throw w;
      }
      if (!w) {
        throw new Error('Withdrawal does not exist!');
      }
      return w;
    }
  }

  const txs = [
    { vout: [{ scriptpubkey: P2PKH('producer') }, { scriptpubkey: refundRequestScript(ID2) }] }, // a producer's own, in its coinbase
    { vout: [{ scriptpubkey: refundRequestScript(ID1) }, { scriptpubkey: '6afcd2e546' + 'ab'.repeat(40) }] }, // and a short look-alike
    { vout: [{ scriptpubkey: refundRequestScript(ID1) }] }, // the same request twice: asked once
  ];

  test('every refund request of the block, the coinbase\'s included, in block order', async () => {
    const node = new FakeRefundNode({ [ID1]: { refunddestination: 'XAlice', amount: 5000 }, [ID2]: { refunddestination: 'XBob', amount: 7000 } });
    expect(await $blockRefundsDue(hash32('block'), txs, node)).toEqual([
      { withdrawal_id: ID2, amount: 7000, dest: 'XBob' },
      { withdrawal_id: ID1, amount: 5000, dest: 'XAlice' },
    ]);
    expect(node.calls).toEqual([`getwithdrawal ${ID2}`, `getwithdrawal ${ID1}`]);
  });

  test('with only the coinbase at hand, the block is read with getblock 2', async () => {
    const block = { tx: txs.map((tx) => ({ vout: tx.vout.map((o) => ({ scriptPubKey: { hex: o.scriptpubkey } })) })) };
    const node = new FakeRefundNode({ [ID1]: { refunddestination: 'XAlice', amount: 5000 }, [ID2]: { refunddestination: 'XBob', amount: 7000 } }, block);
    expect((await $blockRefundsDue(hash32('block'), null, node)).map((r) => r.withdrawal_id)).toEqual([ID2, ID1]);
    expect(node.calls[0]).toEqual(`getblock ${hash32('block')} 2`);
  });

  test('a withdrawal the node does not know is left out; any other node error throws', async () => {
    expect(await $blockRefundsDue(hash32('block'), txs, new FakeRefundNode({ [ID1]: { refunddestination: 'XAlice', amount: 5000 } })))
      .toEqual([{ withdrawal_id: ID1, amount: 5000, dest: 'XAlice' }]);
    await expect($blockRefundsDue(hash32('block'), txs, new FakeRefundNode({ [ID2]: new Error('connect ECONNREFUSED') })))
      .rejects.toThrow('ECONNREFUSED');
  });

  test('a block without refund requests asks nothing', async () => {
    const node = new FakeRefundNode({});
    expect(await $blockRefundsDue(hash32('block'), [{ vout: [{ scriptpubkey: P2PKH('producer') }] }], node)).toEqual([]);
    expect(node.calls).toEqual([]);
  });
});

function commitScriptOutput(): CoinbaseOutput {
  return { value: 0, scriptpubkey: commitScript('bundle-paid', hash32('bundle')) };
}
