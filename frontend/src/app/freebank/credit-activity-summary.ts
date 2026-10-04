import { FreebankActivityItem, FreebankDecodedPayload, FreebankTxFamily } from '@interfaces/freebank-credit.interface';
import { UNIT } from '@app/app.constants';
import { CREDIT_FAMILIES, CREDIT_FAMILY_ORDER, CREDIT_OPS, HOUSE_TIER_LABELS, creditOpLabel } from '@app/freebank/credit-ops';
import { GOLD_SHOWN } from '@app/freebank/gold-display';
import { formatBps, formatSatsAsEcx, formatUnits } from '@app/freebank/credit-units';
import { formatGoldFixPrice } from '@app/freebank/gold-fix-format';

// One line in plain words for a credit tx in GET /activity, built from its decoded payload
// (FreebankDecodedPayload; the backend's freebank-tx-parser.ts names the fields). Pure
// TypeScript (no Angular). Every field may be missing, so each sentence degrades to what the
// payload did carry, and to '' when it carried nothing useful (the op label then stands alone).
//
//   house attest  -> 'House 1 attested reserves of 27.675566 ECX (as of block 451)'
//   bill discount -> 'Bill 3 discounted at house 1 for 90,000,000 units of its notes (face 1.00 ECX)'
//   settle        -> 'Settlement: house 1 ↔ house 2, 60,000 and 45,000 units netted at par,
//                     residual 15,000 sats paid by house 1 to house 2'
//   oracle submit -> 'Submitter 2 reported 800 g per ECX'

export interface CreditActivityContext {
  /**
   * Oracle bonds: the submitter id of each bonded pubkey (from GET /gold submitters). A first
   * bond's payload carries submitter id 0, because the id is assigned when the bond confirms.
   */
  submitterIdByPubkey?: { [pubkey: string]: number };
}

/** An /activity item ready to show. */
export interface CreditActivityRow {
  item: FreebankActivityItem;
  familyLabel: string;            // the tx page badge: 'Bill', 'Term deposit', 'Settlement', ...
  opLabel: string;                // the op in plain words: 'Reserve attestation'
  summary: string;                // one line from the payload; '' when there is nothing to add
}

/** The families in filter order with their badge labels (the tx page's CREDIT_TX_LABELS wording). */
export const CREDIT_FAMILY_FILTERS: { family: FreebankTxFamily; label: string }[] =
  CREDIT_FAMILY_ORDER
    .filter((family) => GOLD_SHOWN || family !== 'oracle') // FreeBank: the gold oracle only while gold is shown
    .map((family) => ({ family, label: CREDIT_FAMILIES[family].label }));

/** A family query parameter, or null when it is missing or not a credit family. */
export function parseCreditFamily(value: string | null | undefined): FreebankTxFamily | null {
  return value && (CREDIT_FAMILY_ORDER as string[]).includes(value) ? value as FreebankTxFamily : null;
}

export function creditActivityRow(item: FreebankActivityItem, context: CreditActivityContext = {}): CreditActivityRow {
  return {
    item,
    familyLabel: CREDIT_FAMILIES[item.family]?.label || String(item.family || 'Credit'),
    opLabel: creditOpLabel(item.family, item.op, item.op_name),
    summary: creditActivitySummary(item, context),
  };
}

export function creditActivitySummary(item: FreebankActivityItem, context: CreditActivityContext = {}): string {
  if (!item) {
    return '';
  }
  const decoded: FreebankDecodedPayload = item.decoded && typeof item.decoded === 'object' ? item.decoded : {};
  const op = opName(item);
  switch (item.family) {
    case 'bill': return billSummary(op, decoded);
    case 'house': return houseSummary(op, decoded);
    case 'note': return noteSummary(op, decoded);
    case 'deposit': return depositSummary(op, decoded);
    case 'pool': return poolSummary(op, decoded);
    case 'settle': return settleSummary(op, decoded);
    case 'oracle': return oracleSummary(op, decoded, context);
    default: return '';
  }
}

// ---- field readers ----

function opName(item: FreebankActivityItem): string | null {
  const known = item.op !== null && item.op !== undefined ? CREDIT_OPS[item.family]?.[item.op] : undefined;
  return known?.name || item.op_name || null;
}

function num(decoded: FreebankDecodedPayload, key: string): number | null {
  const value = decoded[key];
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function str(decoded: FreebankDecodedPayload, key: string): string | null {
  const value = decoded[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function ecx(sats: number): string {
  return `${formatSatsAsEcx(sats)} ${UNIT}`;
}

function units(count: number): string {
  return `${formatUnits(count)} ${count === 1 ? 'unit' : 'units'}`;
}

function sats(count: number): string {
  return `${formatUnits(count)} ${count === 1 ? 'szat' : 'szats'}`;
}

function house(id: number | null): string {
  return id !== null ? `house ${id}` : 'a house';
}

function houseNotes(id: number | null): string {
  return id !== null ? `house ${id}'s notes` : 'a house\'s notes';
}

function bill(id: number | null): string {
  return id !== null ? `bill ${id}` : 'a bill';
}

function pool(id: number | null): string {
  return id !== null ? `pool ${id}` : 'a pool';
}

function atBlock(height: number | null, prefix: string): string {
  return height !== null && height > 0 ? `${prefix} block ${height}` : '';
}

// ---- per family ----

function billSummary(op: string | null, d: FreebankDecodedPayload): string {
  const id = num(d, 'bill_id');
  const houseId = num(d, 'house_id');
  const face = num(d, 'face_sats');
  const maturity = num(d, 'maturity_height');
  switch (op) {
    case 'issue': {
      const due = atBlock(maturity, 'due at');
      return 'New bill' + (face !== null ? ` for ${ecx(face)}` : '') + (due ? `, ${due}` : '');
    }
    case 'endorse':
      return `${capitalize(bill(id))} endorsed to a new holder`;
    case 'retire':
      return `${capitalize(bill(id))} paid by the acceptor`;
    case 'claim':
      return `${capitalize(bill(id))} defaulted: the holder took the acceptor's escrow`;
    case 'discount': {
      const price = num(d, 'price_units');
      return `${capitalize(bill(id))} discounted at ${house(houseId)}` +
        (price !== null ? ` for ${units(price)} of its notes` : '') +
        (face !== null ? ` (face ${ecx(face)})` : '');
    }
    case 'recourse':
      return `A liable party paid the holder of dishonoured ${bill(id)} and took its place`;
    case 'hretire':
      return `${capitalize(bill(id))} paid to ${house(houseId)}` + (face !== null ? `, ${ecx(face)} off its loan book` : '');
    case 'hclaim':
      return `${capitalize(house(houseId))} took the escrow of defaulted ${bill(id)}`;
    default:
      return '';
  }
}

/** v0.2.19 house types, as gethouse's "type" and the decoded register_mo's house_type say them. */
const HOUSE_TYPE_WORDS: { [type: string]: string } = { open: 'open', members: 'members-only', redeem: 'redeem-only' };

function houseSummary(op: string | null, d: FreebankDecodedPayload): string {
  const id = num(d, 'house_id');
  switch (op) {
    case 'register':
    case 'register_mo': {
      const classid = str(d, 'classid');
      const tier = num(d, 'tier');
      const pledge = num(d, 'pledge_sats');
      const parts: string[] = [];
      if (classid) {
        parts.push(`note class '${classid}'`);
      }
      if (tier !== null && HOUSE_TIER_LABELS[tier]) {
        parts.push(HOUSE_TIER_LABELS[tier].toLowerCase());
      }
      if (pledge !== null) {
        parts.push(`pledge ${ecx(pledge)}`);
      }
      const kind = op === 'register_mo' ? `New ${HOUSE_TYPE_WORDS[str(d, 'house_type') || ''] || 'members-only'} house registered` : 'New house registered';
      return kind + (parts.length ? ': ' + parts.join(', ') : '');
    }
    case 'member_add':
    case 'member_remove':
    case 'member_purge': {
      const n = num(d, 'members');
      const who = n !== null ? `${formatUnits(n)} member${n === 1 ? '' : 's'}` : 'members';
      return op === 'member_add' ? `${capitalize(house(id))} added ${who}`
        : op === 'member_remove' ? `${capitalize(house(id))} scheduled the removal of ${who}`
        : `${capitalize(house(id))} purged ${who} whose removal is final`;
    }
    case 'topup':
      return `A partner of ${house(id)} added to its pledge`;
    case 'admit':
      return `${capitalize(house(id))} admitted a new partner`;
    case 'exit':
      return `A partner left ${house(id)}`;
    case 'winddown':
      return `${capitalize(house(id))} wound down`;
    case 'reclaim':
      return `A partner took back its pledge from ${house(id)}`;
    case 'attest': {
      const reserves = num(d, 'reserves_sats');
      const asOf = num(d, 'as_of_height');
      return `${capitalize(house(id))} attested ` + (reserves !== null ? `reserves of ${ecx(reserves)}` : 'its reserves') +
        (asOf !== null && asOf > 0 ? ` (as of block ${asOf})` : '');
    }
    case 'defer':
      return `${capitalize(house(id))} invoked the option clause: suspended, redemptions queued`;
    case 'renew':
      return `${capitalize(house(id))} renewed the option clause (an old operation, retired in v0.2.18)`;
    case 'release':
      return `${capitalize(house(id))} released its locked reserves`;
    default:
      return '';
  }
}

/**
 * The demand's mode (v0.2.18 NoteDemand.fPreAuth, decoded by the backend as demand_mode): plain demands exist only
 * while the house is suspended and only the holder can cash them; a pre-authorised one lets the house pay alone; the
 * queue mode is a pre-authorised demand filed while suspended, or the upgrade of a plain one (prior_demand_height
 * keeps its clock). '' for an older node's payload without the field.
 */
export function demandModeText(d: FreebankDecodedPayload): string {
  const prior = num(d, 'prior_demand_height');
  switch (d?.demand_mode) {
    case 'plain':
      return 'queued while the house is suspended, earning interest; only the holder can cash it';
    case 'preauth':
      return 'pre-authorised: the house may pay it alone';
    case 'preauth_queue':
      return prior
        ? `a queued demand from block ${prior} upgraded to pre-authorised, its interest clock kept`
        : 'queued while the house is suspended, earning interest; pre-authorised, so the house may pay it alone';
    default:
      return '';
  }
}

function noteSummary(op: string | null, d: FreebankDecodedPayload): string {
  const id = num(d, 'house_id');
  const count = num(d, 'units');
  switch (op) {
    case 'mint':
      return `${capitalize(house(id))} issued ` + (count !== null ? `${units(count)} of notes` : 'notes');
    case 'transfer': {
      // units sums every note output, the sender's change included (a transfer spends whole note
      // coins and re-issues the same total), so it is what passed through the tx, not what the
      // new holder received.
      const outputs = num(d, 'outputs');
      const spread = outputs !== null && outputs > 1 ? ` across ${formatUnits(outputs)} outputs, any change included` : '';
      return `${capitalize(houseNotes(id))} transferred` + (count !== null ? `: ${units(count)}${spread}` : '');
    }
    case 'redeem':
      return `${capitalize(houseNotes(id))} redeemed at the house for ${UNIT}`;
    case 'claim':
      return `A note holder claimed its share of insolvent ${house(id)}'s pot`;
    case 'demand': {
      const mode = demandModeText(d);
      return `A holder demanded redemption` + (count !== null ? ` of ${units(count)}` : '') + ` from ${house(id)}` + (mode ? ` (${mode})` : '');
    }
    case 'protest':
      return `A holder protested an unpaid demand on ${house(id)}`;
    default:
      return '';
  }
}

function depositSummary(op: string | null, d: FreebankDecodedPayload): string {
  const id = num(d, 'house_id');
  const principal = num(d, 'principal_units');
  const rate = num(d, 'rate_bps');
  const maturity = num(d, 'maturity_height');
  switch (op) {
    case 'originate':
      return (principal !== null ? `Term deposit of ${units(principal)}` : 'Term deposit') + ` opened at ${house(id)}` +
        (rate !== null ? ` at ${formatBps(rate)} a year` : '');
    case 'transfer': {
      const details: string[] = [];
      if (principal !== null) {
        details.push(units(principal));
      }
      if (rate !== null) {
        details.push(`${formatBps(rate)} a year`);
      }
      const matures = atBlock(maturity, 'matures at');
      if (matures) {
        details.push(matures);
      }
      return `A term deposit at ${house(id)} changed hands` + (details.length ? ` (${details.join(', ')})` : '');
    }
    case 'withdraw':
      return `A term deposit at ${house(id)} was paid out at maturity`;
    case 'claim':
      return `A depositor claimed its share from insolvent ${house(id)}`;
    default:
      return '';
  }
}

function poolSummary(op: string | null, d: FreebankDecodedPayload): string {
  const houseId = num(d, 'house_id');
  const poolId = num(d, 'pool_id') ?? houseId;
  switch (op) {
    case 'create': {
      const noteUnits = num(d, 'note_units');
      const ecxSats = num(d, 'ecx_sats');
      const fee = num(d, 'fee_bps');
      return `${capitalize(pool(poolId))} opened for ${houseNotes(houseId)}` +
        (noteUnits !== null && ecxSats !== null ? ` with ${units(noteUnits)} and ${ecx(ecxSats)}` : '') +
        (fee !== null ? `, fee ${formatBps(fee)}` : '');
    }
    case 'add_liq': {
      const noteUnits = num(d, 'note_units');
      const ecxSats = num(d, 'ecx_sats');
      return `Liquidity added to ${pool(poolId)}` +
        (noteUnits !== null && ecxSats !== null ? `: ${units(noteUnits)} and ${ecx(ecxSats)}` : '');
    }
    case 'remove_liq': {
      const noteUnits = num(d, 'note_units_out');
      const ecxSats = num(d, 'ecx_sats_out');
      return `Liquidity taken out of ${pool(poolId)}` +
        (noteUnits !== null && ecxSats !== null ? `: ${units(noteUnits)} and ${ecx(ecxSats)}` : '');
    }
    case 'swap': {
      const direction = str(d, 'direction');
      const amountIn = num(d, 'amount_in');
      const amountOut = num(d, 'amount_out');
      if (amountIn !== null && amountOut !== null) {
        if (direction === 'notes_for_ecx') {
          return `Swap in ${pool(poolId)}: ${units(amountIn)} of notes for ${ecx(amountOut)}`;
        }
        if (direction === 'ecx_for_notes') {
          return `Swap in ${pool(poolId)}: ${ecx(amountIn)} for ${units(amountOut)} of notes`;
        }
      }
      return `Swap in ${pool(poolId)}`;
    }
    case 'retire':
      return `${capitalize(pool(poolId))} closed`;
    default:
      return '';
  }
}

function settleSummary(op: string | null, d: FreebankDecodedPayload): string {
  if (op !== 'exchange') {
    return '';
  }
  const houseA = num(d, 'house_a_id');
  const houseB = num(d, 'house_b_id');
  const unitsA = num(d, 'house_a_notes_units');
  const unitsB = num(d, 'house_b_notes_units');
  const residual = num(d, 'residual_sats');
  const debtor = num(d, 'debtor_house_id');
  const creditor = num(d, 'creditor_house_id');
  if (houseA === null && houseB === null && unitsA === null && unitsB === null && residual === null) {
    return '';
  }
  let text = 'Settlement';
  if (houseA !== null && houseB !== null) {
    text += `: house ${houseA} ↔ house ${houseB}`;
  }
  if (unitsA !== null && unitsB !== null) {
    text += `, ${formatUnits(unitsA)} and ${formatUnits(unitsB)} units netted at par`;
  }
  if (residual !== null && residual > 0) {
    text += `, residual ${sats(residual)}`;
    if (debtor !== null && creditor !== null) {
      text += ` paid by house ${debtor} to house ${creditor}`;
    }
  } else if (residual === 0 || num(d, 'mode') === 0) {
    text += ', an even swap';
  }
  return text;
}

function oracleSummary(op: string | null, d: FreebankDecodedPayload, context: CreditActivityContext): string {
  const id = num(d, 'submitter_id');
  switch (op) {
    case 'bond': {
      if (id !== null && id > 0) {
        return `Submitter ${id} bonded again`;
      }
      const pubkey = str(d, 'pubkey');
      const assigned = pubkey ? context.submitterIdByPubkey?.[pubkey] : undefined;
      return 'New gold-price submitter bonded' + (typeof assigned === 'number' ? ` (submitter ${assigned})` : '');
    }
    case 'submit': {
      const priceMg = num(d, 'price_mg');
      const price = priceMg !== null ? formatGoldFixPrice(priceMg) : '';
      return (id !== null ? `Submitter ${id}` : 'A submitter') + (price ? ` reported ${price}` : ' reported a gold price');
    }
    default:
      return '';
  }
}
