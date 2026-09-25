import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PegIndex, PegNode } from '../../../api/freebank/peg-index';
import { derivePegState, extractBlockEvents, pegTxView, StoredBlock } from '../../../api/freebank/peg-state';
import {
  bitcoinTxid, bundleScript, commitScript, cusfFeeScript, depositScript, hash32, P2PKH, P2WPKH, refundRequestScript,
  TxSpec, withdrawalObject,
} from './peg-builders';

// The peg's state from a chain's events (peg-state.ts), and the index that keeps them (peg-index.ts):
// a small chain built in getblock <hash> 2 form, with a deposit, two withdrawals, a bundle, a
// refund and the bundle's payment on eCash.

const TREASURY = 'b7018251';
const ECASH_BLOCK = hash32('ecash block');
const ZERO_FEE_PRODUCER = { value: 0, hex: '21' + '02'.repeat(33) + 'ac' };

interface Out { value: number, hex: string, address?: string }

function nodeTx(txid: string, outs: Out[], coinbase = false): any {
  return {
    txid,
    vin: coinbase ? [{ coinbase: '5100' }] : [{ txid: hash32('in' + txid), vout: 0 }],
    vout: outs.map((o, n) => ({ n, value: o.value / 1e8, scriptPubKey: { hex: o.hex, ...(o.address ? { address: o.address } : {}) } })),
  };
}

function nodeBlock(height: number, prev: string, txs: any[], salt = ''): any {
  return { hash: hash32(`block ${height}${salt}`), height, previousblockhash: prev || undefined, time: 1_790_000_000 + height * 600, tx: txs };
}

function payTo(value: number, address: string): Out {
  return { value, hex: P2PKH(address), address };
}

// The withdrawals (made in block 2)
const W1 = withdrawalObject({ dest: 'ecash:qalice', refund: 'XAliceRefund', amount: 1_003_000, fee: 3000 });
const W2 = withdrawalObject({ dest: 'ecash:qbob', refund: 'XBobRefund', amount: 505_000, fee: 5000 });

// The bundle (block 3): W1 alone, CUSF
const BUNDLE_TX: TxSpec = {
  version: 2,
  vin: [{ txid: '00'.repeat(32), vout: 0, scriptsig: '00' }],
  vout: [{ value: 0, scriptpubkey: cusfFeeScript(3000) }, { value: 1_000_000, scriptpubkey: P2WPKH('alice ecash') }],
};
const BUNDLE_HASH = bitcoinTxid(BUNDLE_TX);

// The M6 on eCash: the treasury change at vout[0], the payouts after it
const M6: TxSpec = {
  version: 2,
  vin: [{ txid: hash32('ctip'), vout: 0 }],
  vout: [{ value: 8_996_999_000 - 1_000_000 - 3000, scriptpubkey: TREASURY }, BUNDLE_TX.vout[1]],
};
const DEPOSIT_DTX: TxSpec = { version: 2, vin: [{ txid: hash32('alice coins'), vout: 1 }], vout: [{ value: 9_000_000_000, scriptpubkey: TREASURY }] };

function chain(): any[] {
  const b0 = nodeBlock(0, '', [nodeTx(hash32('cb0'), [ZERO_FEE_PRODUCER], true)]);
  const b1 = nodeBlock(1, b0.hash, [nodeTx(hash32('cb1'), [
    { value: 1000, hex: ZERO_FEE_PRODUCER.hex },
    payTo(8_999_999_000, 'XAlice'),
    { value: 0, hex: depositScript({ dest: 'XAlice', amount: 9_000_000_000, dtx: DEPOSIT_DTX, burn: 0, block: ECASH_BLOCK }) },
  ], true)]);
  const b2 = nodeBlock(2, b1.hash, [
    nodeTx(hash32('cb2'), [ZERO_FEE_PRODUCER], true),
    nodeTx(hash32('w1 tx'), [{ value: 1_003_000, hex: '6a' }, { value: 0, hex: W1.script }, payTo(5, 'XChange')]),
    nodeTx(hash32('w2 tx'), [{ value: 505_000, hex: '6a' }, { value: 0, hex: W2.script }]),
  ]);
  const b3 = nodeBlock(3, b2.hash, [nodeTx(hash32('cb3'), [
    ZERO_FEE_PRODUCER,
    { value: 0, hex: commitScript('bundle-hash', BUNDLE_HASH) },
    { value: 0, hex: bundleScript({ tx: BUNDLE_TX, ids: [W1.id] }) },
  ], true)]);
  const b4 = nodeBlock(4, b3.hash, [
    nodeTx(hash32('cb4'), [ZERO_FEE_PRODUCER, { value: 0, hex: commitScript('bundle-hash', BUNDLE_HASH) }, payTo(505_000, 'XBobRefund')], true),
    nodeTx(hash32('refund tx'), [{ value: 0, hex: refundRequestScript(W2.id) }]),
  ]);
  const b5 = nodeBlock(5, b4.hash, [nodeTx(hash32('cb5'), [
    ZERO_FEE_PRODUCER,
    { value: 0, hex: commitScript('bundle-paid', BUNDLE_HASH) },
    { value: 0, hex: commitScript('bundle-hash', BUNDLE_HASH) },
    { value: 0, hex: depositScript({ dest: 'D', amount: M6.vout[0].value, dtx: M6, burn: 0, block: hash32('ecash block 2') }) },
  ], true)]);
  return [b0, b1, b2, b3, b4, b5];
}

function stored(blocks: any[]): StoredBlock[] {
  return blocks.map((b) => ({ height: b.height, hash: b.hash, prev: b.previousblockhash || '', time: b.time, ev: extractBlockEvents(b) }));
}

class FakeNode implements PegNode {
  public getBlockCalls = 0;
  constructor(public blocks: any[]) { }
  async getBlockCount(): Promise<number> {
    return this.blocks.length - 1;
  }
  async getBlockHash(height: number): Promise<string> {
    return this.blocks[height].hash;
  }
  async getBlock(hash: string): Promise<any> {
    this.getBlockCalls++;
    const block = this.blocks.find((b) => b.hash === hash);
    if (!block) {
      throw Object.assign(new Error('Block not found'), { code: -5 });
    }
    return block;
  }
}

async function settle(index: PegIndex, node: FakeNode): Promise<void> {
  const tip = node.blocks[node.blocks.length - 1];
  await index.$waitForTip({ height: tip.height, hash: tip.hash }, 5000);
}

describe('FreeBank peg state', () => {
  test('blocks without peg events keep nothing; the current-bundle commitment alone is no event', () => {
    const [b0, , , , b4] = chain();
    expect(extractBlockEvents(b0)).toBeUndefined();
    const ev4 = extractBlockEvents(b4);
    expect(ev4?.coinbase).toEqual([]); // only the bundle-hash commitment, left out
    expect(ev4?.cb).toBeDefined(); // kept for the refund's pairing
  });

  test('the whole cycle: deposit, withdrawals, bundle, refund, payment on eCash', () => {
    const state = derivePegState(stored(chain()).filter((b) => b.ev));

    expect(state.deposits).toHaveLength(1);
    expect(state.deposits[0]).toMatchObject({
      freebank_height: 1, record_vout: 2, payout_vout: 1, dest: 'XAlice', amount: 9_000_000_000, paid: 8_999_999_000, fee: 1000,
      unpaid_reason: null, ecash_txid: bitcoinTxid(DEPOSIT_DTX), ecash_block: ECASH_BLOCK, ecash_vout: 0,
    });

    const w1 = state.withdrawals.get(W1.id)!;
    expect(w1).toMatchObject({ txid: hash32('w1 tx'), vout: 1, freebank_height: 2, amount: 1_003_000, payout: 1_000_000, status: 'paid', bundle_hash: BUNDLE_HASH, bundle_vout: 1 });
    expect(w1.ecash_payment).toEqual({
      ecash_txid: bitcoinTxid(M6), ecash_block: hash32('ecash block 2'), ecash_vout: 1, freebank_height: 5, freebank_block: hash32('block 5'),
    });

    const w2 = state.withdrawals.get(W2.id)!;
    expect(w2.status).toEqual('refunded');
    expect(w2.refund).toMatchObject({ request_txid: hash32('refund tx'), freebank_height: 4, payout_vout: 2, amount: 505_000, refund_dest: 'XBobRefund' });

    const bundle = state.bundles.get(BUNDLE_HASH)!;
    expect(bundle).toMatchObject({ status: 'paid', status_height: 5, freebank_height: 3, withdrawal_ids: [W1.id], total: 1_000_000, ecash_fee: 3000 });
    expect(bundle.ecash_payment?.ecash_txid).toEqual(bitcoinTxid(M6));

    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].bundle_hash).toEqual(BUNDLE_HASH);
    expect(state.treasury).toEqual({ ecash_txid: bitcoinTxid(M6), ecash_vout: 0, value: M6.vout[0].value, freebank_height: 5 });

    const block5 = state.blocks.get(hash32('block 5'))!;
    expect(block5.bundles_paid.map((b) => b.bundle_hash)).toEqual([BUNDLE_HASH]);
    expect(block5.ecash_payments).toHaveLength(1);
    const block4 = state.blocks.get(hash32('block 4'))!;
    expect(block4).toMatchObject({ refunds_amount: 505_000 });

    expect(state.ecashTxs.get(bitcoinTxid(DEPOSIT_DTX))?.deposit?.freebank_height).toEqual(1);
    expect(state.ecashTxs.get(bitcoinTxid(M6))?.payment?.freebank_height).toEqual(5);
  });

  test('a "paid" commitment with no matching eCash payment record: marked paid, no link', () => {
    const blocks = chain();
    blocks[5].tx[0].vout.pop(); // drop the M6 record
    const state = derivePegState(stored(blocks).filter((b) => b.ev));
    expect(state.bundles.get(BUNDLE_HASH)).toMatchObject({ status: 'marked-paid', ecash_payment: null });
    expect(state.withdrawals.get(W1.id)).toMatchObject({ status: 'marked-paid', ecash_payment: null });
  });

  test('an M6 record whose payouts do not match the bundle is not taken as its payment (the D2 caveat)', () => {
    const blocks = chain();
    const wrongM6: TxSpec = { ...M6, vout: [M6.vout[0], { value: 999_999, scriptpubkey: M6.vout[1].scriptpubkey }] };
    blocks[5].tx[0].vout[3].scriptPubKey.hex = depositScript({ dest: 'D', amount: 1, dtx: wrongM6, burn: 0, block: hash32('x') });
    const state = derivePegState(stored(blocks).filter((b) => b.ev));
    expect(state.bundles.get(BUNDLE_HASH)?.status).toEqual('marked-paid');
    expect(state.payments[0].bundle_hash).toBeNull();
  });

  test('a failed bundle puts its withdrawals back in the queue', () => {
    const blocks = chain();
    blocks[5].tx[0].vout = [
      { n: 0, value: 0, scriptPubKey: { hex: ZERO_FEE_PRODUCER.hex } },
      { n: 1, value: 0, scriptPubKey: { hex: commitScript('bundle-failed', BUNDLE_HASH) } },
    ];
    const state = derivePegState(stored(blocks).filter((b) => b.ev));
    expect(state.bundles.get(BUNDLE_HASH)).toMatchObject({ status: 'failed', status_height: 5 });
    expect(state.withdrawals.get(W1.id)).toMatchObject({ status: 'requeued', failed_bundles: [BUNDLE_HASH] });
  });

  test('a deposit record in an ordinary tx is shown as not real and changes nothing', () => {
    const blocks = chain();
    blocks[2].tx[2].vout.push({ n: 2, value: 0, scriptPubKey: { hex: depositScript({ dest: 'XMallory', amount: 5e9, dtx: DEPOSIT_DTX, burn: 0, block: ECASH_BLOCK }) } });
    const state = derivePegState(stored(blocks).filter((b) => b.ev));
    expect(state.deposits).toHaveLength(1);
    const view = pegTxView(state, hash32('w2 tx'), 'https://ex')!;
    expect(view.outputs.map((o) => o.output.kind)).toEqual(['withdrawal', 'stray']);
  });

  test('the tx view joins outputs with their status', () => {
    const state = derivePegState(stored(chain()).filter((b) => b.ev));
    const cb1 = pegTxView(state, hash32('cb1'), 'https://ex')!;
    expect(cb1).toMatchObject({ coinbase: true, confirmed: true, indexed: true, freebank_height: 1, deposit_payouts: [{ vout: 1, record_vout: 2 }] });
    expect(cb1.outputs[0].deposit?.paid).toEqual(8_999_999_000);
    const cb4 = pegTxView(state, hash32('cb4'), 'https://ex')!;
    expect(cb4).toMatchObject({ outputs: [], refund_payouts: [{ vout: 2, withdrawal_id: W2.id }] }); // its commitment is not kept
    const refund = pegTxView(state, hash32('refund tx'), 'https://ex')!;
    expect(refund.outputs[0].withdrawal?.id).toEqual(W2.id);
    expect(refund.outputs[0].refund?.payout_vout).toEqual(2);
    const cb5 = pegTxView(state, hash32('cb5'), 'https://ex')!;
    expect(cb5.outputs.map((o) => o.output.kind)).toEqual(['bundle-paid', 'deposit']);
    expect((cb5.outputs[1].output as any).ecash_outputs).toBeUndefined(); // kept in the index only
    expect(cb5.outputs[1].payment?.bundle_hash).toEqual(BUNDLE_HASH);
    expect(cb5.outputs[1].bundle?.status).toEqual('paid');
  });
});

describe('FreeBank peg index', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peg-index-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('scans the chain and answers the API queries', async () => {
    const node = new FakeNode(chain());
    const index = new PegIndex(node, null);
    await settle(index, node);
    expect(index.getTop()).toEqual(5);
    const summary = index.getSummary();
    expect(summary).toMatchObject({ tip_height: 5, deposits: 1, deposits_amount: 9_000_000_000, withdrawals: 2, withdrawals_paid: 1, withdrawals_refunded: 1, bundles: 1, current_bundle: null });
    expect(summary.treasury?.value).toEqual(M6.vout[0].value);
    expect(index.getList('withdrawal', 1).items.map((w: any) => w.id)).toEqual([W2.id]); // newest first
    expect(index.getList('deposit', 10).total).toEqual(1);
    expect(index.getBlock(hash32('block 4'), 4, true)).toMatchObject({ indexed: true, refunds_amount: 505_000 });
    expect(index.getBlock(hash32('block 0'), 0, true)).toMatchObject({ indexed: true, deposits: [], refunds: [] });
    expect(index.getBlock(hash32('block 4'), 4, false).indexed).toBe(false); // not on the active chain
    expect(index.getEcashTx(bitcoinTxid(DEPOSIT_DTX))).toMatchObject({ kind: 'deposit', freebank_height: 1, record_vout: 2 });
    expect(index.getEcashTx(hash32('nothing'))).toBeNull();
    expect(index.getWithdrawal(W1.id).bundle?.bundle_hash).toEqual(BUNDLE_HASH);
  });

  test('a tx the index does not hold is decoded on the fly', () => {
    const index = new PegIndex(new FakeNode(chain()), null);
    const view = index.describeTx(hash32('mempool w'), [{ scriptpubkey: W1.script }], false, null);
    expect(view).toMatchObject({ confirmed: false, indexed: false, outputs: [{ output: { kind: 'withdrawal', id: W1.id } }] });
    expect(index.describeTx(hash32('plain'), [{ scriptpubkey: P2PKH('x') }], false, null)).toBeNull();
  });

  test('a reorg rolls the replaced blocks back', async () => {
    const blocks = chain();
    const node = new FakeNode(blocks);
    const index = new PegIndex(node, null);
    await settle(index, node);
    expect(index.getWithdrawal(W2.id).withdrawal?.status).toEqual('refunded');

    // blocks 4 and 5 are replaced by one block without the refund, the payment or the commitment
    const b4 = nodeBlock(4, blocks[3].hash, [nodeTx(hash32('cb4 other'), [ZERO_FEE_PRODUCER], true)], ' other');
    node.blocks = [...blocks.slice(0, 4), b4];
    index.kick();
    await settle(index, node);
    expect(index.getTop()).toEqual(4);
    expect(index.getWithdrawal(W2.id).withdrawal?.status).toEqual('waiting');
    expect(index.getWithdrawal(W1.id).withdrawal?.status).toEqual('in-bundle');
    expect(index.getSummary().current_bundle?.bundle_hash).toEqual(BUNDLE_HASH);
    expect(index.getTx(hash32('refund tx'))).toBeNull();
    expect(index.getBlock(hash32('block 4'), 4, true).indexed).toBe(false); // the old block 4
  });

  test('saved and reloaded: resumes without scanning again', async () => {
    const file = path.join(dir, 'freebank', 'peg-v1.json');
    const node = new FakeNode(chain());
    const first = new PegIndex(node, file);
    await settle(first, node);
    await first.$save();
    expect(fs.existsSync(file)).toBe(true);

    const again = new FakeNode(chain());
    const second = new PegIndex(again, file);
    second.kick();
    await settle(second, again);
    expect(again.getBlockCalls).toEqual(0);
    expect(second.getWithdrawal(W1.id).withdrawal?.status).toEqual('paid');
    expect(second.getSummary().deposits).toEqual(1);
  });

  test('a cache from another chain is not used', async () => {
    const file = path.join(dir, 'freebank', 'peg-v1.json');
    const node = new FakeNode(chain());
    const first = new PegIndex(node, file);
    await settle(first, node);
    await first.$save();

    const other = new FakeNode([nodeBlock(0, '', [nodeTx(hash32('other cb0'), [ZERO_FEE_PRODUCER], true)], ' other chain')]);
    const second = new PegIndex(other, file);
    second.kick();
    await settle(second, other);
    expect(second.getTop()).toEqual(0);
    expect(second.getSummary().deposits).toEqual(0);
  });
});
