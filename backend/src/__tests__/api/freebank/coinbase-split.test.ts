import { CoinbaseOutput, freebankRewardExtras, splitFreebankCoinbase, unexpectedReward } from '../../../api/freebank/coinbase-split';
import { commitScript, depositScript, hash32, P2PKH, TxSpec } from './peg-builders';

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

describe('FreeBank coinbase split', () => {
  test('the live beta tip: four zero outputs, nothing earned', () => {
    const split = splitFreebankCoinbase([{ value: 0, scriptpubkey: PRODUCER_P2PK }, PREV_COMMIT, VERSION_COMMIT, WITNESS_COMMIT]);
    expect(split).toMatchObject({ total: 0, producerAmt: 0, pegInCount: 0, pegInAmt: 0, pegInFees: 0, refundCount: 0, refundAmt: 0 });
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
    const split = splitFreebankCoinbase([pay(1000, 'XProducer'), pay(9000, 'fbk1qalice'), record('FBK1QALICE', 10_000)]);
    expect(split.pegIns[0].payout_vout).toEqual(1);
  });

  test('a bundle payment ("D") is no deposit and pays nobody', () => {
    const split = splitFreebankCoinbase([pay(500, 'XProducer'), commitScriptOutput(), record('D', 0)]);
    expect(split).toMatchObject({ bundleReturnCount: 1, pegInCount: 0, pegInUnpaidCount: 0, producerAmt: 500 });
  });

  test('a withdrawal refund in a zero-fee block', () => {
    const split = splitFreebankCoinbase([{ value: 0, scriptpubkey: PRODUCER_P2PK }, PREV_COMMIT, VERSION_COMMIT, pay(1_003_000, 'XRefund'), WITNESS_COMMIT]);
    expect(split).toMatchObject({ producerAmt: 0, refundCount: 1, refundAmt: 1_003_000, refundVouts: [3] });
  });

  test('a refund worth exactly a deposit payout, before a deposit that paid nothing, stays a refund', () => {
    const split = splitFreebankCoinbase([pay(0, 'XProducer'), pay(9000, 'XRefund'), record('garbage', 10_000)]);
    expect(split).toMatchObject({ refundCount: 1, refundAmt: 9000, pegInCount: 0, pegInUnpaidCount: 1 });
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

function commitScriptOutput(): CoinbaseOutput {
  return { value: 0, scriptpubkey: commitScript('bundle-paid', hash32('bundle')) };
}
