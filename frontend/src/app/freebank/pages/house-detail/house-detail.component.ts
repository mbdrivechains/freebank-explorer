import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Observable, combineLatest, map, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import {
  FreebankActivityItem, FreebankActivityResponse, FreebankBill, FreebankDecodedPayload, FreebankHouse, FreebankHousePartner, FreebankHouseResponse,
  FreebankLoanBook, FreebankPool,
} from '@interfaces/freebank-credit.interface';
import { HouseHealth, formatAttestedRatio, houseHealth, houseNeverAttested } from '@app/freebank/house-health';
import { CREDIT_FAMILIES } from '@app/freebank/credit-ops';
import { SATS_PER_ECX, formatBlockCount, formatBlocksFromTip, formatBps, poolSpotSatsPerUnit } from '@app/freebank/credit-units';
import {
  HOUSE_TYPE_LABELS, HOUSE_TYPE_TOOLTIPS, houseHasMembers,
  ActivityDetail, AttestationClock, BillMaturity, HouseCapacity, activityNamesHouse, attestationClock, billMaturity,
  describeActivity, ecxToGrams, formatPercent, houseCapacity, houseStatusLabel, houseTierLabel, unitsToGrams,
} from '@app/freebank/pages/house-common/house-view';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

// The activity feed is chain-wide and newest first; the page asks for the most the backend
// serves and keeps the transactions that name this house.
const ACTIVITY_LIMIT = 200;

export interface HousePartnerRow {
  partner: FreebankHousePartner;
  pledgeGrams: number | undefined;
  statusText: string;
}

export interface HouseLoanRow {
  bill: FreebankBill;
  maturity: BillMaturity;
  holderIsHouse: boolean;         // the holder is the house's custody key
}

export interface HousePoolRow {
  pool: FreebankPool;
  spotSatsPerUnit: number | null;
  parText: string;                // '95.53% of par'
}

export interface HouseDeferral {
  state: 'active' | 'past' | 'never';
  text: string;
}

export interface HouseOptionClause {
  text: string;                   // 'available', 'in force', 'not available', 'not needed'
  sub: string;                    // why, in a short line
  warn: boolean;
}

/** v0.2.28 a failed house's timeline, shown in its Insolvency section. */
export interface HouseFailure {
  since: number;                  // insolvent_since, else insolventheight (an older node); 0 if neither
  recordedAt: number;             // insolventheight when it differs from since: the first claim recorded the insolvency
  collection: 'collecting' | 'done' | null; // null: an older node that does not say
  claimWindowCloses: number;      // 0: not reported
  claimWindowOpen: boolean;       // the tip is before claimWindowCloses
  closed: boolean;
}

export interface HouseDetailData {
  tip: number;
  house: FreebankHouse;
  health: HouseHealth;
  statusLabel: string;
  storedStatusLabel: string | null;  // set when the stored status differs from the status in force
  ratioText: string;
  neverAttested: boolean;
  tierLabel: string;
  attests: boolean;               // still on the attestation clock (not insolvent or wound down)
  clock: AttestationClock;
  capacity: HouseCapacity;
  mintCapLine: string;            // notes against the mint cap, in words
  depositGrams: number | undefined;
  roomGrams: number | undefined;
  issueBlocked: string | null;    // why the house cannot issue in the next block, whatever the caps allow
  depositsMatured: boolean;       // term deposits outstanding whose average maturity has passed
  deferral: HouseDeferral;
  optionClause: HouseOptionClause;
  insolvent: boolean;
  failure: HouseFailure;
  partners: HousePartnerRow[];
  partnersActive: number;
  loanbook: FreebankLoanBook;
  loanRows: HouseLoanRow[];
  pastBills: FreebankBill[];      // bills this house held that are no longer on its book
  pools: HousePoolRow[];
}

export interface HouseActivityRow {
  item: FreebankActivityItem;
  familyLabel: string;
  detail: ActivityDetail;
}

export interface HouseActivityView {
  loading: boolean;
  error?: HttpErrorResponse;
  rows: HouseActivityRow[];
  scannedFrom: number | null;     // lowest block the backend scanned
  discounts: { [billId: number]: FreebankActivityItem };  // BILL_OP_DISCOUNT into this house, by dense bill id
  lastAttest: FreebankActivityItem | null;                // the attestation at lastattestheight, if listed
  close: FreebankActivityItem | null;                     // v0.2.28: the CLOSE of this failed house, if listed
}

export interface HouseDetailView {
  loading: boolean;               // first load in flight (no data yet)
  refreshing: boolean;
  error?: HttpErrorResponse;
  notFound: boolean;
  data?: HouseDetailData;
  activity: HouseActivityView;
}

function partnerStatusText(partner: FreebankHousePartner, tip: number): string {
  switch (partner.status) {
    case 'active':
      return 'Active';
    case 'tail':
      return partner.tailunlockheight
        ? `Leaving: pledge locked until block ${partner.tailunlockheight} (${formatBlocksFromTip(partner.tailunlockheight, tip)})`
        : 'Leaving: pledge still locked';
    case 'settled':
      return 'Left and settled';
    default:
      return partner.status || 'Unknown';
  }
}

function deferralView(house: FreebankHouse, tip: number): HouseDeferral {
  // v0.2.18: no end date and no limit on repeats, so the count is always shown (the operator's condition)
  const n = house.defer_activations || 0;
  const count = `${n} ${n === 1 ? 'suspension' : 'suspensions'}`;
  const ended = house.defer_ended_height ? `; last reopened at block ${house.defer_ended_height}` : '';
  const blocks = house.defer_suspended_blocks ? `, ${formatBlockCount(house.defer_suspended_blocks)} suspended in all` : '';
  if (house.defer_invoked_height) {
    // v0.2.28: insolvent at the earlier of silence and the 12-month cap
    const silenceAt = house.defer_silence_insolvent_height || 0;
    const capAt = house.defer_cap_insolvent_height || 0;
    const silence = silenceAt && (!capAt || silenceAt < capAt)
      ? ` Insolvent at block ${silenceAt} (${formatBlocksFromTip(silenceAt, tip)}) unless it attests first.`
      : '';
    const cap = capAt ? ` Insolvent at block ${capAt} (${formatBlocksFromTip(capAt, tip)}) at the latest, unless it reopens: a suspension lasts at most 12 months.` : '';
    return {
      state: 'active',
      text: `Suspended since block ${house.defer_invoked_height}: redemptions are queued.${silence}${cap} ${count}${ended}${blocks}.`,
    };
  }
  if (n > 0) {
    return { state: 'past', text: `Not suspended now. ${count}${ended}${blocks}.` };
  }
  return { state: 'never', text: 'Never suspended' };
}

function houseFailure(house: FreebankHouse, tip: number): HouseFailure {
  // insolvent_since is the node's answer for the next block: count it once the tip reaches it
  const since = (house.insolvent_since && house.insolvent_since <= tip ? house.insolvent_since : 0) || house.insolventheight || 0;
  const closes = house.claim_window_closes || 0;
  return {
    since,
    recordedAt: house.insolventheight && house.insolventheight !== since ? house.insolventheight : 0,
    collection: house.collection_done === true ? 'done' : house.collection_done === false ? 'collecting' : null,
    claimWindowCloses: closes,
    claimWindowOpen: closes > 0 && tip < closes,
    closed: house.closed === true,
  };
}

/**
 * Why the house cannot issue notes (or discount a bill, which issues notes) in the next block,
 * as the node checks it (validation.cpp NOTE_OP_MINT, BILL_OP_DISCOUNT): the house must be open,
 * and its last attestation at most one cadence old at the height of the new block. null if the
 * only limit is the caps.
 */
function issueBlockedText(house: FreebankHouse, health: HouseHealth, tip: number): string | null {
  const effective = house.effective_status || house.status;
  if (health.badge === 'insolvent') {
    return 'none: an insolvent house cannot issue';
  }
  if (health.badge === 'wound_down') {
    return 'none: the house is wound down';
  }
  if (effective === 'deferred' || house.defer_invoked_height) {
    return 'none while the option clause is in force';
  }
  if (health.badge === 'stressed' || effective !== 'open') {
    return 'none while the house is stressed: only an open house can issue';
  }
  if (houseNeverAttested(house)) {
    return 'none until the house first attests its reserves';
  }
  if (health.nextAttestationDue !== null && tip + 1 > health.nextAttestationDue) {
    return 'none until it attests again: issuing needs an attestation within one cadence';
  }
  return null;
}

// The option clause is a tool for a stressed house only (validation.cpp HOUSE_OP_DEFER).
function optionClauseView(house: FreebankHouse, health: HouseHealth): HouseOptionClause {
  const effective = house.effective_status || house.status;
  if (health.badge === 'insolvent' || health.badge === 'wound_down') {
    return { text: 'not available', sub: health.badge === 'insolvent' ? 'the house is insolvent' : 'the house is wound down', warn: false };
  }
  if (effective === 'deferred' || house.defer_invoked_height) {
    const rate = house.defer_interest_bps !== undefined ? formatBps(house.defer_interest_bps) : 'interest';
    return { text: 'in force', sub: `redemptions are queued; demanded notes earn ${rate} a year`, warn: true };
  }
  if (effective === 'stressed') {
    return { text: 'available', sub: 'the partners may invoke it after a fresh attestation, locking the reserves in escrow', warn: false };
  }
  return { text: 'not needed', sub: 'only a stressed house can invoke it', warn: false };
}

function toData(response: FreebankHouseResponse): HouseDetailData {
  const house = response.house;
  const tip = response.tip_height;
  const health = houseHealth(house, tip);
  const capacity = houseCapacity(house);
  const effective = house.effective_status || house.status;
  const loanbook: FreebankLoanBook = response.loanbook || { house_id: house.id, count: 0, face_total: 0, face_total_grams: 0, bills: [] };
  const bookBills = loanbook.bills || [];
  const onBook = new Set(bookBills.map((bill) => bill.id));
  return {
    tip,
    house,
    health,
    statusLabel: house.closed === true ? 'Closed (a failed house)'
      : effective === 'insolvent' && house.collection_done === false ? 'Insolvent, collecting' : houseStatusLabel(effective),
    storedStatusLabel: house.status && house.status !== effective ? houseStatusLabel(house.status) : null,
    ratioText: formatAttestedRatio(house),
    neverAttested: houseNeverAttested(house),
    tierLabel: houseTierLabel(house.tier),
    attests: health.badge !== 'insolvent' && health.badge !== 'wound_down',
    clock: attestationClock(house, tip),
    capacity,
    mintCapLine: capacity.mint.percent !== null
      ? `${capacity.mint.text} of the mint cap`
      : (capacity.mint.over ? 'over the mint cap' : `the mint cap is 0${house.reservecapunits ? '' : ' until the house attests reserves'}`),
    depositGrams: unitsToGrams(capacity.deposits, capacity.gramsPerUnit),
    roomGrams: unitsToGrams(capacity.roomToIssue, capacity.gramsPerUnit),
    issueBlocked: issueBlockedText(house, health, tip),
    depositsMatured: capacity.deposits > 0 && !house.depositwam,
    deferral: deferralView(house, tip),
    optionClause: optionClauseView(house, health),
    insolvent: health.badge === 'insolvent',
    failure: houseFailure(house, tip),
    partnersActive: (house.partners || []).filter((partner) => partner.status === 'active').length,
    partners: (house.partners || []).map((partner) => ({
      partner,
      pledgeGrams: ecxToGrams(partner.pledge, capacity.gramsPerUnit),
      statusText: partnerStatusText(partner, tip),
    })),
    loanbook,
    loanRows: bookBills.map((bill) => ({
      bill,
      maturity: billMaturity(bill, tip),
      holderIsHouse: !!house.redemptiondestpk && bill.holder_pubkey === house.redemptiondestpk,
    })),
    pastBills: (response.bills || []).filter((bill) => !onBook.has(bill.id)),
    pools: (response.pools || []).map((pool) => {
      const spot = poolSpotSatsPerUnit(pool.spot_price_sats_x1e8);
      return { pool, spotSatsPerUnit: spot, parText: spot !== null ? `${formatPercent(spot * 100)} of par` : '' };
    }),
  };
}

function toActivity(state: CreditLoad<FreebankActivityResponse>, houseId: number, house: FreebankHouse | undefined): HouseActivityView {
  const target = house || { id: houseId, txidregister: '' };
  const items = (state.data?.items || []).filter((item) => activityNamesHouse(item, target));
  const discounts: { [billId: number]: FreebankActivityItem } = {};
  let lastAttest: FreebankActivityItem | null = null;
  let close: FreebankActivityItem | null = null;
  for (const item of items) {
    if (!close && item.family === 'house' && item.op_name === 'close') {
      close = item;
    }
    const decoded: FreebankDecodedPayload = item.decoded || {};
    if (item.family === 'bill' && item.op_name === 'discount' && typeof decoded.bill_id === 'number' && !discounts[decoded.bill_id]) {
      discounts[decoded.bill_id] = item;
    }
    if (house && !lastAttest && item.family === 'house' && item.op_name === 'attest' && item.height === house.lastattestheight) {
      lastAttest = item;
    }
  }
  return {
    loading: state.loading && !state.data,
    error: state.data ? undefined : state.error,
    rows: items.map((item) => ({
      item,
      familyLabel: CREDIT_FAMILIES[item.family]?.label || item.family,
      detail: describeActivity(item, houseId),
    })),
    scannedFrom: state.data ? state.data.scanned_from_height : null,
    discounts,
    lastAttest,
    close,
  };
}

// /house/:id - one house: its health and attestations, what it may still issue, its partners,
// the bills on its loan book, its pool, and the credit transactions that name it.
@Component({
  selector: 'app-house-detail',
  templateUrl: './house-detail.component.html',
  styleUrls: ['../house-common/house-common.scss', './house-detail.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseDetailComponent implements OnInit {
  goldShown = GOLD_SHOWN; // FreeBank: gold views on or off (gold-display.ts)
  houseTypeLabels = HOUSE_TYPE_LABELS; // v0.2.19 house types
  houseTypeTooltips = HOUSE_TYPE_TOOLTIPS;
  hasMembers = houseHasMembers;
  houseId: number;
  idText: string;                 // the id as typed in the URL, for the header and the not-found line
  view$: Observable<HouseDetailView>;
  activityLimit = ACTIVITY_LIMIT;
  skeletonLines = [1, 2, 3, 4, 5];

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // set before the first render: the tap below runs inside the first change detection pass
    this.houseId = parseInt(this.route.snapshot.paramMap.get('id'), 10);
    this.idText = this.route.snapshot.paramMap.get('id') || '';
    this.websocketService.want(['blocks']);

    // chain-wide, so it stays loaded when the page moves to another house
    const activity$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$(undefined, ACTIVITY_LIMIT));

    const house$ = this.route.paramMap.pipe(
      tap((params) => {
        this.houseId = parseInt(params.get('id'), 10);
        this.idText = params.get('id') || '';
        this.seoService.setTitle(`House ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank house ${params.get('id')}: its health, attested reserves, notes issued, partners, loan book and pool.`);
      }),
      switchMap(() => {
        const houseId = this.houseId;
        let titled = false;
        return loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouse$(houseId)).pipe(
          tap((state) => {
            if (!titled && state.data?.house) {
              titled = true;
              this.seoService.setTitle(`House ${state.data.house.classid} (${houseId})`);
            }
          }),
          map((state) => ({ houseId, state })),
        );
      }),
    );

    this.view$ = combineLatest([house$, activity$]).pipe(
      map(([{ houseId, state }, activity]): HouseDetailView => {
        const data = state.data ? toData(state.data) : undefined;
        return {
          loading: state.loading && !data,
          refreshing: state.loading && !!data,
          error: state.error,
          // 400 is a malformed id (/house/abc), 404 an id the chain does not know
          notFound: state.error?.status === 404 || state.error?.status === 400,
          data,
          activity: toActivity(activity, houseId, data?.house),
        };
      }),
    );
  }

  /** The discount price as a share of face: 90,000,000 units for a 1 ECX bill -> '90%'. */
  discountShare(priceUnits: number, faceEcx: number): string {
    if (typeof priceUnits !== 'number' || typeof faceEcx !== 'number' || faceEcx <= 0) {
      return '';
    }
    return formatPercent((priceUnits / (faceEcx * SATS_PER_ECX)) * 100);
  }

  trackByIndex(index: number): number {
    return index;
  }

  trackByBill(index: number, row: HouseLoanRow): number {
    return row.bill.id;
  }

  trackByTxid(index: number, row: HouseActivityRow): string {
    return row.item.txid;
  }
}
