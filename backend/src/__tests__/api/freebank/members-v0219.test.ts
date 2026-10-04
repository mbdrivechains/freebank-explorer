import { coinTags } from '../../../api/freebank/custody-tags';
import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';

// Members-only houses (freebankd v0.2.19), on real txs from ecash/members-cycle.sh: house 1 "coop" members-only,
// house 2 "rcoop" redeem-only, house 3 "plain" open.
const fixtures = require('../test-data/freebank-v0219-txs.json');
const tx = (label: string): any => fixtures.txs.find((t: any) => t.label === label);
const decoded = (label: string): any => {
  const t = parseFreebankTx(tx(label).hex);
  return { op: creditOpName(t.family as any, t.op as number), ...decodeCreditPayload(t.family, t.op, t.payload) };
};

describe('FreeBank members-only houses (v0.2.19)', () => {
  test('every fixture reads whole, with the node\'s txid', () => {
    for (const t of fixtures.txs) {
      expect(parseFreebankTx(t.hex).txid).toEqual(t.txid);
    }
  });

  test('REGISTER_MO decodes the register fields and the house type; a plain REGISTER stays op 1', () => {
    expect(decoded('register-mo-members')).toMatchObject({ op: 'register_mo', classid: 'coop', house_type: 'members' });
    expect(decoded('register-mo-redeem')).toMatchObject({ op: 'register_mo', classid: 'rcoop', house_type: 'redeem' });
    expect(decoded('register-open')).toMatchObject({ op: 'register', classid: 'plain' });
  });

  test('member ops: house, count and the addresses the node lists', () => {
    const members: string[] = fixtures.members_of_house_1;
    const alice = decoded('member-add-alice');
    expect(alice).toMatchObject({ op: 'member_add', house_id: 1, members: 1 });
    expect(members).toContain(alice.member_addresses);
    const batch = decoded('member-add-batch-1');
    expect(batch).toMatchObject({ op: 'member_add', house_id: 1, members: 50 });
    const shown = batch.member_addresses.split(',');
    expect(shown.length).toEqual(20); // the first 20 of 50
    expect(shown.every((a: string) => members.includes(a))).toBe(true);
    expect(decoded('member-remove')).toMatchObject({ op: 'member_remove', house_id: 1, members: 1 });
    expect(decoded('member-purge')).toMatchObject({ op: 'member_purge', house_id: 1, members: 1 });
  });

  test('the pledge of a REGISTER_MO is tagged with the house hash the node reports (the -mo declaration digest)', () => {
    for (const label of ['register-mo-members', 'register-mo-redeem', 'register-open']) {
      const t = tx(label);
      const tags = coinTags(parseFreebankTx(t.hex));
      expect(tags[0]).toMatchObject({ kind: 'house_pledge', houseHash: t.house_hash });
    }
  });
});
