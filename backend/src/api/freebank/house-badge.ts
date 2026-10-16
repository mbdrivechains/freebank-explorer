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
//                       - deferred:  SUSPENDED: a stressed house that invoked the option
//                                    clause. Redemptions are queued, not paid at par; a demanded
//                                    note earns defer_interest_bps a year. From v0.2.18 a suspension
//                                    has no end date: it ends by a reopen (an attestation at the
//                                    floor plus a buffer), by silence (defer_silence_insolvent_height) or, from
//                                    v0.2.28, at the 12-month cap (defer_cap_insolvent_height).
//                       - insolvent: stressed for HOUSE_STRESSED_WINDOW blocks (1008 on the
//                                    real networks; regtest may override it) without recovering,
//                                    or a suspended house that stopped attesting (silence).
//                                    Absorbing: every op that could change it is refused from then on.
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
//   defer_silence_insolvent_height  (suspended houses only, v0.2.18) the first block at which the
//                     house is insolvent unless it attests before then; every attestation moves it.
//   defer_activations, defer_ended_height, defer_suspended_blocks  how often the house has suspended,
//                     when the last suspension ended (the reopen) and the blocks spent suspended in
//                     all. v0.2.18 dropped the limit on suspending (and with it confidence_dead and
//                     defer_end_height), so these counts are what tells a holder about a repeat suspender.
//   insolventheight   present once insolvency has been materialized.
//
// The badge:
//
//   INSOLVENT        effective_status (or stored status) is 'insolvent', or insolventheight
//                    is set. Its notes are impaired claims, paid out pro rata from the
//                    house's escrow - NOT at par. The only "discount" a FreeBank holder sees.
//   STRESSED         effective_status is 'stressed' or 'deferred' (suspended; the reason says so).
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
  insolventheight?: number;
  stress_since?: number;
  protest_open?: number;
  defer_invoked_height?: number;
  defer_silence_insolvent_height?: number;
  defer_insolvent_height?: number; // v0.2.28: the earlier of silence and the 12-month cap (defer_cap_insolvent_height)
  defer_cap_insolvent_height?: number;
  defer_interest_bps?: number;
  defer_activations?: number;
  // v0.2.28 a failed house's timeline (FAILED_HOUSE_DESIGN.md B, E)
  insolvent_since?: number; // only once insolvent: the height it became insolvent
  collection_done?: boolean; // only once insolvent: the loan book has run off (or the collection window ended)
  claim_window_closes?: number; // only once insolvent: from this height anyone may CLOSE the house
  closed?: boolean; // CLOSEd: the partners got their residual, the rest went to the mutual fund
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

  // insolvent_since is the node's answer for the NEXT block (HouseInsolventSince at tip + 1): count it only once reached
  const insolventSince = isNum(house.insolvent_since) && house.insolvent_since <= tipHeight ? house.insolvent_since : undefined;
  if (status === 'insolvent' || house.status === 'insolvent' || isNum(house.insolventheight) || insolventSince !== undefined || house.closed === true) {
    const sinceHeight = insolventSince ?? house.insolventheight;
    const since = isNum(sinceHeight) ? ` since block ${sinceHeight}` : '';
    if (house.closed === true) {
      // HouseClosed: every partner settled. Either the partners' settle once every holder was paid (the residual to
      // the partners), or a CLOSE after the claim window (the rest of the escrow to the mutual fund)
      const at = isNum(sinceHeight) ? ` at block ${sinceHeight}` : '';
      return result('insolvent', `Closed: the house failed${at} and has been wound up. Its partners took their residual; no more claims are paid.`);
    }
    if (house.collection_done === false) {
      return result('insolvent', `Insolvent${since}, collecting: the bills it holds are repaid into its escrow, and claims are paid ` +
        `once its loan book is empty or the collection window ends. Its notes are impaired claims, not paid at par.`);
    }
    // claims stay open until someone CLOSEs the house, which is allowed from claim_window_closes
    const window = !isNum(house.claim_window_closes) ? ''
      : tipHeight < house.claim_window_closes ? ` Claims are paid at least until block ${house.claim_window_closes}, when anyone may close the house.`
      : ` Its claim window ended at block ${house.claim_window_closes}: claims are paid until someone closes the house.`;
    return result('insolvent', `Insolvent${since}: its notes are impaired claims, paid out pro rata from the house's escrow, not at par.${window}`);
  }

  if (status === 'wounddown') {
    return result('wound_down', 'Wound down: the house has closed, with no notes or deposits outstanding.');
  }

  if (status === 'stressed' || status === 'deferred') {
    if (status === 'deferred') {
      const since = isNum(house.defer_invoked_height) && house.defer_invoked_height > 0 ? ` since block ${house.defer_invoked_height}` : '';
      const rate = isNum(house.defer_interest_bps) && house.defer_interest_bps > 0 ? ` and earn ${house.defer_interest_bps / 100}% a year` : '';
      const silenceAt = isNum(house.defer_silence_insolvent_height) ? house.defer_silence_insolvent_height : 0;
      const capAt = isNum(house.defer_cap_insolvent_height) ? house.defer_cap_insolvent_height : 0;
      const silence = capAt > 0 && (silenceAt === 0 || capAt <= silenceAt)
        ? ` It becomes insolvent at block ${capAt}, when the suspension reaches its 12-month limit.`
        : silenceAt > 0
          ? ` It becomes insolvent at block ${silenceAt} unless it attests before then` +
            (capAt > 0 ? `, and at block ${capAt} at the latest (a suspension lasts at most 12 months).` : '.')
          : '';
      const count = isNum(house.defer_activations) && house.defer_activations > 1
        ? ` This is suspension number ${house.defer_activations}.`
        : '';
      return result('stressed', `Suspended${since}: the house invoked the option clause, so redemptions are queued${rate}, not paid at par. ` +
        `It reopens when it attests reserves back above the floor plus a buffer.${silence}${count}`);
    }
    let reason = isNum(house.stress_since) ? `Stressed since block ${house.stress_since}` : 'Stressed';
    if (deadline !== null && house.stress_since === deadline + 1) {
      reason += `: it missed its attestation deadline (block ${deadline})`;
    } else if (belowFloor) {
      reason += ': its last attestation showed reserves below the 10% floor';
    } else if (isNum(house.protest_open) && house.protest_open > 0) {
      reason += ': a protest is open (of its notes or a term deposit)';
    } else if (deadline !== null && tipHeight > deadline) {
      reason += `: it is past its attestation deadline (block ${deadline})`;
    }
    reason += '. If it does not recover it becomes insolvent.';
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
