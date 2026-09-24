import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Observable, combineLatest, distinctUntilChanged, map, of, shareReplay, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { billStatusLabel } from '@app/freebank/credit-ops';
import {
  FreebankActivityResponse, FreebankBill, FreebankBillResponse, FreebankHouse, FreebankHouseResponse, FreebankLoanBook,
} from '@interfaces/freebank-credit.interface';
import {
  BILL_STATUS_HELP, BillMaturity, BillStatusKey, billMaturity, billPayee, billStatusKey, escrowPercentOfFace,
} from '@app/freebank/pages/bill-list/bill-view';
import { BILL_ACTIVITY_LIMIT, BillEvent, buildBillHistory, parseOutpoint } from '@app/freebank/pages/bill-detail/bill-history';

interface Outpoint {
  txid: string;
  vout: number;
}

interface BillDetailView {
  loading: boolean;
  error: HttpErrorResponse | null;    // the bill request failed and there is nothing to show
  refreshFailed: boolean;             // the latest refresh failed; the page shows the last good data
  tipHeight: number;
  bill: FreebankBill | null;
  key: BillStatusKey;
  statusLabel: string;
  statusHelp: string;
  maturity: BillMaturity | null;
  escrowPercent: number | null;
  payee: string | null;
  drawerIsAcceptor: boolean;
  bodyBytes: number | null;
  escrowCoin: Outpoint | null;
  titleCoin: Outpoint | null;
  // ownership
  ownerHouse: FreebankHouse | null;   // the house holding the bill, once /house/:id has loaded
  ownerHouseTip: number;
  loanbook: FreebankLoanBook | null;
  holderIsCustodyKey: boolean;        // the holder key is the owner house's custody key
  discount: BillEvent | null;
  discountPercent: number | null;     // how far below face the house paid, in percent
  discountBlocksBeforeMaturity: number | null;
  pastHouseId: number | null;         // a house that bought the bill but no longer holds it
  // history
  events: BillEvent[];
  historyLoading: boolean;
  historyFailed: boolean;
  historyComplete: boolean;
  historyScannedFrom: number | null;
}

// /bill/:id - one bill of exchange: terms, parties, ownership, history and escrow.
@Component({
  selector: 'app-bill-detail',
  templateUrl: './bill-detail.component.html',
  styleUrls: ['../bills-pools.scss', './bill-detail.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BillDetailComponent implements OnInit {
  billId: number;
  idText = '';                        // the id as typed in the URL, for the title and the not-found line
  view$: Observable<BillDetailView>;
  skeletonRows = [1, 2, 3, 4, 5];

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // set before the first render: the tap below runs inside the first change detection pass
    this.idText = this.route.snapshot.paramMap.get('id') || '';
    this.billId = parseInt(this.idText, 10);
    this.websocketService.want(['blocks']);

    const bill$ = this.route.paramMap.pipe(
      tap((params) => {
        this.idText = params.get('id') || '';
        this.billId = parseInt(this.idText, 10);
        this.seoService.setTitle(`Bill ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank bill of exchange ${params.get('id')}: face value, escrow, maturity and endorsements.`);
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankBill$(this.billId))),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    // the owner house (for its badge and loan book), only while a house holds the bill
    const house$: Observable<CreditLoad<FreebankHouseResponse> | null> = bill$.pipe(
      map((state) => state.data?.bill?.owner_house_id || 0),
      distinctUntilChanged(),
      switchMap((houseId) => houseId ? loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouse$(houseId)) : of(null)),
    );

    // every recent bill tx; the page picks out the ones naming this bill
    const activity$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$('bill', BILL_ACTIVITY_LIMIT));

    this.view$ = combineLatest([bill$, house$, activity$]).pipe(
      map(([billState, houseState, activityState]) => this.buildView(billState, houseState, activityState)),
    );
  }

  private buildView(
    billState: CreditLoad<FreebankBillResponse>,
    houseState: CreditLoad<FreebankHouseResponse> | null,
    activityState: CreditLoad<FreebankActivityResponse>,
  ): BillDetailView {
    const bill = billState.data?.bill || null;
    const tipHeight = billState.data ? billState.data.tip_height : this.stateService.latestBlockHeight;
    const key = billStatusKey(bill);
    const houseData = houseState?.data && bill && houseState.data.house?.id === bill.owner_house_id ? houseState.data : null;
    const ownerHouse = houseData ? houseData.house : null;
    const history = bill ? buildBillHistory(bill, activityState.data) : null;
    const discount = history?.discount || null;

    let discountPercent: number | null = null;
    if (discount && discount.priceUnits !== null) {
      const face = discount.faceSats ?? (bill ? Math.round(bill.amount * 100000000) : null);
      if (face) {
        discountPercent = (face - discount.priceUnits) / face * 100;
      }
    }

    return {
      loading: billState.loading,
      error: !bill && billState.error ? billState.error : null,
      refreshFailed: !!bill && !!billState.error,
      tipHeight,
      bill,
      key,
      statusLabel: bill ? billStatusLabel(bill) : '',
      statusHelp: BILL_STATUS_HELP[key],
      maturity: bill ? billMaturity(bill, tipHeight) : null,
      escrowPercent: bill ? escrowPercentOfFace(bill) : null,
      payee: bill ? billPayee(bill) : null,
      drawerIsAcceptor: !!bill && bill.drawer_pubkey === bill.acceptor_pubkey,
      bodyBytes: typeof bill?.encrypted_body === 'string' ? Math.floor(bill.encrypted_body.length / 2) : null,
      escrowCoin: parseOutpoint(bill?.escrow_outpoint),
      titleCoin: parseOutpoint(bill?.title_outpoint),
      ownerHouse,
      ownerHouseTip: houseData ? houseData.tip_height : tipHeight,
      loanbook: houseData?.loanbook || null,
      holderIsCustodyKey: !!ownerHouse && !!bill && ownerHouse.redemptiondestpk === bill.holder_pubkey,
      discount,
      discountPercent,
      discountBlocksBeforeMaturity: discount && discount.height !== null && bill ? bill.maturity_height - discount.height : null,
      pastHouseId: bill && !bill.owner_house_id && discount && discount.houseId ? discount.houseId : null,
      events: history?.events || [],
      historyLoading: activityState.loading && !activityState.data,
      historyFailed: !activityState.data && !!activityState.error,
      historyComplete: history ? history.complete : false,
      historyScannedFrom: history ? history.scannedFromHeight : null,
    };
  }

  trackByEvent(index: number, event: BillEvent): string {
    return (event.txid || '') + ':' + index;
  }
}
