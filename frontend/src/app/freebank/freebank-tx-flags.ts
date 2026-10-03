import { unwrapFullDepositAddress } from './deposit-address';

// FreeBank Goggles flags: the credit families (tx versions 11-17) and the transfers to and from
// eCash, as bits of the transaction flags that mempool's Goggles filters match on.
//
// This file is kept byte-identical at backend/src/api/freebank/freebank-tx-flags.ts and
// frontend/src/app/freebank/freebank-tx-flags.ts (backend test freebank-tx-flags.test.ts compares
// them), so both classifiers (backend Common.getTransactionFlags, frontend getTransactionFlags)
// compute the same bits, and both TransactionFlags tables take their FreeBank bits from here.
// Pure TypeScript, no imports.
//
// Bits: free ones of mempool's layout, all at or below bit 52, because flags travel as plain JS
// numbers (the API and the websocket send Number(flags); 2^53 is the limit).
//   29-31  deposit from eCash, withdrawal to eCash, withdrawal refund (request)
//   35     asset created (v10, v0.2.18); a transfer of asset coins is a plain-version tx and has no bit
//   45     credit: any of v11-v17
//   46-52  bill, house, note, term deposit, pool, settlement, oracle
export const FREEBANK_TX_FLAGS = {
  deposit_from_ecash: 1n << 29n,
  withdrawal_to_ecash: 1n << 30n,
  withdrawal_refund: 1n << 31n,
  asset_created: 1n << 35n,
  credit: 1n << 45n,
  bill: 1n << 46n,
  house: 1n << 47n,
  note: 1n << 48n,
  term_deposit: 1n << 49n,
  pool: 1n << 50n,
  settlement: 1n << 51n,
  oracle: 1n << 52n,
};

// credit family bit by tx version (freebank primitives/transaction.h; v10, the asset genesis, is not a
// credit family: it has its own bit). v14 is a TERM deposit, not a deposit from eCash.
export const FREEBANK_CREDIT_FLAG_BY_VERSION: { [version: number]: bigint } = {
  11: FREEBANK_TX_FLAGS.bill,
  12: FREEBANK_TX_FLAGS.house,
  13: FREEBANK_TX_FLAGS.note,
  14: FREEBANK_TX_FLAGS.term_deposit,
  15: FREEBANK_TX_FLAGS.pool,
  16: FREEBANK_TX_FLAGS.settlement,
  17: FREEBANK_TX_FLAGS.oracle,
};

export const ASSET_GENESIS_VERSION = 10; // transaction.h TRANSACTION_BITASSET_CREATE_VERSION

export interface FreebankFlagsTx {
  version: number;
  vin: { is_coinbase?: boolean }[];
  vout: { scriptpubkey?: string, scriptpubkey_address?: string, value?: number }[];
}

// FreeBank protocol outputs are OP_RETURN followed by a raw 4-byte tag (freebank validation.cpp
// Generate*Commit and GenerateWithdrawalRefundRequest, sidechain.cpp SidechainObj::GetScript).
// Block producers write the coinbase ones; the frontend names them in getFreebankOutputLabel.
const COINBASE_TAGS = ['fd7ad1ef', 'a7e67e1f', 'ef5d1dfe', 'fa86c689', 'fb5345de'];
const SIDECHAIN_OBJECT_TAG = 'acdcf66f'; // then one byte: the object type
const COINBASE_OBJECTS = ['44', '50']; // 'D' deposit record, 'P' withdrawal bundle
const DEPOSIT_RECORD = '6a' + SIDECHAIN_OBJECT_TAG + '44';
const WITHDRAWAL = '6a' + SIDECHAIN_OBJECT_TAG + '57'; // 'W', in any tx (the coinbase too)
const WITHDRAWAL_REFUND_REQUEST = '6afcd2e546';
// BIP 141 witness commitment: OP_RETURN, then a 36-byte push of aa21a9ed and the commitment hash
const WITNESS_COMMITMENT = /^6a24aa21a9ed[0-9a-f]{64}/;

/** A coinbase's own commitment: the witness commitment or a FreeBank protocol output. */
export function isCoinbaseCommitment(scriptpubkey: string): boolean {
  const script = scriptpubkey || '';
  if (WITNESS_COMMITMENT.test(script)) {
    return true;
  }
  if (!script.startsWith('6a') || script.length < 10) {
    return false;
  }
  const tag = script.slice(2, 10);
  return tag === SIDECHAIN_OBJECT_TAG ? COINBASE_OBJECTS.includes(script.slice(10, 12)) : COINBASE_TAGS.includes(tag);
}

/** Whether an OP_RETURN output is data for the OP_RETURN filter: not a coinbase's own commitment. */
export function isOpReturnData(tx: FreebankFlagsTx, scriptpubkey: string): boolean {
  return !(tx.vin?.[0]?.is_coinbase && isCoinbaseCommitment(scriptpubkey));
}

const DEPOSIT_FEE = 1000; // szats, kept by the block producer (freebank sidechain.h SIDECHAIN_DEPOSIT_FEE)
const BUNDLE_RETURN_DEST = 'D'; // a record of a withdrawal bundle paid on eCash, not a deposit

// A deposit record's destination and amount: after OP_RETURN, the tag, 'D' and the slot, the
// destination as a length-prefixed string and the amount as 8 bytes little-endian (freebank
// sidechain.cpp SidechainDeposit). Null when the script is not one or is cut short. The same
// reader as the backend's peg-parser.ts readDepositHead, on hex so it runs in the browser too.
function readDepositHead(script: string): { dest: string, amount: number } | null {
  if (!script.startsWith(DEPOSIT_RECORD)) {
    return null;
  }
  let pos = 14;
  const byte = (): number => {
    if (pos + 2 > script.length) {
      throw new Error('short');
    }
    const b = parseInt(script.slice(pos, pos + 2), 16);
    if (!(b >= 0)) {
      throw new Error('not hex');
    }
    pos += 2;
    return b;
  };
  try {
    let len = byte();
    if (len === 0xfd) {
      len = byte() | (byte() << 8);
    } else if (len >= 0xfe) {
      return null; // no address is that long
    }
    let dest = '';
    for (let i = 0; i < len; i++) {
      dest += String.fromCharCode(byte());
    }
    let lo = 0;
    for (let i = 0; i < 4; i++) {
      lo += byte() * 2 ** (8 * i);
    }
    let hi = 0;
    for (let i = 0; i < 4; i++) {
      hi += byte() * 2 ** (8 * i);
    }
    if (hi >= 0x80000000) {
      hi -= 0x100000000;
    }
    return { dest, amount: hi * 0x100000000 + lo };
  } catch {
    return null;
  }
}

// the node's own spelling of a bech32 address: lower case, the HRP, '1', then 6 or more symbols
const BECH32_ADDRESS = /^[a-z0-9]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/;
// C isspace, which base58.cpp skips; String.trim() would strip more (NBSP, U+FEFF, ...)
const C_SPACE_AT_ENDS = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/**
 * Whether a destination string names the address an output pays, as the node reads the string
 * (freebank base58.cpp DecodeDestination). `output` is the node's own spelling of the output's
 * address. bech32 (bech32.cpp Decode) takes the whole string: printable ASCII in one case, lower
 * or upper. base58 (DecodeBase58Check on str.c_str()) stops at the first NUL and skips C
 * whitespace at both ends; whitespace left inside is no address.
 */
export function sameAddress(output: string | undefined, dest: string): boolean {
  if (!output || !dest) {
    return false;
  }
  if (BECH32_ADDRESS.test(output)) {
    return /^[\x21-\x7e]+$/.test(dest) && (dest === dest.toLowerCase() || dest === dest.toUpperCase()) && dest.toLowerCase() === output;
  }
  return dest.split('\0')[0].replace(C_SPACE_AT_ENDS, '') === output;
}

/**
 * Whether a payout output pays a deposit's destination. From v0.2.17 the full deposit address
 * s130_<address>_<checksum> pays exactly <address> in its canonical spelling, which is how the output's address is
 * written (deposit-address.ts, D-2026-09-30-1); any other destination is read as sameAddress reads it.
 */
export function depositPaysTo(output: string | undefined | null, dest: string): boolean {
  const unwrapped = unwrapFullDepositAddress(dest);
  return unwrapped !== null ? !!output && output === unwrapped : sameAddress(output ?? undefined, dest);
}

/** A withdrawal refund request in the node's exact shape (script.cpp IsWithdrawalRefundRequest,
 *  as peg-parser.ts parsePegOutput): 102 bytes, the tag, then a withdrawal id that is not zero. */
export function isRefundRequest(script: string): boolean {
  return script.length === 204 && script.startsWith(WITHDRAWAL_REFUND_REQUEST) && script.slice(10, 74) !== '0'.repeat(64);
}

// Whether a coinbase pays out a deposit from eCash, by the node's claim rule (sidechain.cpp
// ClaimDepositPayoutOutput): a deposit above the 1,000-szat fee claims one output, not vout[0]
// (the producer's), of exactly its amount less the fee to its destination; an output is claimed
// once. The builder puts it right before the record, so that one is taken first. The same rule
// as the backend's coinbase-split.ts and the frontend's peg-view.ts applyPegLabels (the page's
// 'Deposit from eCash (payout)' label).
function hasDepositPayout(vout: FreebankFlagsTx['vout']): boolean {
  const claimed = new Set<number>([0]);
  let paid = false;
  vout.forEach((out, i) => {
    const head = readDepositHead(out?.scriptpubkey || '');
    if (!head || head.dest === BUNDLE_RETURN_DEST || head.amount <= DEPOSIT_FEE) {
      return;
    }
    const want = head.amount - DEPOSIT_FEE;
    const matches = (j: number): boolean => !claimed.has(j) && vout[j]?.value === want && depositPaysTo(vout[j]?.scriptpubkey_address, head.dest);
    let found = i - 1 >= 1 && matches(i - 1) ? i - 1 : -1;
    for (let j = 1; found < 0 && j < vout.length; j++) {
      if (matches(j)) {
        found = j;
      }
    }
    if (found >= 0) {
      claimed.add(found);
      paid = true;
    }
  });
  return paid;
}

/** The FreeBank bits of a tx's flags (0n for a plain tx). */
export function getFreebankTxFlags(tx: FreebankFlagsTx): bigint {
  let flags = 0n;
  const family = FREEBANK_CREDIT_FLAG_BY_VERSION[tx.version];
  if (family) {
    flags |= FREEBANK_TX_FLAGS.credit | family;
  }
  if (tx.version === ASSET_GENESIS_VERSION) {
    flags |= FREEBANK_TX_FLAGS.asset_created;
  }
  const vout = tx.vout || [];
  if (tx.vin?.[0]?.is_coinbase && hasDepositPayout(vout)) {
    flags |= FREEBANK_TX_FLAGS.deposit_from_ecash;
  }
  // the node reads withdrawals and refund requests from every tx, the coinbase included
  // (validation.cpp ConnectBlock). A 'W' that does not parse, or has no burn, fails the block.
  for (const out of vout) {
    const script = out?.scriptpubkey || '';
    if (script.startsWith(WITHDRAWAL)) {
      flags |= FREEBANK_TX_FLAGS.withdrawal_to_ecash;
    } else if (isRefundRequest(script)) {
      flags |= FREEBANK_TX_FLAGS.withdrawal_refund;
    }
  }
  return flags;
}

/** The credit tx version whose family bit is set in flags, if any. */
export function creditVersionFromFlags(flags: bigint): number | undefined {
  for (const [version, flag] of Object.entries(FREEBANK_CREDIT_FLAG_BY_VERSION)) {
    if (flags & flag) {
      return Number(version);
    }
  }
  return undefined;
}
