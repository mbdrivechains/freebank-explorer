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
import { SATS_PER_ECX, formatBlockCount, formatBlocksFromTip, poolSpotSatsPerUnit } from '@app/freebank/credit-units';
import {
  ActivityDetail, AttestationClock, BillMaturity, HouseCapacity, activityNamesHouse, attestationClock, billMaturity,
  describeActivity, ecxToGrams, formatPercent, houseCapacity, houseStatusLabel, houseTierLabel, unitsToGrams,
} from '@app/freebank/pages/house-common/house-view';

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
  deferral: HouseDeferral;
  insolvent: boolean;
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
  if (house.defer_invoked_height) {
    const end = house.defer_end_height
      ? ` The window ends at block ${house.defer_end_height} (${formatBlocksFromTip(house.defer_end_height, tip)}); without a recovery by then the house is insolvent.`
      : '';
    const renewals = house.defer_renewals ? ` Renewed ${house.defer_renewals} ${house.defer_renewals === 1 ? 'time' : 'times'}.` : '';
    return { state: 'active', text: `Invoked at block ${house.defer_invoked_height}: redemptions are deferred.${end}${renewals}` };
  }
  if (house.defer_activations > 0) {
    const ended = house.defer_ended_height ? `; the last one ended at block ${house.defer_ended_height}` : '';
    const blocks = house.defer_suspended_blocks ? `, ${formatBlockCount(house.defer_suspended_blocks)} deferred in all` : '';
    return {
      state: 'past',
      text: `Not in force. Invoked ${house.defer_activations} ${house.defer_activations === 1 ? 'time' : 'times'}${ended}${blocks}.`,
    };
  }
  return { state: 'never', text: 'Never invoked' };
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
    statusLabel: houseStatusLabel(effective),
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
    deferral: deferralView(house, tip),
    insolvent: health.badge === 'insolvent',
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
  for (const item of items) {
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
  houseId: number;
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
    this.websocketService.want(['blocks']);

    // chain-wide, so it stays loaded when the page moves to another house
    const activity$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$(undefined, ACTIVITY_LIMIT));

    const house$ = this.route.paramMap.pipe(
      tap((params) => {
        this.houseId = parseInt(params.get('id'), 10);
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
          notFound: state.error?.status === 404,
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
