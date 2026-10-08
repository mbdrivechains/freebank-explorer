import { coinTags } from '../../../api/freebank/custody-tags';
import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';

// The token holders' claim at a failed house (freebankd v0.2.21, D-2026-10-08-1), on the real txs of freebankd's own
// gate token_claim_roundtrip.sh (ecash/claim-cycle.sh): mint, lock, keyset, post, unlock, two claims, collect; checked
// against the node's gettokenclaims.
const fx = require('../test-data/freebank-v0221-txs.json');
const read = fx.txs.map((t: any) => {
  const tx = parseFreebankTx(t.hex);
  expect(tx.txid).toEqual(t.txid);
  return { ...t, op: creditOpName(tx.family as any, tx.op as number), d: decodeCreditPayload(tx.family, tx.op, tx.payload), tags: coinTags(tx) };
});
const ops = (name: string): any[] => read.filter((t: any) => t.op === name);
const claims = fx.gettokenclaims;

describe('FreeBank token claims (v0.2.21)', () => {
  test('the gate\'s note txs, in order, read whole with the node\'s txids', () => {
    expect(read.map((t: any) => t.op)).toEqual(['mint', 'lock', 'token_keyset', 'token_post', 'unlock', 'token_claim', 'token_claim', 'token_collect']);
    expect(read.every((t: any) => t.d.house_id === fx.house_id)).toBe(true);
  });

  test('KEYSET: one key per amount; POST names the keyset by the id gettokenclaims prints', () => {
    const [keyset] = ops('token_keyset');
    expect(keyset.d.keys).toEqual(claims.keysets[0].keys.length);
    expect(keyset.d.largest_amount).toEqual(Math.max(...claims.keysets[0].keys.map((k: any) => k.amount)));
    const [post] = ops('token_post');
    expect(post.d).toMatchObject({ keyset_id: claims.keysets[0].id, issued: 6, spent: 1 });
  });

  test('CLAIMs add up to what the node counts as claimed', () => {
    const tokens = ops('token_claim').reduce((s: number, t: any) => s + t.d.tokens, 0);
    const units = ops('token_claim').reduce((s: number, t: any) => s + t.d.claimed_units, 0);
    expect(tokens).toEqual(claims.claims);
    expect(units).toEqual(claims.claimed);
    expect(fx.house).toMatchObject({ tokenclaimed: claims.claimed, tokenclaims: claims.claims });
  });

  test('COLLECT pays every claim; its escrow change (if any) is labelled as house escrow', () => {
    const [collect] = ops('token_collect');
    expect(collect.d.claims).toEqual(claims.collected);
    if (collect.d.escrow_change) {
      expect(collect.tags[0]).toMatchObject({ kind: 'house_claim_change', houseId: fx.house_id });
    } else {
      expect(collect.tags[0]?.kind).not.toEqual('house_claim_change');
    }
  });
});
