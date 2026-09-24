import { FreebankActivityItem, FreebankDecodedPayload, FreebankPool } from '@interfaces/freebank-credit.interface';
import { poolSpotSatsPerUnit } from '@app/freebank/credit-units';

// Display helpers shared by the pool pages (/pools and /pool/:id). Pure TypeScript.
//
// From the node (freebank src/pool.h, rpc/misc.cpp PoolToJSON): a pool holds one house's note
// units (note_reserve) against ECX in sats (btx_reserve) and trades them at x * y = k.
//   spot_price_sats_x1e8 = floor(btx_reserve * 1e8 / note_reserve)
// so spot / 1e8 is the ECX side divided by the note side: the sats one note unit is worth at the
// pool's current ratio, before the swap fee and before the trade itself moves the price. Par is
// 1 sat per unit: a v1 note unit redeems for one sat at its house (note.h).

/** Par: one note unit redeems for one sat. */
export const NOTE_PAR_SATS_PER_UNIT = 1;

const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface PoolPrice {
  spot: number | null;            // sats per note unit
  vsParPercent: number | null;    // (spot - par) / par * 100: negative below par
  vsParText: string;              // '4.47% below par', '1.2% above par', 'at par'; '' without a price
  belowPar: boolean;
  unitsPerSat: number | null;     // note units one sat buys at the spot price
}

export function poolPrice(pool: Pick<FreebankPool, 'spot_price_sats_x1e8' | 'note_reserve' | 'btx_reserve'>): PoolPrice {
  let spot = poolSpotSatsPerUnit(pool?.spot_price_sats_x1e8);
  if (spot === null && pool && pool.note_reserve > 0 && typeof pool.btx_reserve === 'number') {
    spot = pool.btx_reserve / pool.note_reserve;
  }
  if (spot === null) {
    return { spot: null, vsParPercent: null, vsParText: '', belowPar: false, unitsPerSat: null };
  }
  const vsParPercent = (spot - NOTE_PAR_SATS_PER_UNIT) / NOTE_PAR_SATS_PER_UNIT * 100;
  let vsParText: string;
  if (Math.abs(vsParPercent) < 0.005) {
    vsParText = 'at par';
  } else if (vsParPercent < 0) {
    vsParText = `${percentFormat.format(-vsParPercent)}% below par`;
  } else {
    vsParText = `${percentFormat.format(vsParPercent)}% above par`;
  }
  return {
    spot,
    vsParPercent,
    vsParText,
    belowPar: vsParPercent <= -0.005,
    unitsPerSat: spot > 0 ? 1 / spot : null,
  };
}

export type PoolOpKind = 'create' | 'add_liq' | 'remove_liq' | 'swap' | 'retire' | 'other';

/** One pool tx from GET /activity?family=pool, read for display. */
export interface PoolActivityRow {
  txid: string;
  height: number;
  time: number;
  fee: number | null;             // sats
  kind: PoolOpKind;
  label: string;
  direction: 'notes_for_ecx' | 'ecx_for_notes' | null;
  noteUnits: number | null;       // units in: create / add_liq seed, swap notes_for_ecx input
  ecxSats: number | null;         // sats in: create / add_liq seed, swap ecx_for_notes input
  noteUnitsOut: number | null;    // units out: remove_liq, swap ecx_for_notes output
  ecxSatsOut: number | null;      // sats out: remove_liq, swap notes_for_ecx output
  feeBps: number | null;          // create
  lpMinted: number | null;
  lpBurned: number | null;
  price: number | null;           // sats per note unit this tx traded or deposited at
}

function num(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function ratio(sats: number | null, units: number | null): number | null {
  return sats !== null && units !== null && units > 0 ? sats / units : null;
}

/** Does this pool tx's decoded payload name pool `poolId`? (v1: pool id == house id.) */
export function activityNamesPool(item: FreebankActivityItem, poolId: number): boolean {
  if (item?.family !== 'pool' || !item.decoded) {
    return false;
  }
  const pool = num(item.decoded.pool_id);
  if (pool !== null) {
    return pool === poolId;
  }
  return num(item.decoded.house_id) === poolId;
}

export function poolActivityRow(item: FreebankActivityItem): PoolActivityRow {
  const d: FreebankDecodedPayload = item.decoded || {};
  const row: PoolActivityRow = {
    txid: item.txid,
    height: item.height,
    time: item.time,
    fee: item.fee,
    kind: 'other',
    label: item.op_name ? `Pool transaction (${item.op_name})` : 'Pool transaction',
    direction: null,
    noteUnits: null,
    ecxSats: null,
    noteUnitsOut: null,
    ecxSatsOut: null,
    feeBps: num(d.fee_bps),
    lpMinted: num(d.lp_minted),
    lpBurned: num(d.lp_burned),
    price: null,
  };
  switch (item.op_name) {
    case 'create':
      row.kind = 'create';
      row.label = 'Pool opened';
      row.noteUnits = num(d.note_units);
      row.ecxSats = num(d.ecx_sats);
      row.price = ratio(row.ecxSats, row.noteUnits);
      break;
    case 'add_liq':
      row.kind = 'add_liq';
      row.label = 'Liquidity added';
      row.noteUnits = num(d.note_units);
      row.ecxSats = num(d.ecx_sats);
      row.price = ratio(row.ecxSats, row.noteUnits);
      break;
    case 'remove_liq':
      row.kind = 'remove_liq';
      row.label = 'Liquidity removed';
      row.noteUnitsOut = num(d.note_units_out);
      row.ecxSatsOut = num(d.ecx_sats_out);
      row.price = ratio(row.ecxSatsOut, row.noteUnitsOut);
      break;
    case 'swap':
      row.kind = 'swap';
      if (d.direction === 'notes_for_ecx') {
        row.direction = 'notes_for_ecx';
        row.label = 'Notes sold for ECX';
        row.noteUnits = num(d.amount_in);
        row.ecxSatsOut = num(d.amount_out);
        row.price = ratio(row.ecxSatsOut, row.noteUnits);
      } else if (d.direction === 'ecx_for_notes') {
        row.direction = 'ecx_for_notes';
        row.label = 'Notes bought with ECX';
        row.ecxSats = num(d.amount_in);
        row.noteUnitsOut = num(d.amount_out);
        row.price = ratio(row.ecxSats, row.noteUnitsOut);
      } else {
        row.label = 'Swap';
      }
      break;
    case 'retire':
      row.kind = 'retire';
      row.label = 'Pool retired';
      break;
  }
  return row;
}
