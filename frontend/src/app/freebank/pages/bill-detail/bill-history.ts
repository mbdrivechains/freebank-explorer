import { FreebankActivityItem, FreebankActivityResponse, FreebankBill, FreebankDecodedPayload } from '@interfaces/freebank-credit.interface';

// The history of one bill for /bill/:id, pieced together from the bill record (issue txid,
// endorsement chain) and GET /activity?family=bill (the txs that name the bill by its dense id).
// Pure TypeScript.
//
// Facts from the node (freebank src/bill.h, validation.cpp):
//  - The issue tx creates the bill, so its payload cannot name the bill id: it is found by
//    bill.issue_txid instead.
//  - The endorsement chain grows by one link per ENDORSE (op 2) and per DISCOUNT (op 5: an
//    endorsement for value, from the seller to the buying house's custody key). RECOURSE (op 6)
//    changes the holder without adding a link.
//  - A link's at_height is the height the endorser signed at; the tx must confirm within
//    BILL_ENDORSE_HEIGHT_SLACK (64) blocks above it.

export const BILL_ENDORSE_HEIGHT_SLACK = 64;

/** How many bill txs the page asks /activity for (the backend's maximum). */
export const BILL_ACTIVITY_LIMIT = 200;

export type BillEventKind = 'issue' | 'endorse' | 'discount' | 'retire' | 'claim' | 'recourse' | 'hretire' | 'hclaim' | 'other';

export interface BillEvent {
  kind: BillEventKind;
  label: string;
  height: number | null;          // block the tx confirmed in; null if the tx was not found
  time: number | null;            // block time, unix seconds
  txid: string | null;
  datedAt: number | null;         // endorsement links: the height the endorser signed at
  from: string | null;            // endorsement links: pubkeys
  to: string | null;
  houseId: number | null;         // discount / hretire / hclaim: the house
  priceUnits: number | null;      // discount: the price, in the house's note units
  faceSats: number | null;        // discount: the face in sats (price_units is at most this)
  fee: number | null;             // sats
}

export interface BillHistory {
  events: BillEvent[];
  discount: BillEvent | null;     // the discount, if the bill was ever sold to a house
  complete: boolean;              // false when the activity index may not reach back to the issue
  scannedFromHeight: number | null;
}

const EVENT_LABELS: { [kind in BillEventKind]: string } = {
  issue: 'Issued',
  endorse: 'Endorsed',
  discount: 'Discounted at a house',
  retire: 'Paid (retired)',
  claim: 'Escrow claimed (defaulted)',
  recourse: 'Paid under recourse',
  hretire: 'Paid to the house (retired)',
  hclaim: 'Escrow claimed by the house (defaulted)',
  other: 'Bill transaction',
};

function eventKind(opName: string | null): BillEventKind {
  switch (opName) {
    case 'issue':
    case 'endorse':
    case 'discount':
    case 'retire':
    case 'claim':
    case 'recourse':
    case 'hretire':
    case 'hclaim':
      return opName as BillEventKind;
    default:
      return 'other';
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function emptyEvent(kind: BillEventKind): BillEvent {
  return {
    kind, label: EVENT_LABELS[kind], height: null, time: null, txid: null, datedAt: null, from: null, to: null,
    houseId: null, priceUnits: null, faceSats: null, fee: null,
  };
}

function fromItem(item: FreebankActivityItem): BillEvent {
  const kind = eventKind(item.op_name);
  const event = emptyEvent(kind);
  const d: FreebankDecodedPayload = item.decoded || {};
  event.height = item.height;
  event.time = item.time;
  event.txid = item.txid;
  event.fee = item.fee;
  event.houseId = num(d.house_id);
  event.priceUnits = num(d.price_units);
  event.faceSats = num(d.face_sats);
  if (typeof d.from_pubkey === 'string') {
    event.from = d.from_pubkey;
  }
  if (typeof d.to_pubkey === 'string') {
    event.to = d.to_pubkey;
  }
  if (kind === 'other') {
    event.label = item.op_name ? `Bill transaction (${item.op_name})` : EVENT_LABELS.other;
  }
  return event;
}

/** Does this endorse / discount tx carry this link of the endorsement chain? */
function carriesLink(item: FreebankActivityItem, link: { from: string; to: string; at_height: number }): boolean {
  if (item.height < link.at_height || item.height > link.at_height + BILL_ENDORSE_HEIGHT_SLACK) {
    return false;
  }
  if (item.op_name === 'discount') {
    return true;
  }
  const d: FreebankDecodedPayload = item.decoded || {};
  const fromOk = typeof d.from_pubkey !== 'string' || d.from_pubkey === link.from;
  const toOk = typeof d.to_pubkey !== 'string' || d.to_pubkey === link.to;
  return fromOk && toOk;
}

export function buildBillHistory(bill: FreebankBill, activity: FreebankActivityResponse | null | undefined): BillHistory {
  const all = activity?.items || [];
  const mine = all
    .filter((item) => item.family === 'bill' && item.decoded && item.decoded.bill_id === bill.id)
    .sort((a, b) => a.height - b.height);
  const used = new Set<FreebankActivityItem>();
  const events: BillEvent[] = [];

  // 1. the issue, from the record; the activity item (if listed) adds the time and fee
  const issueItem = all.find((item) => item.txid === bill.issue_txid) || null;
  const issue = emptyEvent('issue');
  issue.height = bill.issued_height;
  issue.txid = bill.issue_txid;
  issue.time = issueItem ? issueItem.time : null;
  issue.fee = issueItem ? issueItem.fee : null;
  issue.faceSats = issueItem ? num(issueItem.decoded?.face_sats) : null;
  events.push(issue);

  // 2. the endorsement chain, from the record, each link paired with the tx that carried it
  const linkItems = mine.filter((item) => item.op_name === 'endorse' || item.op_name === 'discount');
  for (const link of bill.endorsements || []) {
    const item = linkItems.find((candidate) => !used.has(candidate) && carriesLink(candidate, link)) || null;
    let event: BillEvent;
    if (item) {
      used.add(item);
      event = fromItem(item);
    } else {
      event = emptyEvent('endorse');
    }
    event.datedAt = link.at_height;
    event.from = link.from;
    event.to = link.to;
    events.push(event);
  }

  // 3. every other tx naming the bill: retire, claim, recourse, hretire, hclaim (and any link
  //    tx the chain did not account for)
  for (const item of mine) {
    if (!used.has(item) && item.txid !== bill.issue_txid) {
      events.push(fromItem(item));
    }
  }

  const sortHeight = (event: BillEvent): number => event.height ?? event.datedAt ?? 0;
  events.sort((a, b) => {
    if (a.kind === 'issue' || b.kind === 'issue') {
      return a.kind === 'issue' ? (b.kind === 'issue' ? 0 : -1) : 1;
    }
    return sortHeight(a) - sortHeight(b);
  });

  const discounts = events.filter((event) => event.kind === 'discount');
  const scannedFromHeight = typeof activity?.scanned_from_height === 'number' ? activity.scanned_from_height : null;
  // The answer is newest first and capped: when it is full, older bill txs may be cut off
  const oldest = all.length ? Math.min(...all.map((item) => item.height)) : null;
  const truncated = all.length >= BILL_ACTIVITY_LIMIT && oldest !== null && oldest > bill.issued_height;
  const complete = !!activity && scannedFromHeight !== null && scannedFromHeight <= bill.issued_height && !truncated;

  return {
    events,
    discount: discounts.length ? discounts[discounts.length - 1] : null,
    complete,
    scannedFromHeight,
  };
}

/** "txid:vout" -> { txid, vout }; null if it does not parse. */
export function parseOutpoint(outpoint: string | null | undefined): { txid: string; vout: number } | null {
  if (typeof outpoint !== 'string') {
    return null;
  }
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec(outpoint);
  return match ? { txid: match[1], vout: parseInt(match[2], 10) } : null;
}
