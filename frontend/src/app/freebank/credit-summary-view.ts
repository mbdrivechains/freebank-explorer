import { FreebankHouseBadgeCounts } from '@interfaces/freebank-credit.interface';
import { HOUSE_BADGE_LABELS, HOUSE_BADGE_ORDER, HOUSE_RESERVE_FLOOR_BPS, HouseBadge } from '@app/freebank/house-health';
import { formatBps } from '@app/freebank/credit-units';

// House badge counts (GET /summary houses_by_badge) as chips for the credit overview and the
// dashboard card. Pure TypeScript (no Angular). The chip colours mirror
// components/house-health-badge/house-health-badge.component.scss (classes house-health-<badge>).

export interface CreditBadgeCount {
  badge: HouseBadge;
  label: string;                  // 'SOUND', 'STRESSED', ... (the badge's own wording)
  count: number;
  explainer: string;              // what the badge means, for a tooltip
}

/** What each badge means, in one or two sentences (the rules are in freebank/house-health.ts). */
export const HOUSE_BADGE_EXPLAINERS: { [badge in HouseBadge]: string } = {
  sound: `Open, reserves attested at or above the ${formatBps(HOUSE_RESERVE_FLOOR_BPS)} floor, attestation up to date. ` +
    'Its notes redeem at par and settle at par between houses.',
  attestation_due: 'Open and still redeeming at par, but late with its reserve attestation, so its notes do not settle at par ' +
    'between houses until it attests again.',
  stressed: 'Missed its attestations, attested reserves below the floor, had an unpaid demand protested by a holder, ' +
    'or invoked the option clause (redemptions deferred). It becomes insolvent if it does not recover in time.',
  insolvent: 'Its notes are claims on the house\'s pot, paid pro rata, not at par.',
  wound_down: 'Closed by its partners with no notes or term deposits outstanding.',
};

/** Houses per badge, healthiest first, leaving out badges with no houses. */
export function creditBadgeCounts(counts: FreebankHouseBadgeCounts | null | undefined): CreditBadgeCount[] {
  return HOUSE_BADGE_ORDER
    .map((badge) => ({
      badge,
      label: HOUSE_BADGE_LABELS[badge],
      count: typeof counts?.[badge] === 'number' ? counts[badge] : 0,
      explainer: HOUSE_BADGE_EXPLAINERS[badge],
    }))
    .filter((entry) => entry.count > 0);
}

/** '1 sound, 2 stressed' (for tooltips and screen readers); 'no houses' when empty. */
export function creditBadgeCountsText(entries: CreditBadgeCount[]): string {
  if (!entries?.length) {
    return 'no houses';
  }
  return entries.map((entry) => `${entry.count} ${entry.label.toLowerCase()}`).join(', ');
}
