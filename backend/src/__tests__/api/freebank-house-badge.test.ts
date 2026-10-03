import { houseBadge, HouseBadgeFields } from '../../api/freebank/house-badge';

// House 1 as gethouse reported it at tip 454 on the spike chain (attested at 452, cadence
// 144 -> attest_deadline 740); the other cases vary it the way the node's derivation does.
const open: HouseBadgeFields = {
  status: 'open',
  effective_status: 'open',
  attestedratiobps: 10000,
  lastattestheight: 452,
  attest_deadline: 740,
  pareligible: true,
};

describe('FreeBank house health badge', () => {
  test('open and par-eligible is SOUND', () => {
    const b = houseBadge(open, 454);
    expect(b.badge).toEqual('sound');
    expect(b.notes_impaired).toBe(false);
    expect(b.attest_cadence).toEqual(144);
    expect(b.attest_due_height).toEqual(596);
    expect(b.attest_deadline).toEqual(740);
  });

  test('open but attested more than one cadence ago is ATTESTATION DUE', () => {
    const b = houseBadge({ ...open, pareligible: false }, 600);
    expect(b.badge).toEqual('attestation_due');
    expect(b.reason).toMatch(/block 740/);
  });

  test('open with the attested ratio below the 10% floor is ATTESTATION DUE, not sound', () => {
    const b = houseBadge({ ...open, attestedratiobps: 900, pareligible: false }, 454);
    expect(b.badge).toEqual('attestation_due');
    expect(b.reason).toMatch(/floor/);
  });

  test('without a pareligible field the rule is derived: recent attestation and ratio at the floor', () => {
    const older: HouseBadgeFields = { ...open };
    delete older.pareligible;
    expect(houseBadge(older, 596).badge).toEqual('sound');
    expect(houseBadge(older, 597).badge).toEqual('attestation_due');
    expect(houseBadge({ ...older, attestedratiobps: 999 }, 454).badge).toEqual('attestation_due');
  });

  test('missed attestation deadline is STRESSED (house 2 on the spike chain at 454)', () => {
    const b = houseBadge({
      status: 'open', effective_status: 'stressed', stress_since: 328, attestedratiobps: 10000,
      lastattestheight: 39, attest_deadline: 327, pareligible: false,
    }, 454);
    expect(b.badge).toEqual('stressed');
    expect(b.notes_impaired).toBe(false);
    expect(b.reason).toMatch(/missed its attestation deadline \(block 327\)/);
  });

  test('a suspended house (option clause invoked, v0.2.18: no end date) is STRESSED, with the silence deadline', () => {
    const b = houseBadge({
      ...open, effective_status: 'deferred', pareligible: false, defer_invoked_height: 430,
      defer_silence_insolvent_height: 781, defer_interest_bps: 1000, defer_activations: 2,
    }, 454);
    expect(b.badge).toEqual('stressed');
    expect(b.reason).toMatch(/^Suspended since block 430/);
    expect(b.reason).toMatch(/earn 10% a year/);
    expect(b.reason).toMatch(/insolvent at block 781 unless it attests/);
    expect(b.reason).toMatch(/suspension number 2/);
    expect(b.reason).not.toMatch(/until block/);
  });

  test('a first suspension does not count itself; missing v0.2.18 fields leave their sentences out', () => {
    const b = houseBadge({ ...open, effective_status: 'deferred', pareligible: false, defer_activations: 1 }, 454);
    expect(b.reason).toEqual('Suspended: the house invoked the option clause, so redemptions are queued, not paid at par. ' +
      'It reopens when it attests reserves back above the floor.');
  });

  test('derived insolvency (effective_status) is INSOLVENT, with impaired notes', () => {
    const b = houseBadge({ ...open, effective_status: 'insolvent', pareligible: false }, 2000);
    expect(b.badge).toEqual('insolvent');
    expect(b.notes_impaired).toBe(true);
  });

  test('materialized insolvency (stored status, insolventheight) is INSOLVENT', () => {
    expect(houseBadge({ ...open, status: 'insolvent', effective_status: 'insolvent', insolventheight: 1500 }, 2000).badge).toEqual('insolvent');
    expect(houseBadge({ ...open, insolventheight: 1500 }, 2000).reason).toMatch(/since block 1500/);
  });

  test('a wound-down house gets its own badge', () => {
    expect(houseBadge({ ...open, status: 'wounddown', effective_status: 'wounddown' }, 454).badge).toEqual('wound_down');
  });

  test('an unrecognised status is never shown as sound', () => {
    expect(houseBadge({ ...open, effective_status: 'unknown' }, 454).badge).toEqual('stressed');
  });
});
