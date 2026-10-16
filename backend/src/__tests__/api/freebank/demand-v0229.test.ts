import { coinTags, custodyLabel } from '../../../api/freebank/custody-tags';
import { buildDirectory } from '../../../api/freebank/custody';
import { creditOpName, decodeCreditPayload, keyIdToAddress, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';
import { houseBadge } from '../../../api/freebank/house-badge';

// Forced payment of a matured term deposit (freebankd v0.2.29, FAILED_HOUSE_DESIGN.md D), on the real txs of
// freebankd's own gate deposit_demand_roundtrip.sh (ecash/demand-cycle.sh): three receipts of 0.2, 0.1 and 0.05
// maturing at block 61; DEMAND then DISCHARGE by the house; two DEMANDs, two PROTESTs, a stranger's DISCHARGE; the
// house fails and the saver CLAIMs the last receipt from custody. Checked against the node's own op names and gethouse.
const fx = require('../test-data/freebank-v0229-demand-txs.json');
const read = fx.txs.map((t: any) => {
  const tx = parseFreebankTx(t.hex);
  expect(tx.txid).toEqual(t.txid);
  return { ...t, tx, op: creditOpName(tx.family as any, tx.op as number), d: decodeCreditPayload(tx.family, tx.op, tx.payload), tags: coinTags(tx) };
});
const ops = (name: string): any[] => read.filter((t: any) => t.op === name);
const RECEIPTS = [20000000, 10000000, 5000000]; // 0.2, 0.1, 0.05 ECX of principal, in units
const pushOf = (script: string): string => script.slice(2, 42); // <20-byte push> OP_DROP OP_TRUE

describe('FreeBank deposit demands (v0.2.29)', () => {
  test('every term-deposit tx reads whole, named as the node names it', () => {
    for (const t of read) {
      expect(t.op).toEqual(t.node.credit.op_name);
      expect(t.d.house_id).toEqual(1);
    }
    expect(read.map((t: any) => t.op)).toEqual([
      'originate', 'originate', 'originate', 'demand', 'discharge', 'demand', 'demand', 'protest', 'protest', 'discharge', 'claim',
    ]);
    expect(ops('originate').map((t: any) => t.d.principal_units).sort((a: number, b: number) => b - a)).toEqual(RECEIPTS);
  });

  test('DEMAND: the receipt\'s terms, its payout address, and the receipt in custody at vout[0]', () => {
    const demands = ops('demand');
    expect(demands.map((t: any) => t.d.principal_units).sort((a: number, b: number) => b - a)).toEqual(RECEIPTS);
    for (const t of demands) {
      expect(t.d).toMatchObject({ rate_bps: 500, maturity_height: 61 });
      expect(t.d.origination_height).toBeLessThan(61);
      expect(t.d.payout_address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{25,35}$/);
      expect(t.tags[0]).toMatchObject({ kind: 'deposit_custody', houseId: 1, units: t.d.principal_units, protested: false });
      expect(t.tags[0].expectedPush).toEqual(pushOf(t.node.vout[0].script)); // the holder's custody script
      expect(t.tags.slice(1).every((tag: any) => tag === null)).toBe(true);
    }
  });

  test('PROTEST: same receipt re-issued, protested, with the demand\'s height', () => {
    const demandAt = new Map<number, number>(ops('demand').map((t: any): [number, number] => [t.d.principal_units, t.height]));
    const protests = ops('protest');
    expect(protests).toHaveLength(2);
    for (const t of protests) {
      expect(t.d.demand_height).toEqual(demandAt.get(t.d.principal_units));
      expect(t.height - t.d.demand_height).toBeGreaterThan(12); // regtest nDemandWindow
      expect(t.tags[0]).toMatchObject({ kind: 'deposit_custody', houseId: 1, units: t.d.principal_units, protested: true });
      expect(t.tags[0].expectedPush).toEqual(pushOf(t.node.vout[0].script));
    }
  });

  test('DISCHARGE: vout[0] pays the payout address the DEMAND named, at no less than principal', () => {
    const demands = ops('demand');
    for (const t of ops('discharge')) {
      const script: string = t.node.vout[0].script;
      expect(script).toMatch(/^76a914[0-9a-f]{40}88ac$/);
      expect(t.d.payout_address).toEqual(keyIdToAddress(Buffer.from(script.slice(6, 46), 'hex')));
      const demand = demands.find((d: any) => d.d.payout_address === t.d.payout_address && d.height < t.height);
      expect(demand).toBeDefined();
      expect(Math.round(t.node.vout[0].value * 1e8)).toBeGreaterThanOrEqual(demand.d.principal_units);
      expect(t.tags.every((tag: any) => tag === null)).toBe(true); // the receipt is burned, the payout is plain
    }
  });

  test('custody labels: a demanded receipt, and a protested one', () => {
    const dir = buildDirectory([fx.house], [], [], []);
    const demand = ops('demand').find((t: any) => t.d.principal_units === 20000000);
    expect(custodyLabel(demand.node.vout[0].script, demand.tags[0], dir)).toMatchObject({
      kind: 'deposit_custody', house_id: 1, link: '/house/1', units: 20000000,
      text: 'House 1 term deposit · demanded, held in custody (20,000,000 units)',
    });
    const protest = ops('protest')[0];
    expect(custodyLabel(protest.node.vout[0].script, protest.tags[0], dir)).toMatchObject({
      kind: 'deposit_custody', protested: true, text: expect.stringContaining('demanded and protested, held in custody'),
    });
    // the same script with no tag (a payment there by anyone else) is a look-alike
    expect(custodyLabel(demand.node.vout[0].script, null, dir)?.kind).toEqual('lookalike');
  });

  test('the failed house: collection done, claims open until the window closes', () => {
    expect(fx.house).toMatchObject({ effective_status: 'insolvent', collection_done: true, closed: false });
    const badge = houseBadge(fx.house, fx.tip);
    expect(badge.badge).toEqual('insolvent');
    expect(badge.reason).toContain(`since block ${fx.house.insolvent_since}`);
    expect(badge.reason).toContain(`Claims are open until block ${fx.house.claim_window_closes}`);
  });
});
