import { merkleBranch, merkleRootFromBranch } from '../../api/bitcoin/merkle';

// Bitcoin block 100000: four transactions and their merkle root, a well-known example.
const BLOCK_100000 = [
  '8c14f0db3df150123e6f3dbbf30f8b955a8249b62ac1d1ff16284aefa3d06d87',
  'fff2525b8931402dd09222c50775608f75787bd2b87e56995a7bdd30f79702c4',
  '6359f0868171b1d194cbee1af2f16ea598ae8fad666d9b012c8ed2b79a236ec4',
  'e9a66845e05d5abc0ad04ec80f774a7e585c6e8db975962d069a522137b80c1d',
];
const ROOT_100000 = 'f3e94742aca4b5ef85488dc37c06c3282295ffec960994b2c0d5ac2a25a95766';

describe('FreeBank merkle proofs (RPC backend)', () => {
  test.each([0, 1, 2, 3])('block 100000: the branch of tx %i proves the header merkle root', (pos) => {
    const branch = merkleBranch(BLOCK_100000, pos);
    expect(branch).toHaveLength(2);
    expect(merkleRootFromBranch(BLOCK_100000[pos], branch, pos)).toBe(ROOT_100000);
  });

  test('a coinbase-only block: empty branch, the root is the txid', () => {
    expect(merkleBranch([BLOCK_100000[0]], 0)).toEqual([]);
    expect(merkleRootFromBranch(BLOCK_100000[0], [], 0)).toBe(BLOCK_100000[0]);
  });

  test('an odd count: the last hash pairs with itself, and every position proves the same root', () => {
    const txids = BLOCK_100000.slice(0, 3);
    const roots = txids.map((txid, pos) => merkleRootFromBranch(txid, merkleBranch(txids, pos), pos));
    expect(new Set(roots).size).toBe(1);
    expect(merkleBranch(txids, 2)[0]).toBe(txids[2]);
  });

  test('a wrong position does not prove the root', () => {
    const branch = merkleBranch(BLOCK_100000, 1);
    expect(merkleRootFromBranch(BLOCK_100000[1], branch, 0)).not.toBe(ROOT_100000);
  });

  test('a position out of range is refused', () => {
    expect(() => merkleBranch(BLOCK_100000, 4)).toThrow();
    expect(() => merkleBranch(BLOCK_100000, -1)).toThrow();
  });
});
