import { createHash } from 'crypto';

/**
 * easynet: BIP 300 sidechain slots replayed from the blocks' coinbases, by the enforcer's own rules
 * (bip300301_enforcer mb/easynet 716ec80):
 * - messages: lib/messages.rs (CoinbaseMessage::parse, M1ProposeSidechain, M2AckSidechain);
 * - declaration: lib/types.rs (SidechainDeclaration::try_parse);
 * - state: lib/validator/task/mod.rs (handle_m1_propose_sidechain, handle_m2_ack_sidechain,
 *   handle_failed_sidechain_proposals) and lib/validator/dbs/diff.rs (an activated proposal leaves the proposal list);
 * - thresholds: lib/types.rs (Thresholds).
 * Pure code (no node, no database), so the tests can replay any chain.
 */

export interface SidechainRules {
  name: string;
  unusedMaxAge: number;      // an unused slot: the proposal must be acked by more than unusedThreshold blocks...
  unusedThreshold: number;   // ...within unusedMaxAge blocks of its M1
  usedMaxAge: number;        // a used slot (replacing an active sidechain): the same, with these numbers
  usedThreshold: number;
}

export const SIDECHAIN_RULES: { [name: string]: SidechainRules } = {
  short: { name: 'short', unusedMaxAge: 10, unusedThreshold: 5, usedMaxAge: 10, usedThreshold: 5 },  // easynet, regtest
  alphanet: { name: 'alphanet', unusedMaxAge: 36, unusedThreshold: 30, usedMaxAge: 144, usedThreshold: 72 },
  betanet: { name: 'betanet', unusedMaxAge: 2016, unusedThreshold: 1008, usedMaxAge: 26300, usedThreshold: 13150 },
  mainnet: { name: 'mainnet', unusedMaxAge: 2016, unusedThreshold: 1815, usedMaxAge: 26300, usedThreshold: 13150 },
};

export const M1_TAG = 'd5e0c4af';
export const M2_TAG = 'd6e1c5df';
const ACK_HEIGHTS_KEPT = 200; // per proposal; the count is always exact

export interface SidechainDeclaration {
  title: string;
  description: string;
  hashId1: string;   // hex, as in the M1
  hashId2: string;
}

export interface SidechainProposal {
  slot: number;
  descriptionHash: string;           // sha256d of the description, reversed (as the enforcer's API prints it)
  descriptionHex: string;
  declaration: SidechainDeclaration | null;   // null: not a version-0 declaration (the proposal still counts)
  height: number;                    // the block with the M1
  blockHash: string;
  txid: string;                      // that block's coinbase
  vout: number;
  votes: number;                     // M2 acks counted by the rules
  lastAckHeight: number | null;
  ackHeights: number[];              // the latest ACK_HEIGHTS_KEPT
  status: 'pending' | 'active' | 'replaced' | 'failed';
  activationHeight: number | null;
  replacedSlotTaken: boolean;        // it activated into a used slot, replacing that sidechain
  endHeight: number | null;          // failed (dropped) or replaced at this block
}

export interface SidechainEvent {
  height: number;
  type: 'proposed' | 'activated' | 'replaced' | 'failed';
  slot: number;
  descriptionHash: string;
  title: string | null;
}

export interface SidechainState {
  height: number;                    // last block replayed (-1: none)
  hash: string;
  proposals: SidechainProposal[];    // every proposal ever made, in order
  pending: number[];                 // indexes into proposals: the enforcer's proposal list
  active: { [slot: string]: number };   // slot -> index into proposals
  events: SidechainEvent[];          // newest last; the latest 500
}

export interface CoinbaseOutput {
  n: number;
  hex: string;   // scriptPubKey
}

const EVENTS_KEPT = 500;

export function emptySidechainState(): SidechainState {
  return { height: -1, hash: '', proposals: [], pending: [], active: {}, events: [] };
}

/** sha256d of the bytes, in the reversed order the enforcer prints. */
export function descriptionHash(bytes: Buffer): string {
  const once = createHash('sha256').update(bytes).digest();
  return Buffer.from(createHash('sha256').update(once).digest()).reverse().toString('hex');
}

/** The data of `OP_RETURN <one push>` with nothing after it, as CoinbaseMessage::parse takes it; else null. */
export function opReturnPush(script: Buffer): Buffer | null {
  if (script.length < 1 || script[0] !== 0x6a) {
    return null;
  }
  let pos = 1;
  if (pos >= script.length) {
    return null;
  }
  const op = script[pos++];
  let len: number;
  if (op <= 0x4b) {
    len = op;
  } else if (op === 0x4c) {
    if (pos + 1 > script.length) { return null; }
    len = script[pos]; pos += 1;
  } else if (op === 0x4d) {
    if (pos + 2 > script.length) { return null; }
    len = script.readUInt16LE(pos); pos += 2;
  } else if (op === 0x4e) {
    if (pos + 4 > script.length) { return null; }
    len = script.readUInt32LE(pos); pos += 4;
  } else {
    return null; // an opcode, not a push
  }
  if (pos + len !== script.length) {
    return null; // short push, or trailing instructions after the message
  }
  return script.subarray(pos, pos + len);
}

/** SidechainDeclaration::try_parse: version 0, title length + title, description, hash id 1 (32), hash id 2 (20). */
export function parseDeclaration(d: Buffer): SidechainDeclaration | null {
  if (d.length < 2 || d[0] !== 0) {
    return null;
  }
  const titleLength = d[1];
  const titleEnd = 2 + titleLength;
  if (titleEnd > d.length || d.length - titleEnd < 52) {
    return null;
  }
  const descriptionEnd = d.length - 52;
  const title = utf8(d.subarray(2, titleEnd));
  const description = utf8(d.subarray(titleEnd, descriptionEnd));
  if (title === null || description === null) {
    return null;
  }
  return {
    title,
    description,
    hashId1: d.subarray(descriptionEnd, descriptionEnd + 32).toString('hex'),
    hashId2: d.subarray(descriptionEnd + 32).toString('hex'),
  };
}

function utf8(b: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch (e) {
    return null;
  }
}

type Message = { kind: 'm1', vout: number, slot: number, description: Buffer }
  | { kind: 'm2', vout: number, slot: number, hash: string };

/** The coinbase's M1 and M2 messages in output order; repeats a valid block cannot hold are dropped. */
export function coinbaseMessages(outputs: CoinbaseOutput[]): Message[] {
  const out: Message[] = [];
  const m1Seen = new Set<string>();
  const m2Slots = new Set<number>();
  for (const o of outputs) {
    const data = opReturnPush(Buffer.from(o.hex, 'hex'));
    if (!data || data.length < 4) {
      continue;
    }
    const tag = data.subarray(0, 4).toString('hex');
    if (tag === M1_TAG && data.length >= 5) {
      const description = Buffer.from(data.subarray(5));
      const key = data[4] + ':' + descriptionHash(description);
      if (!m1Seen.has(key)) { // the enforcer rejects a block with the same M1 twice (DuplicateM1)
        m1Seen.add(key);
        out.push({ kind: 'm1', vout: o.n, slot: data[4], description });
      }
    } else if (tag === M2_TAG && data.length === 37) { // exactly slot + 32-byte hash (BIP 300: 38-byte script)
      if (!m2Slots.has(data[4])) { // DuplicateM2: one ack per slot per block
        m2Slots.add(data[4]);
        out.push({ kind: 'm2', vout: o.n, slot: data[4], hash: Buffer.from(data.subarray(5, 37)).reverse().toString('hex') });
      }
    }
  }
  return out;
}

function windowFor(rules: SidechainRules, used: boolean): { maxAge: number, threshold: number } {
  return used ? { maxAge: rules.usedMaxAge, threshold: rules.usedThreshold }
    : { maxAge: rules.unusedMaxAge, threshold: rules.unusedThreshold };
}

/** The block at which a pending proposal fails if it gets no more acks (and the slot's use does not change). */
export function failsAtHeight(p: SidechainProposal, rules: SidechainRules, slotUsed: boolean): number {
  const { maxAge, threshold } = windowFor(rules, slotUsed);
  const maxFails = Math.max(0, maxAge - threshold);
  const age = Math.min(maxAge + 1, Math.max(maxFails + 1, maxFails + p.votes));
  return p.height + age;
}

function pushEvent(state: SidechainState, e: SidechainEvent): void {
  state.events.push(e);
  if (state.events.length > EVENTS_KEPT) {
    state.events.splice(0, state.events.length - EVENTS_KEPT);
  }
}

/** Replay one block (the next one: height = state.height + 1) on the state, in place. */
export function applyBlock(state: SidechainState, rules: SidechainRules, startHeight: number,
  block: { height: number, hash: string, coinbaseTxid: string, outputs: CoinbaseOutput[] }): void {
  const height = block.height;
  state.height = height;
  state.hash = block.hash;
  if (height < startHeight) {
    return; // plain history below the enforcer's activation height
  }
  const keyOf = (p: SidechainProposal): string => p.slot + ':' + p.descriptionHash;
  for (const m of coinbaseMessages(block.outputs)) {
    if (m.kind === 'm1') {
      const hash = descriptionHash(m.description);
      if (state.pending.some((i) => keyOf(state.proposals[i]) === m.slot + ':' + hash)) {
        continue; // the same proposal is already open: an M1 cannot reset its votes
      }
      const declaration = parseDeclaration(m.description);
      state.proposals.push({
        slot: m.slot, descriptionHash: hash, descriptionHex: m.description.toString('hex'), declaration,
        height, blockHash: block.hash, txid: block.coinbaseTxid, vout: m.vout, votes: 0, lastAckHeight: null,
        ackHeights: [], status: 'pending', activationHeight: null, replacedSlotTaken: false, endHeight: null,
      });
      state.pending.push(state.proposals.length - 1);
      pushEvent(state, { height, type: 'proposed', slot: m.slot, descriptionHash: hash, title: declaration?.title ?? null });
    } else {
      const at = state.pending.findIndex((i) => keyOf(state.proposals[i]) === m.slot + ':' + m.hash);
      if (at < 0) {
        continue; // no open proposal with this hash
      }
      const index = state.pending[at];
      const p = state.proposals[index];
      if (p.height === height) {
        continue; // an ack in the M1's own block does not count
      }
      p.votes++;
      p.lastAckHeight = height;
      p.ackHeights.push(height);
      if (p.ackHeights.length > ACK_HEIGHTS_KEPT) {
        p.ackHeights.splice(0, p.ackHeights.length - ACK_HEIGHTS_KEPT);
      }
      const age = Math.max(0, height - p.height);
      const current = state.active[m.slot];
      const { maxAge, threshold } = windowFor(rules, current !== undefined);
      if (p.votes > threshold && age <= maxAge) {
        if (current !== undefined) {
          const old = state.proposals[current];
          old.status = 'replaced';
          old.endHeight = height;
          pushEvent(state, { height, type: 'replaced', slot: m.slot, descriptionHash: old.descriptionHash, title: old.declaration?.title ?? null });
          p.replacedSlotTaken = true;
        }
        p.status = 'active';
        p.activationHeight = height;
        state.active[m.slot] = index;
        state.pending.splice(at, 1);
        pushEvent(state, { height, type: 'activated', slot: m.slot, descriptionHash: p.descriptionHash, title: p.declaration?.title ?? null });
      }
    }
  }
  // after the messages, as the enforcer: drop proposals that can no longer activate
  state.pending = state.pending.filter((i) => {
    const p = state.proposals[i];
    const age = Math.max(0, height - p.height);
    const { maxAge, threshold } = windowFor(rules, state.active[p.slot] !== undefined);
    const maxFails = Math.max(0, maxAge - threshold);
    const fails = Math.max(0, age - p.votes);
    if (age > maxAge || (age > maxFails && fails >= maxFails)) {
      p.status = 'failed';
      p.endHeight = height;
      pushEvent(state, { height, type: 'failed', slot: p.slot, descriptionHash: p.descriptionHash, title: p.declaration?.title ?? null });
      return false;
    }
    return true;
  });
}
