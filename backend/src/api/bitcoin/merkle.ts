import * as crypto from 'crypto';

// FreeBank: merkle proofs computed from a block's txids, for the RPC backend, which has no esplora to ask. The format is
// esplora's GET /tx/:txid/merkle-proof: the sibling hashes from the transaction up to the root, each in display
// (byte-reversed) hex, and the transaction's position in the block. Bitcoin's rule: a level with an odd count pairs its
// last hash with itself.

function sha256d(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(data).digest()).digest();
}

const internal = (hex: string): Buffer => Buffer.from(hex, 'hex').reverse();
const display = (hash: Buffer): string => Buffer.from(hash).reverse().toString('hex');

/** The merkle branch of txids[pos], from the leaf up, in display hex. */
export function merkleBranch(txids: string[], pos: number): string[] {
  if (!Number.isInteger(pos) || pos < 0 || pos >= txids.length) {
    throw new Error('Transaction position out of range');
  }
  let level = txids.map(internal);
  let index = pos;
  const branch: string[] = [];
  while (level.length > 1) {
    if (level.length % 2) {
      level.push(level[level.length - 1]);
    }
    branch.push(display(level[index ^ 1]));
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
    index >>= 1;
  }
  return branch;
}

/** The merkle root that a branch proves for the txid at pos, in display hex. */
export function merkleRootFromBranch(txid: string, branch: string[], pos: number): string {
  let hash = internal(txid);
  let index = pos;
  for (const sibling of branch) {
    hash = index & 1
      ? sha256d(Buffer.concat([internal(sibling), hash]))
      : sha256d(Buffer.concat([hash, internal(sibling)]));
    index >>= 1;
  }
  return display(hash);
}
