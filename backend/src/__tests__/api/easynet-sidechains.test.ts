import {
  applyBlock, coinbaseMessages, descriptionHash, emptySidechainState, failsAtHeight, opReturnPush, parseDeclaration,
  SIDECHAIN_RULES, SidechainState,
} from '../../api/easynet/sidechain-rules';

// easynet: the sidechain slots replayed by the enforcer's rules (bip300301_enforcer lib/validator/task/mod.rs).

// BitNames' declaration as betanet's enforcer returned it (GetSidechains, 2026-10-12), without the length byte
const BITNAMES = '0008' + Buffer.from('BitNames').toString('hex')
  + Buffer.from('A variant of Namecoin/BitDNS that aims to replace ICANN').toString('hex')
  + '2b4dfd7a97c94502ed88441e917b13533a30929a028568231eacccc6c25daf23' + '67a981fe0f2ea78126e7ad94d4f233c5bfdc1575';
const SHORT = SIDECHAIN_RULES.short;

const push = (data: string): string => {
  const n = data.length / 2;
  return n <= 0x4b ? n.toString(16).padStart(2, '0') + data : '4c' + n.toString(16).padStart(2, '0') + data;
};
const m1 = (slot: number, description: string): string => '6a' + push('d5e0c4af' + slot.toString(16).padStart(2, '0') + description);
const m2 = (slot: number, description: string): string =>
  '6a' + push('d6e1c5df' + slot.toString(16).padStart(2, '0') + Buffer.from(descriptionHash(Buffer.from(description, 'hex')), 'hex').reverse().toString('hex'));
const PAY = '76a914' + '00'.repeat(20) + '88ac';

/** Replay blocks 0..n-1; `scripts[h]` are block h's coinbase scripts after the payout. */
function replay(scripts: { [h: number]: string[] }, n: number, state: SidechainState = emptySidechainState(), from = 0): SidechainState {
  for (let h = from; h < n; h++) {
    const outputs = [PAY, ...(scripts[h] ?? [])].map((hex, i) => ({ n: i, hex }));
    applyBlock(state, SHORT, 0, { height: h, hash: 'b' + h, coinbaseTxid: 'c' + h, outputs });
  }
  return state;
}

const OTHER = '00' + '05' + Buffer.from('Other').toString('hex') + Buffer.from('x').toString('hex') + '11'.repeat(32) + '22'.repeat(20);

describe('easynet sidechain slots', () => {
  test('the declaration, as the enforcer reads it', () => {
    const d = parseDeclaration(Buffer.from(BITNAMES, 'hex'));
    expect(d).toEqual({
      title: 'BitNames', description: 'A variant of Namecoin/BitDNS that aims to replace ICANN',
      hashId1: '2b4dfd7a97c94502ed88441e917b13533a30929a028568231eacccc6c25daf23', hashId2: '67a981fe0f2ea78126e7ad94d4f233c5bfdc1575',
    });
    expect(parseDeclaration(Buffer.from('01' + BITNAMES.slice(2), 'hex'))).toBeNull();      // unknown version
    expect(parseDeclaration(Buffer.from(BITNAMES.slice(0, 100), 'hex'))).toBeNull();        // too short for the hash ids
    expect(parseDeclaration(Buffer.from('0002c328' + '11'.repeat(52), 'hex'))).toBeNull(); // title not UTF-8
  });

  test('messages: OP_RETURN with one push and nothing after it; M2 exactly 37 bytes; one ack per slot', () => {
    expect(opReturnPush(Buffer.from('6a03aabbcc', 'hex'))?.toString('hex')).toEqual('aabbcc');
    expect(opReturnPush(Buffer.from('6a4c03aabbcc', 'hex'))?.toString('hex')).toEqual('aabbcc'); // PUSHDATA1
    expect(opReturnPush(Buffer.from('6a03aabbcc51', 'hex'))).toBeNull();   // trailing opcode
    expect(opReturnPush(Buffer.from('6a04aabbcc', 'hex'))).toBeNull();     // short push
    expect(opReturnPush(Buffer.from('6a51', 'hex'))).toBeNull();           // an opcode, not a push
    const ack = m2(2, BITNAMES);
    const msgs = coinbaseMessages([
      { n: 0, hex: m1(2, BITNAMES) }, { n: 1, hex: ack }, { n: 2, hex: ack },           // second ack for slot 2: dropped
      { n: 3, hex: '6a' + push(ack.slice(4) + '00') },                                  // 38-byte M2: not a message
      { n: 4, hex: m1(2, BITNAMES) },                                                   // same M1 twice: dropped
    ]);
    expect(msgs.map((m) => [m.kind, m.vout])).toEqual([['m1', 0], ['m2', 1]]);
  });

  test('an unused slot activates on the 6th ack within 10 blocks; an ack in the M1 block does not count', () => {
    const s = replay({ 1: [m1(2, BITNAMES), m2(2, BITNAMES)], 2: [m2(2, BITNAMES)], 3: [m2(2, BITNAMES)], 4: [m2(2, BITNAMES)],
      5: [m2(2, BITNAMES)], 6: [m2(2, BITNAMES)], 7: [m2(2, BITNAMES)] }, 7);
    expect(s.pending.length).toEqual(1);
    expect(s.proposals[0].votes).toEqual(5);
    replay({ 7: [m2(2, BITNAMES)] }, 8, s, 7);
    expect(s.pending).toEqual([]);
    expect(s.active['2']).toEqual(0);
    expect(s.proposals[0]).toMatchObject({ status: 'active', activationHeight: 7, votes: 6, vout: 1, txid: 'c1', height: 1 });
    expect(s.proposals[0].declaration?.title).toEqual('BitNames');
    expect(s.events.map((e) => [e.height, e.type])).toEqual([[1, 'proposed'], [7, 'activated']]);
  });

  test('a repeated M1 does not reset the votes; an ack for an unknown hash is ignored', () => {
    const s = replay({ 1: [m1(2, BITNAMES)], 2: [m2(2, BITNAMES)], 3: [m1(2, BITNAMES), m2(2, OTHER)], 4: [m2(2, BITNAMES)] }, 5);
    expect(s.proposals.length).toEqual(1);
    expect(s.proposals[0].votes).toEqual(2);
  });

  test('a proposal fails when it can no longer reach the threshold, at the block failsAtHeight predicts', () => {
    for (let acks = 0; acks <= 5; acks++) {
      const scripts: { [h: number]: string[] } = { 10: [m1(5, OTHER)] };
      for (let i = 1; i <= acks; i++) {
        scripts[10 + i] = [m2(5, OTHER)];
      }
      const s = replay(scripts, 11 + acks);
      const predicted = failsAtHeight(s.proposals[0], SHORT, false);
      replay({}, 40, s, 11 + acks);
      expect([acks, s.proposals[0].status, s.proposals[0].endHeight]).toEqual([acks, 'failed', predicted]);
    }
  });

  test('a used slot is replaced by a proposal that reaches the threshold', () => {
    const scripts: { [h: number]: string[] } = { 1: [m1(2, BITNAMES)], 20: [m1(2, OTHER)] };
    for (let h = 2; h <= 7; h++) { scripts[h] = [m2(2, BITNAMES)]; }
    for (let h = 21; h <= 26; h++) { scripts[h] = [m2(2, OTHER)]; }
    const s = replay(scripts, 30);
    expect(s.proposals.map((p) => [p.status, p.activationHeight, p.endHeight, p.replacedSlotTaken]))
      .toEqual([['replaced', 7, 26, false], ['active', 26, null, true]]);
    expect(s.active['2']).toEqual(1);
  });

  test('an active sidechain can be proposed again (it left the proposal list) and needs the used-slot votes', () => {
    const scripts: { [h: number]: string[] } = { 1: [m1(2, BITNAMES)], 9: [m1(2, BITNAMES)] };
    for (let h = 2; h <= 7; h++) { scripts[h] = [m2(2, BITNAMES)]; }
    const s = replay(scripts, 10);
    expect(s.proposals.length).toEqual(2);
    expect(s.proposals[1].status).toEqual('pending');
    expect(failsAtHeight(s.proposals[1], SHORT, true)).toEqual(9 + 6);
  });
});
