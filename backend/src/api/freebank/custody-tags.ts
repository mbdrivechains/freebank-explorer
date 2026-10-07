import { createHash } from 'crypto';
import { ByteReader, FreebankParsedTx } from './freebank-tx-parser';

// FreeBank custody coins: which outputs the credit rules hold, and what they hold them for.
//
// A custody coin sits on `<push> OP_DROP OP_TRUE`, a script anyone can spend. What locks it is
// a tag the node puts on the coin in its UTXO set when the creating tx connects, and the spend
// guards that check the tag (freebank/src/consensus/tx_verify.cpp:474-600). No RPC exposes the
// tags, so this module works them out again from the creating tx alone, as the node does:
//
//   coinTags() ports AddCoins (freebank/src/coins.cpp:93-297), ApplyBillCoinTags
//   (bill.cpp:168-203) and ApplyPoolCoinTags (pool.cpp:156-255). The node tags by position and
//   payload: which (version, op, output index) gets which tag.
//
// Script shapes (a push of 20, 32 or 33 bytes):
//   32  house escrow  <house hash>          house.cpp:183 HouseEscrowScript
//       bill escrow   <sha256(bill body)>   bill.cpp:127 BillEscrowScript
//       pool escrow   <PoolEscrowTag(id)>   pool.cpp:15-27
//   33  oracle bond   <submitter pubkey>    oracle.cpp:104 OracleBondScript
//   20  note custody  <hash160(holder key)> note.cpp:30 NotePreAuthScript
// Hashes go in the script as the node holds them in memory (uint256 begin..end), which is the
// byte-reverse of the hex the RPCs print (househash, bill_id).
//
// The node also pins each tagged output's script to the canonical one (validation.cpp), so on a
// valid chain a tagged custody coin always carries it. A custody-shaped output that no rule tags
// is locked by nothing: anyone can spend it (the chain relays nonstandard txs).
//
// If freebankd adds a tag or an op, this file must follow it (see the freebank release checklist).

export type CustodyKind =
  | 'house_pledge' // a partner's capital: REGISTER vout[0..partners-1], TOPUP / ADMIT vout[0]
  | 'house_till' // reserves locked at DEFER vout[0]
  | 'house_spread' // note REDEEM vout[1], the redemption spread (brassage)
  | 'house_claim_change' // note CLAIM / term-deposit CLAIM vout[1], escrow change
  | 'bill_escrow' // bill ISSUE vout[1], the escrow bond
  | 'pool_note_reserve' // pool vout[0]: the notes the pool holds (dual-tagged note + pool escrow)
  | 'pool_ecx_reserve' // pool vout[1]: the ECX the pool holds
  | 'oracle_bond' // oracle BOND vout[0]
  | 'note_custody'; // pre-auth DEMAND and PROTEST note outputs: demanded notes held in custody

// Tagged coins that are claims rather than custody: they sit on their holder's own key, and are
// not labelled as custody.
export type ClaimKind = 'bill_title' | 'note' | 'deposit_receipt' | 'lp_share';

export const CUSTODY_KINDS: readonly CustodyKind[] = [
  'house_pledge', 'house_till', 'house_spread', 'house_claim_change', 'bill_escrow',
  'pool_note_reserve', 'pool_ecx_reserve', 'oracle_bond', 'note_custody',
];

export function isCustodyKind(kind: string): kind is CustodyKind {
  return (CUSTODY_KINDS as readonly string[]).includes(kind);
}

/** The tag the node puts on one output, with what the creating tx says about it. */
export interface CoinTag {
  kind: CustodyKind | ClaimKind;
  houseId?: number; // the house (for notes the issuing house; a pool's id is its house's)
  houseHash?: string; // REGISTER: the new house's hash, as listhouses prints househash
  partnerIndex?: number; // REGISTER (the output's index) and TOPUP (from the payload), 0-based
  partnerPubkey?: string; // REGISTER and ADMIT: the partner's key
  billHash?: string; // ISSUE: the bill's hash, as listbills prints bill_id
  billId?: number; // ENDORSE / DISCOUNT: the bill's number, from the payload
  poolId?: number;
  units?: number; // note units the coin carries (pool note reserve, notes)
  protested?: boolean; // note custody re-issued by a PROTEST
  queued?: boolean; // note custody of a demand queued while the house was suspended (v0.2.18 QUEUE bit)
  submitterId?: number; // oracle BOND payload: 0 for a new submitter
  pubkey?: string; // oracle BOND: the submitter's key
  // The push the node requires in this output's script (hex, script byte order), when the tx
  // alone says it. Dense-id house outputs (TOPUP, ADMIT, DEFER, spread, claim change) need the
  // house's hash from listhouses: see expectedHousePush.
  expectedPush?: string;
}

// transaction.h
const V_BILL = 11;
const V_HOUSE = 12;
const V_NOTE = 13;
const V_DEPOSIT = 14;
const V_POOL = 15;
const V_ORACLE = 17;

// note.h
const NOTE_DEMAND_PREAUTH_BIT = 0x80000000;
const NOTE_DEMAND_PROTESTED_BIT = 0x40000000;
const NOTE_DEMAND_QUEUE_BIT = 0x20000000; // v0.2.18: a pre-auth demand filed while the house was suspended
const NOTE_DEMAND_MODE_PREAUTH_QUEUE = 2; // NoteDemand.fPreAuth (0 plain, 1 pre-auth, 2 pre-auth queue)
// pool.h
const POOL_SWAP_NOTE_TO_BTX = 1;
const POOL_SWAP_BTX_TO_NOTE = 2;

const CUSTODY_SCRIPT = /^(14[0-9a-f]{40}|20[0-9a-f]{64}|21[0-9a-f]{66})7551$/;

/** The push of a custody-shaped script (`<20, 32 or 33 bytes> OP_DROP OP_TRUE`), or null. */
export function custodyPush(scriptpubkey: string): string | null {
  const m = CUSTODY_SCRIPT.exec((scriptpubkey || '').toLowerCase());
  return m ? m[1].slice(2) : null;
}

function sha256(b: Buffer): Buffer {
  return createHash('sha256').update(b).digest();
}

function sha256d(b: Buffer): Buffer {
  return sha256(sha256(b));
}

function hash160(b: Buffer): Buffer {
  return createHash('ripemd160').update(sha256(b)).digest();
}

/** Display-order hex (as the RPCs print a uint256) <-> script-order hex. */
export function reverseHex(hex: string): string {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}

/** A std::string as the node serializes it: compact size, then the bytes (short strings only). */
function serString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

/** pool.cpp PoolEscrowTag: sha256d("FreeBankPoolEscrow" || u32le id), as the script pushes it. */
export function poolEscrowPush(poolId: number): string {
  const id = Buffer.alloc(4);
  id.writeUInt32LE(poolId >>> 0);
  return sha256d(Buffer.concat([serString('FreeBankPoolEscrow'), id])).toString('hex');
}

/** The escrow push of a house whose hash listhouses prints as `househash`. */
export function expectedHousePush(househash: string): string {
  return reverseHex(househash);
}

function u64Vector(r: ByteReader): number[] {
  const count = r.compactSize();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(r.u64());
  }
  return out;
}

// Fills `tags` in the order the node decides them. Tags the node sets by position alone are set
// before the payload is read, so a payload cut short (the read throws) keeps exactly those.
function readTags(tx: FreebankParsedTx, tags: (CoinTag | null)[]): void {
  const set = (n: number, tag: CoinTag): CoinTag => {
    if (n >= 0 && n < tags.length) {
      tags[n] = tag;
    }
    return tag;
  };
  const r = new ByteReader(tx.payload as Buffer);
  const op = tx.op;

  switch (tx.version) {
    case V_BILL: {
      // bill.cpp ApplyBillCoinTags: ISSUE vout[0] title + vout[1] escrow; ENDORSE vout[0];
      // DISCOUNT vout[0] title + vout[1..nNoteOutputs] the house's notes
      if (op === 1) {
        set(0, { kind: 'bill_title' });
        const escrow = set(1, { kind: 'bill_escrow' });
        const billId = sha256(r.varBytes()); // BillIDFromBody: sha256 of vchEncryptedBody
        escrow.expectedPush = billId.toString('hex');
        escrow.billHash = reverseHex(escrow.expectedPush);
      } else if (op === 2) {
        set(0, { kind: 'bill_title' }).billId = r.u32();
      } else if (op === 5) {
        const title = set(0, { kind: 'bill_title' });
        title.billId = r.u32();
        const houseId = r.u32();
        r.skip(8 + 8 + 4); // amountPrice, amountFace, nBillMaturityHeight
        const noteOutputs = r.u16();
        const units = u64Vector(r);
        for (let n = 1; n <= noteOutputs && n - 1 < units.length; n++) {
          set(n, { kind: 'note', houseId, units: units[n - 1] });
        }
      }
      break;
    }
    case V_HOUSE: {
      // coins.cpp AddCoins, fHouseTx: REGISTER (and v0.2.19 REGISTER_MO) vout[0..N-1], TOPUP / ADMIT / DEFER vout[0]
      if (op === 1 || op === 11) {
        // HouseRegister. The house hash is HouseDeclarationDigest: sha256d over a tag and the
        // payload's fields before the partner signatures (house.cpp:19-39).
        r.u8(); // nTier
        r.u32(); // nThresholdM
        r.varBytes(); // strClassID
        r.u64(); // nDenomMgGold
        r.varBytes(); // vchRedemptionDestPK
        const partners: string[] = [];
        const partnerCount = r.compactSize();
        for (let i = 0; i < partnerCount; i++) {
          partners.push(r.varBytes().toString('hex'));
        }
        const pledges = r.compactSize();
        r.skip(8 * pledges);
        const declaration = (tx.payload as Buffer).subarray(0, r.pos);
        // v0.2.19 REGISTER_MO: the payload goes on with the partner signatures and the house-type flags; its digest has
        // its own tag and ends with the flags (house.cpp HouseDeclarationDigest), so an open house's id is unchanged
        let flags = 0;
        if (op === 11) {
          const sigs = r.compactSize();
          for (let i = 0; i < sigs; i++) {
            r.varBytes();
          }
          flags = r.u8();
        }
        const hash = (flags
          ? sha256d(Buffer.concat([serString('FreeBankHouse/declaration-mo'), declaration, Buffer.from([flags])]))
          : sha256d(Buffer.concat([serString('FreeBankHouse/declaration'), declaration]))).toString('hex');
        partners.forEach((partnerPubkey, i) => {
          set(i, { kind: 'house_pledge', houseHash: reverseHex(hash), partnerIndex: i, partnerPubkey, expectedPush: hash });
        });
      } else if (op === 2) {
        const pledge = set(0, { kind: 'house_pledge' });
        pledge.houseId = r.u32();
        pledge.partnerIndex = r.u32();
      } else if (op === 3) {
        const pledge = set(0, { kind: 'house_pledge' });
        pledge.houseId = r.u32();
        pledge.partnerPubkey = r.varBytes().toString('hex');
      } else if (op === 8) {
        set(0, { kind: 'house_till' }).houseId = r.u32();
      }
      break;
    }
    case V_NOTE: {
      // AddCoins, fNoteTx: MINT / TRANSFER / DEMAND / PROTEST re-issue notes at
      // vout[0..vUnits-1]; REDEEM with a spread and CLAIM with change re-tag vout[1] as escrow
      const houseId = r.u32();
      if (op === 1 || op === 2) {
        const units = u64Vector(r);
        if (houseId !== 0) {
          units.forEach((u, i) => set(i, { kind: 'note', houseId, units: u }));
        }
      } else if (op === 4 || op === 5) {
        // v0.2.20 token records (note.cpp ApplyNoteCoinTags): LOCK, the mint record, returns change notes at
        // vout[0..]; UNLOCK, the burn record, issues the released backing as notes at vout[0..]
        if (op === 4) {
          r.u64(); // nUnits, into the token backing
        }
        const units = u64Vector(r); // LOCK vChangeUnits, UNLOCK vUnits
        if (houseId !== 0) {
          units.forEach((u, i) => set(i, { kind: 'note', houseId, units: u }));
        }
      } else if (op === 7 || op === 8) {
        const units = u64Vector(r);
        const holder = r.varBytes();
        r.varBytes(); // vchHolderSig
        let preAuth: boolean;
        let protested = false;
        let queued = false;
        if (op === 7) {
          const mode = r.u8(); // fPreAuth: the demand mode; any non-zero mode is pre-authorised
          preAuth = mode !== 0;
          queued = mode === NOTE_DEMAND_MODE_PREAUTH_QUEUE;
        } else {
          const tag = r.u32(); // nDemandTag, re-issued unchanged
          preAuth = (tag & NOTE_DEMAND_PREAUTH_BIT) !== 0;
          protested = (tag & NOTE_DEMAND_PROTESTED_BIT) !== 0;
          queued = (tag & NOTE_DEMAND_QUEUE_BIT) !== 0;
        }
        if (houseId !== 0) {
          // a pre-auth demand moves the notes onto the holder's custody script (note.cpp:212-226)
          const expectedPush = preAuth ? hash160(holder).toString('hex') : undefined;
          units.forEach((u, i) => set(i, preAuth
            ? { kind: 'note_custody', houseId, units: u, protested, queued, expectedPush }
            : { kind: 'note', houseId, units: u }));
        }
      } else if (op === 3 || op === 6) {
        if (r.u8() !== 0) { // fBrassage / fEscrowChange
          set(1, { kind: op === 3 ? 'house_spread' : 'house_claim_change', houseId });
        }
      }
      break;
    }
    case V_DEPOSIT: {
      // AddCoins, fDepositTx: ORIGINATE receipts at vout[0..n-1], TRANSFER vout[0], CLAIM change
      const houseId = r.u32();
      if (op === 1) {
        const principals = u64Vector(r);
        if (houseId !== 0) {
          principals.forEach((_, i) => set(i, { kind: 'deposit_receipt', houseId }));
        }
      } else if (op === 2) {
        if (houseId !== 0) {
          set(0, { kind: 'deposit_receipt', houseId });
        }
      } else if (op === 4) {
        if (r.u8() !== 0) { // fEscrowChange
          set(1, { kind: 'house_claim_change', houseId });
        }
      }
      break;
    }
    case V_POOL:
      poolTags(r, op, set);
      break;
    case V_ORACLE: {
      // AddCoins: BOND vout[0] is the bond escrow (SUBMIT tags nothing)
      if (op === 1) {
        const bond = set(0, { kind: 'oracle_bond' });
        bond.submitterId = r.u32();
        r.u32(); // nTargetHeight
        bond.pubkey = r.varBytes().toString('hex');
        bond.expectedPush = bond.pubkey;
      }
      break;
    }
    default:
      break;
  }
}

/** pool.cpp ApplyPoolCoinTags: vout[0] note reserve and vout[1] ECX reserve, then payouts. */
function poolTags(r: ByteReader, op: number | null, set: (n: number, tag: CoinTag) => CoinTag): void {
  const poolId = r.u32();
  const push = poolEscrowPush(poolId);
  const reserves = (noteUnits: number): void => {
    set(0, { kind: 'pool_note_reserve', houseId: poolId, poolId, units: noteUnits, expectedPush: push });
    set(1, { kind: 'pool_ecx_reserve', houseId: poolId, poolId, expectedPush: push });
  };
  const notes = (n: number, units: number): void => {
    set(n, { kind: 'note', houseId: poolId, units });
  };
  const lp = (n: number): void => {
    set(n, { kind: 'lp_share', houseId: poolId, poolId });
  };

  if (op === 1) { // CREATE
    r.u32(); // nFeeBps
    const initNotes = r.u64();
    r.i64(); // amountInitBtx
    const noteChange = r.u64();
    reserves(initNotes);
    lp(2);
    if (noteChange > 0) {
      notes(3, noteChange);
    }
  } else if (op === 2) { // ADD_LIQ
    const priorNotes = r.u64();
    r.skip(8 + 8); // prior ECX reserve, prior LP supply
    const addNotes = r.u64();
    r.skip(8 + 8); // amountAddBtx, nLpMinted
    const noteChange = r.u64();
    reserves(priorNotes + addNotes);
    lp(2);
    if (noteChange > 0) {
      notes(3, noteChange);
    }
  } else if (op === 3) { // REMOVE_LIQ
    const priorNotes = r.u64();
    r.skip(8 + 8 + 8); // prior ECX reserve, prior LP supply, nBurnLp
    const noteOut = r.u64();
    const ecxOut = r.i64();
    const lpChange = r.u64();
    if (noteOut > priorNotes) {
      return; // shape-rejected by the node; it never tags from inconsistent data
    }
    reserves(priorNotes - noteOut);
    // payouts pack in order: notes (if any), ECX (plain, if any), LP change (if any)
    let idx = 2;
    if (noteOut > 0) {
      notes(idx, noteOut);
      idx++;
    }
    if (ecxOut > 0) {
      idx++;
    }
    if (lpChange > 0) {
      lp(idx);
    }
  } else if (op === 4) { // SWAP
    const priorNotes = r.u64();
    r.skip(8 + 8); // prior ECX reserve, prior LP supply
    const direction = r.u8();
    const amountIn = r.u64();
    r.skip(8); // nMinOut
    const amountOut = r.u64();
    const noteChange = r.u64();
    if (direction === POOL_SWAP_NOTE_TO_BTX) {
      reserves(priorNotes + amountIn);
      // vout[2] is the plain ECX payout
      if (noteChange > 0) {
        notes(3, noteChange);
      }
    } else if (direction === POOL_SWAP_BTX_TO_NOTE && amountOut <= priorNotes) {
      reserves(priorNotes - amountOut);
      notes(2, amountOut);
    }
  }
  // RETIRE (5) re-issues nothing: every output is plain
}

/**
 * The tag the node puts on each output of a transaction, by output index (null: untagged).
 * Only credit transactions (v11-v17) tag anything. From a payload the node could not decode,
 * only what the node tags by position alone (bill ISSUE / ENDORSE / DISCOUNT vout[0], ISSUE
 * vout[1], house TOPUP / ADMIT / DEFER vout[0], oracle BOND vout[0]).
 */
export function coinTags(tx: FreebankParsedTx): (CoinTag | null)[] {
  const tags: (CoinTag | null)[] = tx.vout.map(() => null);
  if (tx.payload === null || tx.op === null) {
    return tags;
  }
  try {
    readTags(tx, tags);
  } catch {
    // a payload cut short: what is set so far is what the node tags without it
  }
  return tags;
}

// ---- Labels ------------------------------------------------------------------------------

/**
 * What the node's credit RPCs say about the instruments behind custody coins, at one tip:
 * dense numbers for hashes (listhouses househash, listbills bill_id), partner keys, listed
 * pools and oracle submitters. Houses and bills are numbered in connect order, so a directory
 * is only good for the tip it was read at.
 */
export interface CustodyDirectory {
  houseIdByHash(househash: string): number | undefined;
  houseHashById(houseId: number): string | undefined;
  partnerIndex(houseId: number, pubkey: string): number | undefined;
  billIdByHash(billHash: string): number | undefined;
  poolListed(poolId: number): boolean;
  submitterIdByPubkey(pubkey: string): number | undefined;
}

export type CustodyLabelKind = CustodyKind | 'lookalike';

/** One custody label, as GET /api/v1/freebank/custody returns it. */
export interface CustodyLabel {
  kind: CustodyLabelKind;
  text: string; // e.g. 'House 3 · pledge (partner 0)'
  tooltip: string;
  link: string | null; // a page of this explorer: /house/3, /bill/12, /pool/2, /gold
  house_id?: number;
  partner_index?: number;
  bill_id?: number;
  pool_id?: number;
  submitter_id?: number;
  units?: number; // note units the coin carries
  protested?: boolean;
}

const LOCKED = 'Locked by the FreeBank credit rules, not by a key';
const HOUSE_SPENDERS = 'only the house\'s reclaim or release, or an insolvency claim, can spend it.';

export const CUSTODY_TOOLTIPS: Readonly<Record<CustodyLabelKind, string>> = {
  house_pledge: `Capital a partner put behind the house. ${LOCKED}: ${HOUSE_SPENDERS}`,
  house_till: `Reserves the house locked when it deferred payment. ${LOCKED}: ${HOUSE_SPENDERS}`,
  house_spread: `The spread kept back when notes were redeemed, added to the house's escrow. ${LOCKED}: ${HOUSE_SPENDERS}`,
  house_claim_change: `What an insolvency claim left of the house's escrow. ${LOCKED}: ${HOUSE_SPENDERS}`,
  bill_escrow: `The bond posted when the bill was issued. ${LOCKED}: only the bill's own transactions can spend it.`,
  pool_note_reserve: `Notes the pool holds. ${LOCKED}: only the pool's own transactions can spend them.`,
  pool_ecx_reserve: `ECX the pool holds. ${LOCKED}: only the pool's own transactions can spend it.`,
  oracle_bond: `The bond a gold-price submitter posted. ${LOCKED}: only a new bond by the same submitter can spend it.`,
  note_custody: `Notes whose holder demanded payment and signed a standing order, so the house can pay them without the holder. ${LOCKED}.`,
  lookalike: 'Shaped like a FreeBank custody output, but no credit rule locks it: anyone can spend it.',
};

const unitsFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatUnits(units: number): string {
  return `${unitsFormat.format(units)} ${units === 1 ? 'unit' : 'units'}`;
}

function lookalike(): CustodyLabel {
  return { kind: 'lookalike', text: 'Unlocked look-alike (anyone can spend)', tooltip: CUSTODY_TOOLTIPS.lookalike, link: null };
}

const HOUSE_ESCROW_KINDS: readonly CustodyKind[] = ['house_pledge', 'house_till', 'house_spread', 'house_claim_change'];

/**
 * The custody label of one output (script + the tag its creating tx gives it), or null when it
 * is not custody-shaped or is a claim coin. A custody-shaped output gets:
 * - its custody label, when the node tags it and the script carries the push the node pins for
 *   that tag (checked for every kind whose push can be known: the tx alone, or for a house
 *   numbered in the payload, the directory);
 * - 'Unlocked look-alike (anyone can spend)' otherwise.
 */
export function custodyLabel(scriptpubkey: string, tag: CoinTag | null, dir: CustodyDirectory): CustodyLabel | null {
  const push = custodyPush(scriptpubkey);
  if (push === null) {
    return null;
  }
  if (tag && !isCustodyKind(tag.kind)) {
    return null; // a claim coin: its tag locks it to its holder's transactions
  }
  if (!tag) {
    return lookalike();
  }
  let expected = tag.expectedPush;
  if (expected === undefined && tag.houseId !== undefined && HOUSE_ESCROW_KINDS.includes(tag.kind as CustodyKind)) {
    const househash = dir.houseHashById(tag.houseId);
    expected = househash ? expectedHousePush(househash) : undefined;
  }
  if (expected !== undefined && expected !== push) {
    return lookalike();
  }

  const kind = tag.kind as CustodyKind;
  const label: CustodyLabel = { kind, text: '', tooltip: CUSTODY_TOOLTIPS[kind], link: null };
  switch (kind) {
    case 'house_pledge':
    case 'house_till':
    case 'house_spread':
    case 'house_claim_change':
    case 'note_custody': {
      const houseId = tag.houseId ?? (tag.houseHash ? dir.houseIdByHash(tag.houseHash) : undefined);
      const what = houseText(kind, tag, houseId, dir, label);
      if (houseId === undefined) {
        // only a REGISTER that has not connected yet (or a payload cut short) names no house
        label.text = kind === 'house_pledge' && tag.houseHash ? 'House pledge (new house)'
          : kind === 'note_custody' ? `Notes · ${what}` : `House ${what}`;
      } else {
        label.house_id = houseId;
        label.text = kind === 'note_custody' ? `House ${houseId} notes · ${what}` : `House ${houseId} · ${what}`;
        label.link = `/house/${houseId}`;
      }
      break;
    }
    case 'bill_escrow': {
      const billId = tag.billHash ? dir.billIdByHash(tag.billHash) : undefined;
      if (billId === undefined) {
        label.text = tag.billHash ? 'Bill escrow (new bill)' : 'Bill escrow bond';
      } else {
        label.bill_id = billId;
        label.text = `Bill ${billId} · escrow bond`;
        label.link = `/bill/${billId}`;
      }
      break;
    }
    case 'pool_note_reserve':
    case 'pool_ecx_reserve': {
      const poolId = tag.poolId as number;
      label.pool_id = poolId;
      if (kind === 'pool_note_reserve') {
        label.units = tag.units;
        label.text = `Pool ${poolId} · note reserve (${formatUnits(tag.units as number)})`;
      } else {
        label.text = `Pool ${poolId} · ECX reserve`;
      }
      // a retired pool is no longer listed, and has no page
      label.link = dir.poolListed(poolId) ? `/pool/${poolId}` : null;
      break;
    }
    case 'oracle_bond': {
      const submitterId = tag.submitterId || (tag.pubkey ? dir.submitterIdByPubkey(tag.pubkey) : undefined);
      if (submitterId) {
        label.submitter_id = submitterId;
        label.text = `Oracle bond · submitter ${submitterId}`;
      } else {
        label.text = 'Oracle bond (new submitter)';
      }
      label.link = '/gold';
      break;
    }
  }
  return label;
}

/** The part of a house custody label after 'House N · ' (and the fields it names). */
function houseText(kind: CustodyKind, tag: CoinTag, houseId: number | undefined, dir: CustodyDirectory, label: CustodyLabel): string {
  switch (kind) {
    case 'house_pledge': {
      const partner = tag.partnerIndex
        ?? (houseId !== undefined && tag.partnerPubkey ? dir.partnerIndex(houseId, tag.partnerPubkey) : undefined);
      if (partner === undefined) {
        return 'pledge (new partner)';
      }
      label.partner_index = partner;
      return `pledge (partner ${partner})`;
    }
    case 'house_till':
      return 'till locked at deferral';
    case 'house_spread':
      return 'escrow (redemption spread)';
    case 'house_claim_change':
      return 'escrow (claim change)';
    default: { // note_custody
      label.units = tag.units;
      if (tag.protested) {
        label.protested = true;
      }
      const demanded = tag.queued ? 'demanded while suspended (queued)' : 'demanded';
      return `${tag.protested ? `${demanded} and protested` : demanded}, held in custody (${formatUnits(tag.units as number)})`;
    }
  }
}
