import { CoinbaseOutput, PegInPayout, splitFreebankCoinbase } from './coinbase-split';
import { parsePegOutputs } from './peg-parser';
import {
  PegBlockEvents, PegBundle, PegBundleRecord, PegDeposit, PegDepositRecord, PegEcashPaymentRecord, PegOutput,
  PegRefund, PegTreasury, PegTxOutputView, PegTxView, PegWithdrawal,
} from './peg.interfaces';

// The peg's state, derived from the peg events of every block (peg-index.ts keeps those, per
// block, for the whole chain). Pure: no node calls. Events are replayed in chain order, the way
// the node applies them when it connects a block:
//   bundle failed (commitment)   the bundle's withdrawals go back in the queue
//   bundle paid (commitment)     its withdrawals are paid
//   bundle record                a new bundle; its withdrawals are in it
//   deposit records              deposits from eCash, and a bundle's eCash payment (dest 'D')
//   withdrawals, refund requests (ordinary txs)
// A bundle counts as paid on eCash, with a link, only when a payment record's outputs match the
// bundle's payouts. A 'paid' commitment alone is only the block producer's word: freebankd can
// mark a bundle paid from an old event (the D2 flaw), so such a bundle is 'marked-paid'.

/** A block's peg events as the index stores them (compact: most blocks have none). */
export interface StoredEvents {
  coinbase_txid: string;
  coinbase: PegOutput[]; // bundle-hash commitments left out: every block after the first bundle has one
  pegins: PegInPayout[]; // the coinbase's deposit payouts (coinbase-split.ts)
  cb?: [number, string | null][]; // the coinbase's outputs (value, address), kept when a refund needs pairing
  txs: { txid: string, outputs: PegOutput[] }[]; // ordinary txs with peg outputs
}

export interface StoredBlock {
  height: number;
  hash: string;
  prev: string;
  time: number;
  ev?: StoredEvents;
}

export interface PegState {
  deposits: PegDeposit[]; // chain order
  withdrawals: Map<string, PegWithdrawal>; // by id, chain order
  bundles: Map<string, PegBundle>; // by bundle hash, chain order
  refunds: Map<string, PegRefund>; // by withdrawal id
  payments: PegEcashPaymentRecord[]; // chain order
  treasury: PegTreasury | null;
  blocks: Map<string, PegBlockEvents>; // by FreeBank block hash
  txs: Map<string, { height: number, block: string, coinbase: boolean, outputs: PegOutput[] }>;
  ecashTxs: Map<string, { deposit?: PegDeposit, payment?: PegEcashPaymentRecord }>;
  records: Map<string, { deposit?: PegDeposit, payment?: PegEcashPaymentRecord }>; // by `${txid}:${vout}`
}

function nodeValue(value: unknown): number {
  return typeof value === 'number' ? Math.round(value * 100_000_000) : 0;
}

function nodeAddress(scriptPubKey: any): string | undefined {
  return scriptPubKey?.address ?? (Array.isArray(scriptPubKey?.addresses) ? scriptPubKey.addresses[0] : undefined);
}

/**
 * The peg events of one block from the node's getblock <hash> 2, or undefined when it has none.
 * Reads the output scripts only (vout[].scriptPubKey.hex), so it needs no raw tx.
 */
export function extractBlockEvents(block: any): StoredEvents | undefined {
  const txs: any[] = block?.tx || [];
  if (!txs.length) {
    return undefined;
  }
  const cbVout: CoinbaseOutput[] = (txs[0].vout || []).map((o: any) => ({
    value: nodeValue(o?.value),
    scriptpubkey: o?.scriptPubKey?.hex || '',
    scriptpubkey_address: nodeAddress(o?.scriptPubKey),
  }));
  const coinbase = parsePegOutputs(cbVout, true).filter((o) => o.kind !== 'bundle-hash');
  const others: StoredEvents['txs'] = [];
  for (let i = 1; i < txs.length; i++) {
    const outputs = parsePegOutputs((txs[i].vout || []).map((o: any) => ({ scriptpubkey: o?.scriptPubKey?.hex || '' })), false);
    if (outputs.length) {
      others.push({ txid: txs[i].txid, outputs });
    }
  }
  if (!coinbase.length && !others.length) {
    return undefined;
  }
  const events: StoredEvents = {
    coinbase_txid: txs[0].txid,
    coinbase,
    pegins: coinbase.some((o) => o.kind === 'deposit') ? splitFreebankCoinbase(cbVout).pegIns : [],
    txs: others,
  };
  if (others.some((t) => t.outputs.some((o) => o.kind === 'refund-request'))) {
    events.cb = cbVout.map((o) => [o.value, o.scriptpubkey_address ?? null]);
  }
  return events;
}

function emptyBlockEvents(height: number, hash: string): PegBlockEvents {
  return {
    freebank_height: height,
    freebank_block: hash,
    deposits: [],
    deposits_paid: 0,
    deposits_paid_amount: 0,
    deposits_unpaid: 0,
    refunds: [],
    refunds_amount: 0,
    bundles_created: [],
    bundles_paid: [],
    bundles_failed: [],
    ecash_payments: [],
    withdrawals: [],
  };
}

/** The M6's outputs pay exactly the bundle's payouts, at the same output indexes (CUSF and legacy alike). */
export function paymentMatchesBundle(outputs: { value: number, scriptpubkey: string }[] | undefined, bundle: { payouts: PegBundle['payouts'] }): boolean {
  if (!outputs || !bundle.payouts.length) {
    return false;
  }
  return bundle.payouts.every((p) => outputs[p.vout]?.value === p.value && outputs[p.vout]?.scriptpubkey === p.scriptpubkey);
}

/** Replay every block's events (ascending height) into the peg's state. */
export function derivePegState(blocks: StoredBlock[]): PegState {
  const state: PegState = {
    deposits: [],
    withdrawals: new Map(),
    bundles: new Map(),
    refunds: new Map(),
    payments: [],
    treasury: null,
    blocks: new Map(),
    txs: new Map(),
    ecashTxs: new Map(),
    records: new Map(),
  };
  for (const block of blocks) {
    if (block.ev) {
      applyBlock(state, block, block.ev);
    }
  }
  return state;
}

function applyBlock(state: PegState, block: StoredBlock, ev: StoredEvents): void {
  const events = emptyBlockEvents(block.height, block.hash);
  state.blocks.set(block.hash, events);
  state.txs.set(ev.coinbase_txid, { height: block.height, block: block.hash, coinbase: true, outputs: ev.coinbase });
  for (const tx of ev.txs) {
    state.txs.set(tx.txid, { height: block.height, block: block.hash, coinbase: false, outputs: tx.outputs });
  }

  // 1. bundle status commitments
  for (const out of ev.coinbase) {
    if (out.kind !== 'bundle-failed' && out.kind !== 'bundle-paid') {
      continue;
    }
    const bundle = state.bundles.get(out.bundle_hash);
    if (!bundle || bundle.status !== 'created') {
      continue;
    }
    bundle.status_height = block.height;
    bundle.status_block = block.hash;
    if (out.kind === 'bundle-failed') {
      bundle.status = 'failed';
      events.bundles_failed.push(bundle);
      for (const id of bundle.withdrawal_ids) {
        const w = state.withdrawals.get(id);
        if (w && w.bundle_hash === bundle.bundle_hash && w.status === 'in-bundle') {
          w.status = 'requeued';
          w.failed_bundles.push(bundle.bundle_hash);
        }
      }
    } else {
      bundle.status = bundle.ecash_payment ? 'paid' : 'marked-paid';
      events.bundles_paid.push(bundle);
      markWithdrawalsPaid(state, bundle);
    }
  }

  // 2. a new bundle
  for (const out of ev.coinbase) {
    if (out.kind === 'bundle') {
      addBundle(state, block, ev, out, events);
    }
  }

  // 3. deposit records: deposits from eCash, and bundle payments (M6)
  const pegins = new Map(ev.pegins.map((p) => [p.record_vout, p]));
  for (const out of ev.coinbase) {
    if (out.kind !== 'deposit') {
      continue;
    }
    if (out.bundle_payment) {
      addPayment(state, block, ev, out, events);
    } else {
      addDeposit(state, block, ev, out, pegins.get(out.vout), events);
    }
    state.treasury = {
      ecash_txid: out.ecash_txid,
      ecash_vout: out.burn_index,
      value: out.treasury_value,
      freebank_height: block.height,
    };
  }

  // 4. withdrawals and refund requests
  const claimed = new Set<number>([0, ...ev.pegins.filter((p) => p.payout_vout !== null).map((p) => p.payout_vout as number)]);
  for (const tx of ev.txs) {
    for (const out of tx.outputs) {
      if (out.kind === 'withdrawal' && !state.withdrawals.has(out.id)) {
        const w: PegWithdrawal = {
          id: out.id,
          txid: tx.txid,
          vout: out.vout,
          freebank_height: block.height,
          freebank_block: block.hash,
          freebank_time: block.time,
          dest_raw: out.dest_raw,
          refund_dest: out.refund_dest,
          amount: out.amount,
          ecash_fee: out.ecash_fee,
          payout: out.payout,
          status: 'waiting',
          bundle_hash: null,
          bundle_vout: null,
          failed_bundles: [],
          ecash_payment: null,
          refund: null,
        };
        state.withdrawals.set(out.id, w);
        events.withdrawals.push(w);
      } else if (out.kind === 'refund-request' && !state.refunds.has(out.withdrawal_id)) {
        const w = state.withdrawals.get(out.withdrawal_id);
        const refund: PegRefund = {
          withdrawal_id: out.withdrawal_id,
          request_txid: tx.txid,
          request_vout: out.vout,
          freebank_height: block.height,
          freebank_block: block.hash,
          freebank_time: block.time,
          coinbase_txid: ev.coinbase_txid,
          payout_vout: null,
          amount: w ? w.amount : null,
          refund_dest: w ? w.refund_dest : null,
        };
        // the coinbase output that pays it: the withdrawal's whole amount to its refund address
        // (validation.cpp); each output pays one refund
        if (w && ev.cb) {
          const i = ev.cb.findIndex(([value, address], j) => !claimed.has(j) && value === w.amount && address === w.refund_dest);
          if (i >= 0) {
            claimed.add(i);
            refund.payout_vout = i;
          }
        }
        state.refunds.set(out.withdrawal_id, refund);
        events.refunds.push(refund);
        events.refunds_amount += refund.amount ?? 0;
        if (w) {
          w.status = 'refunded';
          w.refund = refund;
        }
      }
    }
  }
}

function addBundle(state: PegState, block: StoredBlock, ev: StoredEvents, out: PegBundleRecord, events: PegBlockEvents): void {
  if (state.bundles.has(out.bundle_hash)) {
    return; // the node refuses a bundle whose hash it has seen (fCheckUnique)
  }
  const bundle: PegBundle = {
    bundle_hash: out.bundle_hash,
    m6id: out.m6id,
    freebank_height: block.height,
    freebank_block: block.hash,
    freebank_time: block.time,
    coinbase_txid: ev.coinbase_txid,
    record_vout: out.vout,
    format: out.format,
    ecash_fee: out.ecash_fee,
    total: out.total,
    payouts: out.payouts,
    withdrawal_ids: out.withdrawal_ids,
    status: 'created',
    status_height: null,
    status_block: null,
    ecash_payment: null,
  };
  state.bundles.set(bundle.bundle_hash, bundle);
  events.bundles_created.push(bundle);
  for (const payout of out.payouts) {
    const w = payout.withdrawal_id ? state.withdrawals.get(payout.withdrawal_id) : undefined;
    if (w && (w.status === 'waiting' || w.status === 'requeued')) {
      w.status = 'in-bundle';
      w.bundle_hash = bundle.bundle_hash;
      w.bundle_vout = payout.vout;
    }
  }
}

function addDeposit(state: PegState, block: StoredBlock, ev: StoredEvents, out: PegDepositRecord, pegin: PegInPayout | undefined, events: PegBlockEvents): void {
  const deposit: PegDeposit = {
    freebank_height: block.height,
    freebank_block: block.hash,
    freebank_time: block.time,
    coinbase_txid: ev.coinbase_txid,
    record_vout: out.vout,
    payout_vout: pegin?.payout_vout ?? null,
    dest: out.dest,
    amount: out.amount,
    paid: pegin?.paid ?? 0,
    fee: pegin?.payout_vout !== null && pegin?.payout_vout !== undefined ? out.amount - pegin.paid : 0,
    unpaid_reason: pegin ? pegin.unpaid_reason : null,
    ecash_txid: out.ecash_txid,
    ecash_block: out.ecash_block,
    ecash_vout: out.burn_index,
    treasury_value: out.treasury_value,
  };
  state.deposits.push(deposit);
  state.records.set(`${ev.coinbase_txid}:${out.vout}`, { deposit });
  if (!state.ecashTxs.has(out.ecash_txid)) {
    state.ecashTxs.set(out.ecash_txid, { deposit });
  }
  events.deposits.push(deposit);
  if (deposit.payout_vout !== null) {
    events.deposits_paid++;
    events.deposits_paid_amount += deposit.paid;
  } else {
    events.deposits_unpaid++;
  }
}

function addPayment(state: PegState, block: StoredBlock, ev: StoredEvents, out: PegDepositRecord, events: PegBlockEvents): void {
  const payment: PegEcashPaymentRecord = {
    ecash_txid: out.ecash_txid,
    ecash_block: out.ecash_block,
    freebank_height: block.height,
    freebank_block: block.hash,
    freebank_time: block.time,
    coinbase_txid: ev.coinbase_txid,
    record_vout: out.vout,
    treasury_value: out.treasury_value,
    bundle_hash: null,
  };
  // the newest bundle, not yet tied to a payment, whose payouts this M6 pays
  let match: PegBundle | null = null;
  for (const bundle of state.bundles.values()) {
    if (!bundle.ecash_payment && bundle.status !== 'failed' && paymentMatchesBundle(out.ecash_outputs, bundle)) {
      match = bundle;
    }
  }
  if (match) {
    payment.bundle_hash = match.bundle_hash;
    match.ecash_payment = {
      ecash_txid: out.ecash_txid,
      ecash_block: out.ecash_block,
      ecash_vout: null,
      freebank_height: block.height,
      freebank_block: block.hash,
    };
    if (match.status === 'marked-paid') {
      match.status = 'paid';
      markWithdrawalsPaid(state, match);
    }
  }
  state.payments.push(payment);
  state.records.set(`${ev.coinbase_txid}:${out.vout}`, { payment });
  if (!state.ecashTxs.has(out.ecash_txid)) {
    state.ecashTxs.set(out.ecash_txid, { payment });
  }
  events.ecash_payments.push(payment);
}

/** The bundle was marked paid (and maybe matched to its M6): its withdrawals follow. */
function markWithdrawalsPaid(state: PegState, bundle: PegBundle): void {
  for (const id of bundle.withdrawal_ids) {
    const w = state.withdrawals.get(id);
    if (!w || w.bundle_hash !== bundle.bundle_hash || (w.status !== 'in-bundle' && w.status !== 'marked-paid')) {
      continue;
    }
    if (bundle.ecash_payment) {
      w.status = 'paid';
      w.ecash_payment = { ...bundle.ecash_payment, ecash_vout: w.bundle_vout };
    } else {
      w.status = 'marked-paid';
    }
  }
}

/** One tx's peg outputs joined with the index's state (null when the tx has none in the index). */
export function pegTxView(state: PegState, txid: string, explorerUrl: string): PegTxView | null {
  const tx = state.txs.get(txid);
  if (!tx) {
    return null;
  }
  const view: PegTxView = {
    explorer_url: explorerUrl,
    txid,
    confirmed: true,
    indexed: true,
    freebank_height: tx.height,
    freebank_block: tx.block,
    coinbase: tx.coinbase,
    outputs: tx.outputs.map((output) => joinOutput(state, txid, output)),
    deposit_payouts: [],
    refund_payouts: [],
  };
  if (tx.coinbase) {
    const events = state.blocks.get(tx.block);
    for (const d of events?.deposits || []) {
      if (d.payout_vout !== null) {
        view.deposit_payouts.push({ vout: d.payout_vout, record_vout: d.record_vout });
      }
    }
    for (const r of events?.refunds || []) {
      if (r.payout_vout !== null) {
        view.refund_payouts.push({ vout: r.payout_vout, withdrawal_id: r.withdrawal_id });
      }
    }
  }
  return view;
}

/** A tx's peg outputs decoded but not in the index (unconfirmed, or the index is behind). */
export function joinOutputs(state: PegState, txid: string, outputs: PegOutput[]): PegTxOutputView[] {
  return outputs.map((output) => joinOutput(state, txid, output));
}

function joinOutput(state: PegState, txid: string, output: PegOutput): PegTxOutputView {
  const view: PegTxOutputView = { output: publicOutput(output) };
  switch (output.kind) {
    case 'deposit': {
      const record = state.records.get(`${txid}:${output.vout}`);
      if (record?.deposit) {
        view.deposit = record.deposit;
      }
      if (record?.payment) {
        view.payment = record.payment;
        const bundle = record.payment.bundle_hash ? state.bundles.get(record.payment.bundle_hash) : undefined;
        if (bundle) {
          view.bundle = bundle;
        }
      }
      break;
    }
    case 'bundle':
    case 'bundle-hash':
    case 'bundle-paid':
    case 'bundle-failed': {
      const bundle = state.bundles.get(output.bundle_hash);
      if (bundle) {
        view.bundle = bundle;
      }
      break;
    }
    case 'withdrawal': {
      const w = state.withdrawals.get(output.id);
      if (w && w.txid === txid) {
        view.withdrawal = w;
        const bundle = w.bundle_hash ? state.bundles.get(w.bundle_hash) : undefined;
        if (bundle) {
          view.bundle = bundle;
        }
      }
      break;
    }
    case 'refund-request': {
      const w = state.withdrawals.get(output.withdrawal_id);
      if (w) {
        view.withdrawal = w;
      }
      const refund = state.refunds.get(output.withdrawal_id);
      if (refund && refund.request_txid === txid) {
        view.refund = refund;
      }
      break;
    }
  }
  return view;
}

/** The output as the API shows it: a bundle payment's M6 outputs stay in the index. */
function publicOutput(output: PegOutput): PegOutput {
  if (output.kind === 'deposit' && output.ecash_outputs) {
    const { ecash_outputs, ...rest } = output;
    return rest;
  }
  return output;
}
