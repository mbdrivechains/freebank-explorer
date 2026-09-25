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
//   45     credit: any of v11-v17
//   46-52  bill, house, note, term deposit, pool, settlement, oracle
export const FREEBANK_TX_FLAGS = {
  deposit_from_ecash: 1n << 29n,
  withdrawal_to_ecash: 1n << 30n,
  withdrawal_refund: 1n << 31n,
  credit: 1n << 45n,
  bill: 1n << 46n,
  house: 1n << 47n,
  note: 1n << 48n,
  term_deposit: 1n << 49n,
  pool: 1n << 50n,
  settlement: 1n << 51n,
  oracle: 1n << 52n,
};

// credit family bit by tx version (freebank primitives/transaction.h; v10, BitAsset create, is
// retired and rejected by consensus). v14 is a TERM deposit, not a deposit from eCash.
export const FREEBANK_CREDIT_FLAG_BY_VERSION: { [version: number]: bigint } = {
  11: FREEBANK_TX_FLAGS.bill,
  12: FREEBANK_TX_FLAGS.house,
  13: FREEBANK_TX_FLAGS.note,
  14: FREEBANK_TX_FLAGS.term_deposit,
  15: FREEBANK_TX_FLAGS.pool,
  16: FREEBANK_TX_FLAGS.settlement,
  17: FREEBANK_TX_FLAGS.oracle,
};

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
const WITHDRAWAL = '6a' + SIDECHAIN_OBJECT_TAG + '57'; // 'W', in an ordinary tx
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

function asciiToHex(text: string): string {
  return Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

// A deposit that pays anything is paid in the output right before its deposit record (freebank
// miner.cpp). The record carries the destination address, so check it: a withdrawal refund payout
// can also sit before a record whose deposit paid nothing. Same rule as the frontend's
// getFreebankOutputLabels ('Deposit payout').
function hasDepositPayout(vout: FreebankFlagsTx['vout']): boolean {
  for (let i = 2; i < vout.length; i++) {
    const record = vout[i]?.scriptpubkey || '';
    const payout = vout[i - 1];
    const address = payout?.scriptpubkey_address;
    if (record.startsWith(DEPOSIT_RECORD) && !isCoinbaseCommitment(payout?.scriptpubkey || '') && (payout?.value || 0) > 0 && address
      && (record.includes(asciiToHex(address)) || record.includes(asciiToHex(address.toUpperCase())))) {
      return true;
    }
  }
  return false;
}

/** The FreeBank bits of a tx's flags (0n for a plain tx). */
export function getFreebankTxFlags(tx: FreebankFlagsTx): bigint {
  let flags = 0n;
  const family = FREEBANK_CREDIT_FLAG_BY_VERSION[tx.version];
  if (family) {
    flags |= FREEBANK_TX_FLAGS.credit | family;
  }
  const vout = tx.vout || [];
  if (tx.vin?.[0]?.is_coinbase) {
    if (hasDepositPayout(vout)) {
      flags |= FREEBANK_TX_FLAGS.deposit_from_ecash;
    }
  } else {
    // a look-alike output in a coinbase is not a request: only ordinary txs carry these
    for (const out of vout) {
      const script = out?.scriptpubkey || '';
      if (script.startsWith(WITHDRAWAL)) {
        flags |= FREEBANK_TX_FLAGS.withdrawal_to_ecash;
      } else if (script.startsWith(WITHDRAWAL_REFUND_REQUEST)) {
        flags |= FREEBANK_TX_FLAGS.withdrawal_refund;
      }
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
