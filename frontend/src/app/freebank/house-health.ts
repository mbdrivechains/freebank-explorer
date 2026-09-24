import { FreebankHouse } from '@interfaces/freebank-credit.interface';
import { formatBlocksFromTip, formatBps, formatEcx, formatUnits } from '@app/freebank/credit-units';

// House health badge (design decision 39, gateway/docs/freebank/FREEBANK_DISTRIBUTION.md s3):
// a per-house "bank note reporter" read from the attestation state gethouse already serves.
// Pure TypeScript (no Angular) so the backend's /summary houses_by_badge can use the same rules.
//
// What the node tells us (freebank src/house.cpp, src/rpc/misc.cpp HouseToJSON):
//  - status is STORED: 'open', 'wounddown', or 'insolvent' once the first insolvency claim
//    materializes it. effective_status is the status IN FORCE at the tip
//    (HouseEffectiveStatus): it also derives
//      'stressed'  from the earliest of three origins (HouseStressOrigin):
//                  a below-floor attestation (stored stress_since),
//                  missed attestations: no attestation by attest_deadline, stressed from
//                  attest_deadline + 1, and an open note protest (protest_open > 0);
//      'deferred'  the option clause is invoked (defer_invoked_height set): a substate of
//                  stressed in which redemptions are deferred instead of paid at par;
//      'insolvent' when stressed for the whole stressed window (1008 blocks under the
//                  consensus rules; regtest can shorten it and the RPC does not report it),
//                  or when the deferral window ends (defer_end_height) without recovery.
//  - attest_deadline = lastattestheight + 2 * cadence (HOUSE_ATTEST_MISS_N = 2; cadence is
//    144 blocks under the consensus rules, regtest can override it). So the cadence is
//    (attest_deadline - lastattestheight) / 2, read from the node rather than hard-coded.
//    A new house's clock starts at registration (lastattestheight = registeredheight).
//  - pareligible (HouseParEligible) = effective 'open' AND attested ratio >= the 10% reserve
//    floor AND the last attestation at most one cadence old. Only par-eligible houses can
//    exchange notes at par in settlement (v16); other houses' notes clear at market in pools.
//  - attestedratiobps = reserves / notes at the last attestation, capped at 10000 (and 10000
//    with no notes outstanding). brassagebps, the redemption spread, is 0 at or above the
//    floor, so an open house always redeems at par.
//  - insolventheight / insolventunits / insolventpot are present once insolvency is
//    materialized. An insolvent house's notes are claims on its pot, paid pro rata, not par.
//  - confidence_dead: the house may not invoke the option clause again.
//
// THE BADGE RULES, first match wins (tip = the tip_height the API returned):
//  1. INSOLVENT        effective_status or status is 'insolvent', or insolventheight is set,
//                      or a deferral whose defer_end_height is at or below the tip.
//  2. WOUND DOWN       effective_status or status is 'wounddown' (not one of the four design-39
//                      badges: a closed house, which could only wind down with no notes or
//                      term deposits outstanding).
//  3. STRESSED         effective_status is 'stressed' or 'deferred'; or, if the record is older
//                      than the tip, tip > attest_deadline or protest_open > 0 (the same
//                      origins the node derives, so a cached record cannot show SOUND late).
//  4. ATTESTATION DUE  effective 'open' but pareligible is false, or tip is past
//                      lastattestheight + cadence: the regular attestation is late. The house
//                      still redeems at par but cannot settle at par, and becomes stressed
//                      after attest_deadline.
//  5. SOUND            everything else: open, ratio at or above the floor, attestation current.

export type HouseBadge = 'sound' | 'attestation_due' | 'stressed' | 'insolvent' | 'wound_down';

export const HOUSE_BADGE_LABELS: { [badge in HouseBadge]: string } = {
  sound: 'SOUND',
  attestation_due: 'ATTESTATION DUE',
  stressed: 'STRESSED',
  insolvent: 'INSOLVENT',
  wound_down: 'WOUND DOWN',
};

/** Badge order for lists and counts, healthiest first. */
export const HOUSE_BADGE_ORDER: HouseBadge[] = ['sound', 'attestation_due', 'stressed', 'insolvent', 'wound_down'];

// Mirrors of node constants (freebank house.h), used only for wording and stale-record checks
export const HOUSE_RESERVE_FLOOR_BPS = 1000;     // HOUSE_RESERVE_FLOOR_PCT = 10
export const HOUSE_ATTEST_MISS_N = 2;
export const HOUSE_STRESSED_WINDOW_CONSENSUS = 1008;
export const HOUSE_DEFER_INTEREST_BPS = 500;

export interface HouseHealth {
  badge: HouseBadge;
  label: string;                  // 'SOUND', 'ATTESTATION DUE', ...
  summary: string;                // one short line for list rows
  reasons: string[];              // the tooltip, most important first
  notesAtPar: boolean;            // notes redeem at the house at par right now
  notesImpaired: boolean;         // insolvent: notes are pro-rata claims, show them apart from par balances
  parEligible: boolean;           // may exchange notes at par in settlement
  attestationCadence: number | null; // blocks between regular attestations (derived)
  nextAttestationDue: number | null; // height: lastattestheight + cadence
  stressedAfter: number | null;   // height: attest_deadline (stressed from the next block without an attestation)
  tipHeight: number | null;       // the tip the badge was computed against
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function relative(height: number, tip: number | null): string {
  return tip === null ? '' : ` (${formatBlocksFromTip(height, tip)})`;
}

/** Blocks between regular attestations, from attest_deadline = lastattestheight + 2 * cadence. */
export function houseAttestationCadence(house: Pick<FreebankHouse, 'attest_deadline' | 'lastattestheight'>): number | null {
  if (!house || !isNumber(house.attest_deadline) || !isNumber(house.lastattestheight)) {
    return null;
  }
  const span = house.attest_deadline - house.lastattestheight;
  return span > 0 ? Math.round(span / HOUSE_ATTEST_MISS_N) : null;
}

/** True while the house has never attested (its clock still runs from registration). */
export function houseNeverAttested(house: FreebankHouse): boolean {
  return house.lastattestreserves === 0 && house.lastattestheight === house.registeredheight;
}

/** The attested reserve ratio in words: '100% or more', '12.5%', or 'no notes outstanding'. */
export function formatAttestedRatio(house: Pick<FreebankHouse, 'attestedratiobps' | 'mintedunits'>): string {
  if (!house.mintedunits) {
    return 'no notes outstanding';
  }
  if (house.attestedratiobps >= 10000) {
    return '100% or more';
  }
  return formatBps(house.attestedratiobps);
}

export function houseHealth(house: FreebankHouse, tipHeight?: number | null): HouseHealth {
  const tip = isNumber(tipHeight) && tipHeight >= 0 ? tipHeight : null;
  const effective = house.effective_status;
  const cadence = houseAttestationCadence(house);
  const nextDue = cadence !== null ? house.lastattestheight + cadence : null;
  const neverAttested = houseNeverAttested(house);

  const missedAttestations = tip !== null && tip > house.attest_deadline;
  const ratioBelowFloor = house.mintedunits > 0 && house.attestedratiobps < HOUSE_RESERVE_FLOOR_BPS;
  const protestsOpen = house.protest_open || 0;
  const deferred = effective === 'deferred' || (house.defer_invoked_height || 0) > 0;
  const deferEnd = house.defer_end_height || 0;
  const deferExpired = deferred && deferEnd > 0 && tip !== null && tip >= deferEnd;
  const lateForPar = tip !== null && nextDue !== null && tip > nextDue;

  const health: HouseHealth = {
    badge: 'sound',
    label: '',
    summary: '',
    reasons: [],
    notesAtPar: true,
    notesImpaired: false,
    parEligible: !!house.pareligible,
    attestationCadence: cadence,
    nextAttestationDue: nextDue,
    stressedAfter: isNumber(house.attest_deadline) ? house.attest_deadline : null,
    tipHeight: tip,
  };
  const reasons = health.reasons;
  const coverage = house.mintedunits
    ? ` Attested reserves cover ${formatAttestedRatio(house)} of its notes.`
    : ' It has no notes outstanding.';
  const lastAttested = neverAttested
    ? `It has not attested since it registered at block ${house.registeredheight}${relative(house.registeredheight, tip)}.${coverage}`
    : `Last attestation at block ${house.lastattestheight}${relative(house.lastattestheight, tip)}.${coverage}`;

  if (effective === 'insolvent' || house.status === 'insolvent' || (house.insolventheight || 0) > 0 || deferExpired) {
    health.badge = 'insolvent';
    health.notesAtPar = false;
    health.notesImpaired = true;
    health.parEligible = false;
    health.summary = 'Insolvent: its notes are claims on the pot, not par.';
    if (house.insolventheight) {
      reasons.push(`Insolvent since block ${house.insolventheight}${relative(house.insolventheight, tip)}.`);
    } else if (deferred && deferEnd) {
      reasons.push(`The option clause ran out at block ${deferEnd} without a recovery, so the house is insolvent.`);
    } else if (house.stress_since) {
      reasons.push(`Stressed since block ${house.stress_since} and did not recover within the stressed window, so the house is insolvent.`);
    } else {
      reasons.push('The house is insolvent.');
    }
    reasons.push('Its notes are no longer paid at par: each holder claims a pro-rata share of the house\'s pot.');
    if (isNumber(house.insolventpot)) {
      const units = isNumber(house.insolventunits) ? ` for ${formatUnits(house.insolventunits)} note units outstanding` : '';
      reasons.push(`Pot: ${formatEcx(house.insolventpot)} ECX${units}.`);
    }
  } else if (effective === 'wounddown' || house.status === 'wounddown') {
    health.badge = 'wound_down';
    health.notesAtPar = false;
    health.parEligible = false;
    health.summary = 'Wound down: no notes outstanding.';
    reasons.push('The partners have wound the house down. A house can only wind down with no notes or term deposits outstanding.');
  } else if (effective === 'stressed' || effective === 'deferred' || deferred || missedAttestations || protestsOpen > 0) {
    health.badge = 'stressed';
    health.parEligible = false;
    health.notesAtPar = !deferred && !house.brassagebps;
    if (deferred) {
      health.summary = 'Option clause invoked: redemptions deferred.';
      const invoked = house.defer_invoked_height ? ` at block ${house.defer_invoked_height}` : '';
      reasons.push(`The partners invoked the option clause${invoked}: redemptions are deferred, not paid at par. ` +
        `A holder who lodges a demand earns ${formatBps(HOUSE_DEFER_INTEREST_BPS)} a year from the date of demand.`);
      if (deferEnd) {
        reasons.push(`If the house has not recovered by block ${deferEnd}${relative(deferEnd, tip)}, it becomes insolvent.`);
      }
    } else {
      health.summary = house.stress_since ? `Stressed since block ${house.stress_since}.` : 'Stressed.';
    }
    if (missedAttestations || (house.stress_since && house.stress_since === house.attest_deadline + 1)) {
      const last = neverAttested
        ? `it has not attested since it registered at block ${house.registeredheight}`
        : `the last was at block ${house.lastattestheight}`;
      reasons.push(`Missed its attestations: ${last}, and it had until block ${house.attest_deadline}.`);
    }
    if (ratioBelowFloor) {
      reasons.push(`Its last attested reserve ratio, ${formatBps(house.attestedratiobps)}, is below the ${formatBps(HOUSE_RESERVE_FLOOR_BPS)} reserve floor.`);
    }
    if (protestsOpen > 0) {
      const since = house.protest_height ? ` since block ${house.protest_height}` : '';
      reasons.push(`A note holder has protested a demand the house did not pay (${protestsOpen} open${since}).`);
    }
    if (!deferred) {
      if (house.stress_since) {
        reasons.push(`Stressed since block ${house.stress_since}${relative(house.stress_since, tip)}. ` +
          `If it does not recover within the stressed window (${formatUnits(HOUSE_STRESSED_WINDOW_CONSENSUS)} blocks under the consensus rules), it becomes insolvent.`);
      } else {
        reasons.push('If it does not recover within the stressed window, it becomes insolvent.');
      }
    }
    if (house.brassagebps > 0) {
      reasons.push(`Redemptions pay a spread of ${formatBps(house.brassagebps)}, which goes into the pot for the holders who stay.`);
    }
    reasons.push('Its notes are not accepted at par in settlement between houses while it is stressed.');
  } else if (house.pareligible === false || lateForPar) {
    health.badge = 'attestation_due';
    health.parEligible = false;
    health.summary = `Attestation overdue: stressed after block ${house.attest_deadline}.`;
    reasons.push(lastAttested);
    if (cadence !== null && nextDue !== null) {
      reasons.push(`Houses attest every ${formatUnits(cadence)} blocks, so the next was due by block ${nextDue}.`);
    }
    if (ratioBelowFloor) {
      reasons.push(`Its last attested reserve ratio, ${formatBps(house.attestedratiobps)}, is below the ${formatBps(HOUSE_RESERVE_FLOOR_BPS)} reserve floor.`);
    }
    reasons.push('Its notes still redeem at par, but are not accepted at par in settlement between houses until it attests again.');
    reasons.push(`If it has not attested by block ${house.attest_deadline}${relative(house.attest_deadline, tip)}, it becomes stressed.`);
  } else {
    health.badge = 'sound';
    health.parEligible = true;
    health.summary = 'Open, attested above the reserve floor, attestation current.';
    reasons.push(`Open. ${lastAttested}`);
    if (nextDue !== null) {
      reasons.push(`Next attestation due by block ${nextDue}${relative(nextDue, tip)}.`);
    }
    reasons.push('Its notes redeem at par and are accepted at par in settlement between houses.');
  }

  if (house.confidence_dead && (health.badge === 'sound' || health.badge === 'attestation_due' || health.badge === 'stressed')) {
    reasons.push('It has used the option clause too recently or for too long, so it cannot invoke it again.');
  }

  health.label = HOUSE_BADGE_LABELS[health.badge];
  return health;
}

/** Count houses per badge (the shape of /summary houses_by_badge, plus wound_down). */
export function countHouseBadges(houses: FreebankHouse[], tipHeight?: number | null): { [badge in HouseBadge]: number } {
  const counts = { sound: 0, attestation_due: 0, stressed: 0, insolvent: 0, wound_down: 0 };
  for (const house of houses || []) {
    counts[houseHealth(house, tipHeight).badge]++;
  }
  return counts;
}
