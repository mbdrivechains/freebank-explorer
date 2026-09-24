import { parseBmmBlock } from '../../../api/freebank/bmm-parser';
import { FreebankParseError } from '../../../api/freebank/freebank-tx-parser';

// Real data from eCash beta block 970,199 (explorer.beta.ecash.ninja, fetched 2026-09-24;
// explorer/m3/ecash-beta-970199-fixture.json), which carried FreeBank beta block 2. The real
// block has 3,301 txs; the test block is its header and three of them: the coinbase (M7s for
// slots 255, 2, 9, 4, 13 and 130), the slot-2 bid (tx 22 in the real block) and FreeBank's
// slot-130 bid (tx 65). Expected values are the explorer's and FreeBank's node's.

const ECASH_BLOCK_HASH = '0000000000000000efdce28bc9dc0a9dd2cd65fa8d30f36fa3af0f0290b2f234';
const HEADER_HEX =
  '00e0de235aba66acb0f574699cc225d4352bceed6369622c2a00e70301000000000000003dfc7d481f6536396abd35bc91b9'
  + '0df6b251b64e70d84ca6855f2df6dd0541249dedb46adf1201198404df99';
const COINBASE_HEX =
  '020000000001010000000000000000000000000000000000000000000000000000000000000000ffffffff2303d7cd0e0d2f'
  + '6563706f6f6c2e746563682f04b2ddfafebfa52347000000000005131effffffff160000000000000000276a25d6e1c5df18'
  + '00241a2eacd4d4030a003b96bc3336ed8c70642079f9a9defa54c8e4f1336e860000000000000000276a25d6e1c5df087e11'
  + '45c2181066e4effe0a22394be3e62a93a24d8177e9435db0b61d75e7f8140000000000000000276a25d1617368ff429ed59c'
  + '7d240e346be68f92f71e2de201ce599474c373ca60bc480c97aecdd80000000000000000276a25d161736802bb2275c256e1'
  + '2d1be89a65e6c424dad04049603bfe4464209b6482fd287196e80000000000000000276a25d16173680996945b5586320dc4'
  + '6d665b099951c99f6876dd4f4c56046c4d975f8e6b90f3e20000000000000000276a25d161736804750ec9ab34b2c02e8c93'
  + '11e7a23151be795b2850a7697d9220b6a8eaa287e33f0000000000000000276a25d16173680db8e1ae64ee6ed997767e1ec6'
  + 'c2904843f28fa7048c03368ee49ccabbcbea934c0000000000000000276a25d16173688282b0057c96e3b9f4decefdabdabf'
  + '7c95b30bcb502d4c9a9e8349bacaba93f4621063f908000000001600149edb820ae4679344b578a60fc256bc61546a623ca8'
  + 'd08102000000001600148fcb064d5e84895832c06867229074d4c45c11b49252e001000000002251201256d46f7f5825898e'
  + '1a8ae8c4e0ca28dae1e0858b6aedf72d75b4add4cce6e337a8cb0100000000160014478dcd1df43f7a421a65d12ecd14fc11'
  + '25dbcbbd71ea8401000000001600147c5218d1266991dd3aada70dcbe12be06b769f0b721e5d010000000016001407aa2ddd'
  + '813c987040875abc4988a7067a9a412ce61f37000000000016001423e150c26a2ba07851c39e47331c727e99b04e17b4ee19'
  + '0000000000160014f3e1ee5ad5ff259fb1b95313b5825fdfdf26c83f157a140000000000160014e1ee811fa266e728b20c6f'
  + 'fe7f6c71dbe9387a8f6af8120000000000160014a8cafcace47d17e6097c40fb2e48589212c1215f3ea61100000000001600'
  + '1482b5d41c7189a2bddb03ff6a7990c6b1119aaa25d3f810000000000016001411f94494d2f3cb9af20a534633280bf81dac'
  + '68b14bfb1700000000002251203a55383afa0f75dcb4993bdd6edbd513d157a2c96b6077621d14f74a3fbf5b6a0000000000'
  + '000000266a24aa21a9ed1ee3f53ef65af62d0bac9e46ddd755bbf27bfd73226623ecd3521a2d44c5de410120000000000000'
  + '000000000000000000000000000000000000000000000000000000000000';
const M8_SLOT2_HEX =
  '0200000000010110cd440e3990b967a1df437c691b7eff32d1378d2921e45fb407d06abbaddcc80100000000fdffffff0200'
  + '00000000000000466a4400bf0002bb2275c256e12d1be89a65e6c424dad04049603bfe4464209b6482fd287196e85aba66ac'
  + 'b0f574699cc225d4352bceed6369622c2a00e70301000000000000000898e70200000000160014db7771e5af10b85d1c58c5'
  + '90c2dffb4921608f0c02483045022100d74e0e55f028df5d9c261e8ad3373df98e46371326625812f966b5595f17d6660220'
  + '18228b09b8b2f3725c60cbebc308197f246eb055d34b0bf29cfaeb2e0c88ef35012103658c8d7403929edc634f90e07de303'
  + '82c8baee5c978da87703108910366cbe14ff64cd1d';
const M8_SLOT130_HEX =
  '02000000000101b6ee39149331894f6ae57c11a2846ba974c51521f402d693ce717a5be68c5ad30100000000fdffffff0200'
  + '00000000000000466a4400bf008282b0057c96e3b9f4decefdabdabf7c95b30bcb502d4c9a9e8349bacaba93f4625aba66ac'
  + 'b0f574699cc225d4352bceed6369622c2a00e703010000000000000090c9f5050000000016001423da251c7ba1c4e3292a0a'
  + '79f3093008d930d2cf02473044022075d8e5526df8994dc3b629988896dd1ffcdf53be80b52d3dac85a84c05c06073022057'
  + '25730ad109636c2c67cf9fdfc7ea101319cad023a3571415cbea38a8613e250121027182d035f4f5767ce3f7fe5e32b03be3'
  + '6aac550c6cc9c50aeb6f1c519e15909b00000000';
// The slot-130 bid without segwit marker, flag and witness: the same txid.
const M8_SLOT130_LEGACY_HEX =
  '0200000001b6ee39149331894f6ae57c11a2846ba974c51521f402d693ce717a5be68c5ad30100000000fdffffff02000000'
  + '0000000000466a4400bf008282b0057c96e3b9f4decefdabdabf7c95b30bcb502d4c9a9e8349bacaba93f4625aba66acb0f5'
  + '74699cc225d4352bceed6369622c2a00e703010000000000000090c9f5050000000016001423da251c7ba1c4e3292a0a79f3'
  + '093008d930d2cf00000000';

// The legacy bid with its two outputs swapped: the M8 script is output 1.
const M8_SLOT130_SWAPPED_HEX =
  '0200000001b6ee39149331894f6ae57c11a2846ba974c51521f402d693ce717a5be68c5ad30100000000fdffffff0290c9f5'
  + '050000000016001423da251c7ba1c4e3292a0a79f3093008d930d2cf0000000000000000466a4400bf008282b0057c96e3b9'
  + 'f4decefdabdabf7c95b30bcb502d4c9a9e8349bacaba93f4625aba66acb0f574699cc225d4352bceed6369622c2a00e70301'
  + '0000000000000000000000';

const FREEBANK_MERKLEROOT = '62f493bacaba49839e9a4c2d50cb0bb3957cbfdaabfdcedef4b9e3967c05b082'; // FreeBank block 2's h*
const M8_TXID = 'f73fb24249636ccd23fcd6efe8754346ba1de5d20ecf929e404b8a6b9ec29f9d';
const PREV_ECASH_BLOCK = '000000000000000103e7002a2c626963edce2b35d425c29c6974f5b0ac66ba5a';

function block(...txs: string[]): Buffer {
  return Buffer.from(HEADER_HEX + txs.length.toString(16).padStart(2, '0') + txs.join(''), 'hex');
}

describe('FreeBank BMM parser', () => {
  const records = parseBmmBlock(block(COINBASE_HEX, M8_SLOT2_HEX, M8_SLOT130_HEX));

  test('header: the block hash and the previous block', () => {
    expect(records.hash).toEqual(ECASH_BLOCK_HASH);
    expect(records.prevBlock).toEqual(PREV_ECASH_BLOCK);
  });

  test('M7s in the coinbase, in output order; the other OP_RETURNs are skipped', () => {
    expect(records.coinbaseM7.map((m) => m.slot)).toEqual([255, 2, 9, 4, 13, 130]);
    const freebank = records.coinbaseM7.find((m) => m.slot === 130);
    expect(freebank?.hstar).toEqual(FREEBANK_MERKLEROOT);
  });

  test('M8s: the slot-2 decoy and FreeBank\'s bid', () => {
    expect(records.m8).toHaveLength(2);
    const [decoy, bid] = records.m8;
    expect(decoy.slot).toEqual(2);
    expect(decoy.index).toEqual(1);
    expect(decoy.hstar).toEqual(records.coinbaseM7.find((m) => m.slot === 2)?.hstar);
    expect(decoy.prev).toEqual(PREV_ECASH_BLOCK);
    expect(bid).toEqual({
      slot: 130,
      hstar: FREEBANK_MERKLEROOT,
      prev: PREV_ECASH_BLOCK,
      txid: M8_TXID,
      index: 2,
    });
  });

  test('the txid leaves the witness out: the legacy serialization gives the same one', () => {
    const legacy = parseBmmBlock(block(COINBASE_HEX, M8_SLOT130_LEGACY_HEX));
    expect(legacy.m8).toEqual([{ slot: 130, hstar: FREEBANK_MERKLEROOT, prev: PREV_ECASH_BLOCK, txid: M8_TXID, index: 1 }]);
  });

  test('a block without bids', () => {
    const coinbaseOnly = parseBmmBlock(block(COINBASE_HEX));
    expect(coinbaseOnly.coinbaseM7).toHaveLength(6);
    expect(coinbaseOnly.m8).toEqual([]);
  });

  test('only coinbase outputs are M7s, and only an output 0 is an M8', () => {
    // the coinbase moved to position 1: its M7 outputs are not read
    const moved = parseBmmBlock(block(M8_SLOT130_HEX, COINBASE_HEX));
    expect(moved.coinbaseM7).toEqual([]);
    expect(moved.m8.map((m) => m.index)).toEqual([0]);
    const swapped = parseBmmBlock(block(COINBASE_HEX, M8_SLOT130_SWAPPED_HEX));
    expect(swapped.m8).toEqual([]);
  });

  test('a truncated block throws', () => {
    const full = block(COINBASE_HEX, M8_SLOT130_HEX);
    expect(() => parseBmmBlock(full.subarray(0, full.length - 1))).toThrow(FreebankParseError);
    expect(() => parseBmmBlock(full.subarray(0, 80))).toThrow(FreebankParseError);
    expect(() => parseBmmBlock(Buffer.alloc(0))).toThrow(FreebankParseError);
  });
});
