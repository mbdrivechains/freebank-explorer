// House health badge (candidate design 39, gateway/docs/freebank/FREEBANK_DISTRIBUTION.md s3):
// the modern bank-note reporter - "is this house sound?" - read from the attestation state
// `gethouse` / `listhouses` already publish. Read-side only, no consensus change.
//
// THE FRONTEND MIRRORS THIS FUNCTION. Keep the two in step; the rules are stated here once.
//
// What the node's fields mean (freebank/src/house.h, house.cpp, rpc/misc.cpp HouseToJSON):
//
//   status            the STORED status: 'open' or 'wounddown' on disk, 'insolvent' once the
//                     first insolvency claim materializes it.
//   effective_status  the consensus status AT THE TIP the node answered for
//                     (HouseEffectiveStatus): 'open' | 'stressed' | 'deferred' | 'insolvent' |
//                     'wounddown'. Stressed, deferred and (until materialized) insolvent are
//                     DERIVED from stored heights, so this is the field to read, not `status`.
//                       - stressed:  stress_since = the earliest of (a) an attestation that
//                                    showed reserves below the floor, (b) attest_deadline + 1
//                                    with no attestation since, (c) an open noteholder protest.
//                       - deferred:  a stressed house that invoked the option clause:
//                                    redemptions are queued, not paid at par, until
//                                    defer_end_height.
//                       - insolvent: stressed for HOUSE_STRESSED_WINDOW blocks (1008 on the
//                                    real networks; regtest may override it) without recovering,
//                                    or a deferral that ran out. Absorbing: every op that could
//                                    change it is refused from then on.
//   lastattestheight  height of the last accepted reserve attestation (registration starts
//                     the clock: a new house has lastattestheight = registeredheight).
//   attest_deadline   lastattestheight + HOUSE_ATTEST_MISS_N (2) x HOUSE_ATTEST_CADENCE. The
//                     house stays Open THROUGH the block at attest_deadline; from
//                     attest_deadline + 1 it is Stressed (stress_since = attest_deadline + 1)
//                     unless an attestation lands first. The cadence is 144 blocks on the real
//                     networks and regtest can override it, so derive it from the two fields:
//                     cadence = (attest_deadline - lastattestheight) / 2.
//   attestedratiobps  last ATTESTED reserves / outstanding note units, basis points, capped at
//                     10000 (and 10000 when no notes are out). The floor (rho) is 10% = 1000.
//   pareligible       HouseParEligible: effective Open AND attestedratiobps >= 1000 AND the
//                     last attestation within ONE cadence (tip - lastattestheight <= cadence).
//                     This is what lets the house settle at par with other houses.
//   confidence_dead   the house may no longer invoke the option clause (a second use inside
//                     ~36 months, or ~9 months suspended in total). A guard, not a status: it
//                     only matters to a stressed house, which then has only its stress clock.
//   insolventheight   present once insolvency has been materialized.
//
// The badge:
//
//   INSOLVENT        effective_status (or stored status) is 'insolvent', or insolventheight
//                    is set. Its notes are impaired claims, paid out pro rata from the
//                    house's escrow - NOT at par. The only "discount" a FreeBank holder sees.
//   STRESSED         effective_status is 'stressed' or 'deferred'.
//   ATTESTATION DUE  effective_status is 'open' but the house is not par-eligible: its last
//                    attestation is more than one cadence old (lastattestheight + cadence <
//                    tip <= attest_deadline), or - which an Open house should never show - its
//                    attested ratio is below the floor. Still Open, still redeems at par; it
//                    turns Stressed after attest_deadline.
//   SOUND            effective_status is 'open' and pareligible is true.
//   WOUND DOWN       effective_status is 'wounddown': the house closed voluntarily, which
//                    consensus allows only with no notes or deposits outstanding. Not one of
//                    design 39's four; shown so every house has a badge.
//   (Any other status string is treated as STRESSED - never shown as sound.)

export type HouseBadge = 'sound' | 'attestation_due' | 'stressed' | 'insolvent' | 'wound_down';

/** Display order, healthiest first. */
export const HOUSE_BADGES: readonly HouseBadge[] = ['sound', 'attestation_due', 'stressed', 'insolvent', 'wound_down'];

export const HOUSE_BADGE_LABELS: Readonly<Record<HouseBadge, string>> = {
  sound: 'Sound',
  attestation_due: 'Attestation due',
  stressed: 'Stressed',
  insolvent: 'Insolvent',
  wound_down: 'Wound down',
};

/** house.h HOUSE_ATTEST_MISS_N: missed cadences before a house is stressed. */
export const HOUSE_ATTEST_MISS_N = 2;
/** house.h HOUSE_RESERVE_FLOOR_PCT (10%) in basis points. */
export const HOUSE_RESERVE_FLOOR_BPS = 1000;

/** The gethouse / listhouses fields the badge reads (the RPC objects carry many more). */
export interface HouseBadgeFields {
  status?: string;
  effective_status?: string;
  attestedratiobps?: number;
  lastattestheight?: number;
  attest_deadline?: number;
  pareligible?: boolean;
  confidence_dead?: boolean;
  insolventheight?: number;
  stress_since?: number;
  protest_open?: number;
  defer_end_height?: number;
}

export interface HouseBadgeResult {
  badge: HouseBadge;
  /** true when the house's notes are impaired claims, not redeemable at par (insolvent) */
  notes_impaired: boolean;
  /** blocks between attestations, derived from attest_deadline; null if the fields are missing */
  attest_cadence: number | null;
  /** last block at which the house is still par-eligible without a new attestation */
  attest_due_height: number | null;
  /** last block at which the house is still Open without a new attestation */
  attest_deadline: number | null;
  /** one plain-language sentence for a tooltip or detail line */
  reason: string;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

export function houseBadge(house: HouseBadgeFields, tipHeight: number): HouseBadgeResult {
  const status = house.effective_status || house.status || 'unknown';
  const last = isNum(house.lastattestheight) ? house.lastattestheight : null;
  const deadline = isNum(house.attest_deadline) ? house.attest_deadline : null;
  const cadence = last !== null && deadline !== null && deadline >= last
    ? Math.floor((deadline - last) / HOUSE_ATTEST_MISS_N)
    : null;
  const dueHeight = last !== null && cadence !== null ? last + cadence : null;
  const ratio = isNum(house.attestedratiobps) ? house.attestedratiobps : null;
  const belowFloor = ratio !== null && ratio < HOUSE_RESERVE_FLOOR_BPS;
  const result = (badge: HouseBadge, reason: string): HouseBadgeResult => ({
    badge,
    notes_impaired: badge === 'insolvent',
    attest_cadence: cadence,
    attest_due_height: dueHeight,
    attest_deadline: deadline,
    reason,
  });

  if (status === 'insolvent' || house.status === 'insolvent' || isNum(house.insolventheight)) {
    const since = isNum(house.insolventheight) ? ` since block ${house.insolventheight}` : '';
    return result('insolvent', `Insolvent${since}: its notes are impaired claims, paid out pro rata from the house's escrow, not at par.`);
  }

  if (status === 'wounddown') {
    return result('wound_down', 'Wound down: the house has closed, with no notes or deposits outstanding.');
  }

  if (status === 'stressed' || status === 'deferred') {
    let reason = isNum(house.stress_since) ? `Stressed since block ${house.stress_since}` : 'Stressed';
    if (status === 'deferred') {
      const until = isNum(house.defer_end_height) ? ` until block ${house.defer_end_height}` : '';
      reason += `; the house has invoked the option clause, so redemptions are queued${until}, not paid at par`;
    } else if (deadline !== null && house.stress_since === deadline + 1) {
      reason += `: it missed its attestation deadline (block ${deadline})`;
    } else if (belowFloor) {
      reason += ': its last attestation showed reserves below the 10% floor';
    } else if (isNum(house.protest_open) && house.protest_open > 0) {
      reason += ': a noteholder protest is open';
    } else if (deadline !== null && tipHeight > deadline) {
      reason += `: it is past its attestation deadline (block ${deadline})`;
    }
    reason += '. If it does not recover it becomes insolvent.';
    if (house.confidence_dead) {
      reason += ' It can no longer invoke the option clause.';
    }
    return result('stressed', reason);
  }

  if (status === 'open') {
    // pareligible is the node's own verdict at its tip; derive it only if an older node
    // does not publish the field
    const parEligible = typeof house.pareligible === 'boolean'
      ? house.pareligible
      : !belowFloor && dueHeight !== null && tipHeight <= dueHeight;
    if (parEligible) {
      const pct = ratio !== null ? `, attested reserve ratio ${ratio / 100}%` : '';
      return result('sound', `Open and attested at block ${last ?? '?'}${pct}.`);
    }
    if (belowFloor) {
      return result('attestation_due', `Open, but its attested reserve ratio (${(ratio as number) / 100}%) is below the 10% floor.`);
    }
    const by = deadline !== null ? ` It must attest by block ${deadline} or it becomes stressed.` : '';
    const age = last !== null && cadence !== null
      ? `Open, but its last attestation (block ${last}) is more than ${cadence} blocks old, so it cannot settle at par.`
      : 'Open, but not attested recently enough to settle at par.';
    return result('attestation_due', age + by);
  }

  return result('stressed', `Unrecognised house status "${status}".`);
}
