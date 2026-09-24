import { FreebankActivityItem, FreebankBill, FreebankDecodedPayload, FreebankHouse } from '@interfaces/freebank-credit.interface';
import { formatBlockCount, formatBps, formatSatsAsEcx, formatUnits, SATS_PER_ECX } from '@app/freebank/credit-units';
import { HOUSE_TIER_LABELS } from '@app/freebank/credit-ops';

// View helpers shared by the house list (/houses) and the house page (/house/:id).
// Pure TypeScript. Units as in interfaces/freebank-credit.interface.ts.
//
// The two issuance caps, as the node enforces them (freebank src/house.cpp HouseCapitalCapUnits,
// HouseReserveCapUnits; validation.cpp NOTE_OP_MINT and BILL_OP_DISCOUNT):
//   capital cap  notes + term deposits  <=  lambda * active escrow     (capitalcapunits)
//   reserve cap  notes                  <=  attested reserves / 10%    (reservecapunits)
// mintcapunits is the lower of the two. The loan book is not a third term: a house pays for a
// discounted bill in its own notes, so the bills it holds are already counted in its notes.
// The *wtmathi / *wtmatlo accumulator words are never read here (they can exceed 2^53).

export const HOUSE_STATUS_LABELS: { [status: string]: string } = {
  open: 'Open',
  stressed: 'Stressed',
  deferred: 'Deferred (option clause invoked)',
  insolvent: 'Insolvent',
  wounddown: 'Wound down',
  unknown: 'Unknown',
};

export function houseStatusLabel(status: string | null | undefined): string {
  if (!status) {
    return 'Unknown';
  }
  return HOUSE_STATUS_LABELS[status] || status;
}

export function houseTierLabel(tier: number): string {
  return HOUSE_TIER_LABELS[tier] || `Tier ${tier}`;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function num(value: unknown): number {
  return isNumber(value) ? value : 0;
}

/** How much of one cap is used. */
export interface CapUsage {
  used: number;                   // units
  cap: number;                    // units
  room: number;                   // units left under the cap, never below 0
  percent: number | null;         // used / cap * 100; null when the cap is 0
  over: boolean;                  // used above the cap (possible after capital leaves or reserves fall)
  barPercent: number;             // 0..100, the width of a usage bar
  text: string;                   // '96%', '0.34%', 'less than 0.01%', 'none (the cap is 0)', 'over the cap'
}

const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const percentFormatWhole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatPercent(percent: number): string {
  if (!isNumber(percent)) {
    return '';
  }
  if (percent > 0 && percent < 0.01) {
    return 'less than 0.01%';
  }
  return (percent >= 10 ? percentFormatWhole : percentFormat).format(percent) + '%';
}

export function capUsage(used: number, cap: number): CapUsage {
  const u = Math.max(0, num(used));
  const c = Math.max(0, num(cap));
  const percent = c > 0 ? (u / c) * 100 : null;
  const over = u > c;
  let text: string;
  if (percent !== null) {
    text = formatPercent(percent);
  } else {
    text = u > 0 ? 'over the cap' : 'none (the cap is 0)';
  }
  return {
    used: u,
    cap: c,
    room: Math.max(0, c - u),
    percent,
    over,
    barPercent: percent !== null ? Math.min(100, percent) : (u > 0 ? 100 : 0),
    text,
  };
}

export interface HouseCapacity {
  lambda: number;                 // issuance multiplier (lambdax10 / 10)
  notes: number;                  // units outstanding
  deposits: number;               // units of term-deposit principal outstanding
  capital: CapUsage;              // notes + deposits against lambda * active escrow
  reserve: CapUsage;              // notes against attested reserves / 10% floor
  mint: CapUsage;                 // notes against the binding mint cap
  roomToIssue: number;            // units the caps still allow (the lower room)
  binding: 'capital' | 'reserve'; // the cap with less room
  mintCapSource: 'capital' | 'reserve'; // the lower cap, which sets mintcapunits
  gramsPerUnit: number | null;    // the node's presentation scale, per note unit (= per sat)
}

/**
 * Grams of gold per note unit at the node's presentation scale, recovered from a large amount
 * and its *_grams twin (the API does not serve the scale itself). null if no pair is usable.
 */
export function houseGramsPerUnit(house: FreebankHouse): number | null {
  if (num(house.activeescrow) > 0 && isNumber(house.activeescrow_grams)) {
    return house.activeescrow_grams / (house.activeescrow * SATS_PER_ECX);
  }
  if (num(house.mintcapunits) >= 1000000 && isNumber(house.mintcapunits_grams)) {
    return house.mintcapunits_grams / house.mintcapunits;
  }
  if (num(house.mintedunits) >= 1000000 && isNumber(house.mintedunits_grams)) {
    return house.mintedunits_grams / house.mintedunits;
  }
  return null;
}

/** Grams for an amount of note units (or sats), or undefined when the scale is unknown. */
export function unitsToGrams(units: number, gramsPerUnit: number | null): number | undefined {
  if (!isNumber(units) || gramsPerUnit === null || !isNumber(gramsPerUnit)) {
    return undefined;
  }
  return Math.round(units * gramsPerUnit * 1e6) / 1e6;
}

/** Grams for a decimal ECX amount, or undefined when the scale is unknown. */
export function ecxToGrams(ecx: number, gramsPerUnit: number | null): number | undefined {
  return isNumber(ecx) ? unitsToGrams(ecx * SATS_PER_ECX, gramsPerUnit) : undefined;
}

export function houseCapacity(house: FreebankHouse): HouseCapacity {
  const notes = num(house.mintedunits);
  const deposits = num(house.depositunits);
  const capital = capUsage(notes + deposits, house.capitalcapunits);
  const reserve = capUsage(notes, house.reservecapunits);
  return {
    lambda: num(house.lambdax10) / 10,
    notes,
    deposits,
    capital,
    reserve,
    mint: capUsage(notes, house.mintcapunits),
    roomToIssue: Math.min(capital.room, reserve.room),
    binding: reserve.room < capital.room ? 'reserve' : 'capital',
    mintCapSource: num(house.reservecapunits) < num(house.capitalcapunits) ? 'reserve' : 'capital',
    gramsPerUnit: houseGramsPerUnit(house),
  };
}

/** The attestation clock at the tip. */
export interface AttestationClock {
  deadline: number;               // attest_deadline: stressed from the next block without an attestation
  blocksLeft: number;             // deadline - tip; negative once overdue
  overdue: boolean;               // tip > deadline
  text: string;                   // '286 blocks left', 'due in this block', 'overdue by 127 blocks'
}

export function attestationClock(house: FreebankHouse, tip: number): AttestationClock {
  const deadline = num(house.attest_deadline);
  const blocksLeft = deadline - num(tip);
  let text: string;
  if (blocksLeft > 0) {
    text = `${formatBlockCount(blocksLeft)} left`;
  } else if (blocksLeft === 0) {
    text = 'due in this block';
  } else {
    text = `overdue by ${formatBlockCount(-blocksLeft)}`;
  }
  return { deadline, blocksLeft, overdue: blocksLeft < 0, text };
}

/** Where a bill stands against its maturity. */
export interface BillMaturity {
  state: 'running' | 'due' | 'past_grace' | 'closed';
  text: string;
}

export function billMaturity(bill: FreebankBill, tip: number): BillMaturity {
  const maturity = num(bill.maturity_height);
  const graceEnd = maturity + num(bill.grace_blocks);
  if (bill.status !== 'a') {
    return { state: 'closed', text: bill.status === 'r' ? 'paid' : 'closed' };
  }
  if (tip < maturity) {
    return { state: 'running', text: `matures in ${formatBlockCount(maturity - tip)}` };
  }
  if (tip <= graceEnd) {
    return { state: 'due', text: `due: grace runs to block ${graceEnd}` };
  }
  return { state: 'past_grace', text: `unpaid ${formatBlockCount(tip - graceEnd)} after grace` };
}

/**
 * True when a credit tx names this house in its decoded payload (house_id on house, note,
 * deposit, pool and house-held bill ops; either side of a settlement) or is its registration.
 */
export function activityNamesHouse(item: FreebankActivityItem, house: Pick<FreebankHouse, 'id' | 'txidregister'>): boolean {
  if (!item) {
    return false;
  }
  if (house.txidregister && item.txid === house.txidregister) {
    return true;
  }
  const d: FreebankDecodedPayload = item.decoded || {};
  return ['house_id', 'house_a_id', 'house_b_id', 'debtor_house_id', 'creditor_house_id']
    .some((key) => d[key] === house.id);
}

export interface ActivityDetail {
  billId: number | null;          // a bill the tx acts on (link it before the text)
  text: string;
}

function units(value: unknown): string {
  return `${formatUnits(num(value))} units`;
}

function ecx(sats: unknown): string {
  return `${formatSatsAsEcx(num(sats))} ECX`;
}

function houseName(id: unknown, self: number): string {
  return id === self ? 'this house' : `house ${id}`;
}

/** One plain line saying what a credit tx did, from its decoded payload (best effort). */
export function describeActivity(item: FreebankActivityItem, houseId: number): ActivityDetail {
  const d: FreebankDecodedPayload = item.decoded || {};
  const op = item.op_name || '';
  const has = (key: string): boolean => d[key] !== undefined && d[key] !== null;
  const billId = isNumber(d.bill_id) ? d.bill_id : null;
  let text = '';

  switch (item.family) {
    case 'house':
      if (op === 'register') {
        const partners = has('partners') ? `, ${d.partners} partner${d.partners === 1 ? '' : 's'}` : '';
        const pledge = has('pledge_sats') ? `, pledged ${ecx(d.pledge_sats)}` : '';
        const tier = has('tier') ? `: ${houseTierLabel(num(d.tier)).toLowerCase()}` : '';
        text = `Registered${has('classid') ? ` as "${d.classid}"` : ''}${tier}${partners}${pledge}`;
      } else if (op === 'attest') {
        const asOf = has('as_of_height') ? ` as of block ${d.as_of_height}` : '';
        text = has('reserves_sats') ? `Proved reserves of ${ecx(d.reserves_sats)}${asOf}` : 'Attested its reserves';
      } else if (has('partner_index')) {
        text = `Partner ${d.partner_index}`;
      }
      break;
    case 'note':
      if (has('units')) {
        const outputs = has('outputs') ? ` in ${d.outputs} output${d.outputs === 1 ? '' : 's'}` : '';
        if (op === 'mint') {
          text = `Issued ${units(d.units)}${outputs}`;
        } else if (op === 'transfer') {
          text = `Moved ${units(d.units)}${outputs}`;
        } else if (op === 'demand') {
          text = `Presented ${units(d.units)} for redemption`;
        } else if (op === 'protest') {
          text = `Protested an unpaid demand for ${units(d.units)}`;
        } else {
          text = units(d.units);
        }
      }
      break;
    case 'deposit':
      if (has('principal_units')) {
        const rate = has('rate_bps') ? ` at ${formatBps(num(d.rate_bps))} a year` : '';
        const maturity = has('maturity_height') ? `, matures at block ${d.maturity_height}` : '';
        text = `${op === 'originate' ? 'Placed' : 'Principal'} ${units(d.principal_units)}${rate}${maturity}`;
      }
      break;
    case 'pool':
      if (op === 'create' && has('note_units')) {
        const fee = has('fee_bps') ? `, fee ${formatBps(num(d.fee_bps))}` : '';
        text = `Opened with ${units(d.note_units)} and ${ecx(d.ecx_sats)}${fee}`;
      } else if (op === 'add_liq' && has('note_units')) {
        text = `Added ${units(d.note_units)} and ${ecx(d.ecx_sats)}`;
      } else if (op === 'remove_liq' && has('note_units_out')) {
        text = `Withdrew ${units(d.note_units_out)} and ${ecx(d.ecx_sats_out)}`;
      } else if (op === 'swap' && has('amount_in') && has('amount_out')) {
        text = d.direction === 'ecx_for_notes'
          ? `Paid ${ecx(d.amount_in)} for ${units(d.amount_out)}`
          : `Sold ${units(d.amount_in)} for ${ecx(d.amount_out)}`;
      }
      break;
    case 'settle':
      if (has('house_a_id') && has('house_b_id')) {
        const a = houseName(d.house_a_id, houseId);
        const b = houseName(d.house_b_id, houseId);
        const came = `${units(d.house_a_notes_units)} of ${a}'s notes and ${formatUnits(num(d.house_b_notes_units))} of ${b}'s came home`;
        const residual = num(d.residual_sats) > 0 && has('debtor_house_id')
          ? `; ${houseName(d.debtor_house_id, houseId)} paid ${ecx(d.residual_sats)} for the difference`
          : '; an even swap';
        text = `Exchanged at par: ${came}${residual}`;
      }
      break;
    case 'bill':
      if (op === 'discount') {
        const price = has('price_units') ? ` for ${units(d.price_units)}` : '';
        const face = has('face_sats') ? ` (face ${ecx(d.face_sats)})` : '';
        text = `discounted${price}${face}`;
      } else if (op === 'hretire') {
        text = 'paid at maturity';
      } else if (op === 'hclaim') {
        text = 'unpaid: the house claimed the escrow';
      }
      break;
  }
  return { billId, text };
}
