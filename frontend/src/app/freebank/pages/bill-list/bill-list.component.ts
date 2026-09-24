import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Observable, catchError, combineLatest, distinctUntilChanged, forkJoin, map, of } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { loadOnEachBlock } from '@app/freebank/credit-load';
import { billStatusLabel } from '@app/freebank/credit-ops';
import { FreebankBill, FreebankHouse } from '@interfaces/freebank-credit.interface';
import {
  BILL_FILTER_LABELS, BILL_FILTER_ORDER, BILL_STATUS_HELP, BillFilter, BillMaturity, BillStatusKey,
  billMaturity, billStatusKey, escrowPercentOfFace, parseBillFilter,
} from '@app/freebank/pages/bill-list/bill-view';

/** GET /bills plus GET /houses (for the owner house's badge), read at the same block. */
interface BillListData {
  tip_height: number;
  bills: FreebankBill[];
  houses: FreebankHouse[];        // empty when /houses failed: the page then shows no badges
}

interface BillRow {
  bill: FreebankBill;
  key: BillStatusKey;
  statusLabel: string;
  statusHelp: string;
  maturity: BillMaturity;
  ownerHouse: FreebankHouse | null;
  escrowPercent: number | null;
}

interface BillFilterButton {
  key: BillFilter;
  label: string;
  count: number;
}

interface BillListView {
  loading: boolean;
  error: HttpErrorResponse | null;
  tipHeight: number;
  rows: BillRow[] | null;         // null until the first response
  visible: BillRow[];
  filter: BillFilter;
  filterLabel: string;
  filters: BillFilterButton[];
}

// /bills - every bill of exchange, newest first, with a status filter (?status=active|discounted|...).
@Component({
  selector: 'app-bill-list',
  templateUrl: './bill-list.component.html',
  styleUrls: ['../bills-pools.scss', './bill-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BillListComponent implements OnInit {
  view$: Observable<BillListView>;
  skeletonRows = [1, 2, 3, 4, 5];

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Bills');
    this.seoService.setDescription('FreeBank bills of exchange: face value, maturity, endorsements, and which were discounted at a house.');
    this.websocketService.want(['blocks']);

    const load$ = loadOnEachBlock(this.stateService, () => forkJoin({
      bills: this.apiService.getFreebankBills$(),
      houses: this.apiService.getFreebankHouses$().pipe(catchError(() => of(null))),
    }).pipe(
      map(({ bills, houses }): BillListData => ({
        tip_height: bills.tip_height,
        bills: bills.bills || [],
        houses: houses?.houses || [],
      })),
    ));

    const filter$ = this.route.queryParamMap.pipe(
      map((params) => parseBillFilter(params.get('status'))),
      distinctUntilChanged(),
    );

    this.view$ = combineLatest([load$, filter$]).pipe(
      map(([state, filter]): BillListView => {
        const data = state.data;
        const rows = data ? this.buildRows(data) : null;
        const counts: { [key: string]: number } = { all: rows ? rows.length : 0 };
        for (const row of rows || []) {
          counts[row.key] = (counts[row.key] || 0) + 1;
        }
        // Disputed is unreachable in v1: offer it only if a disputed bill exists
        const filters = BILL_FILTER_ORDER
          .filter((key) => key !== 'disputed' || counts[key] > 0 || filter === key)
          .map((key) => ({ key, label: BILL_FILTER_LABELS[key], count: counts[key] || 0 }));
        return {
          loading: state.loading,
          error: state.error || null,
          tipHeight: data ? data.tip_height : this.stateService.latestBlockHeight,
          rows,
          visible: rows ? rows.filter((row) => filter === 'all' || row.key === filter) : [],
          filter,
          filterLabel: BILL_FILTER_LABELS[filter].toLowerCase(),
          filters,
        };
      }),
    );
  }

  private buildRows(data: BillListData): BillRow[] {
    const houses = new Map<number, FreebankHouse>();
    for (const house of data.houses) {
      houses.set(house.id, house);
    }
    return [...data.bills]
      .sort((a, b) => b.id - a.id)
      .map((bill) => {
        const key = billStatusKey(bill);
        return {
          bill,
          key,
          statusLabel: billStatusLabel(bill),
          statusHelp: BILL_STATUS_HELP[key],
          maturity: billMaturity(bill, data.tip_height),
          ownerHouse: bill.owner_house_id ? houses.get(bill.owner_house_id) || null : null,
          escrowPercent: escrowPercentOfFace(bill),
        };
      });
  }

  trackByBill(index: number, row: BillRow): number {
    return row.bill.id;
  }

  filterParams(key: BillFilter): { status: string | null } {
    return { status: key === 'all' ? null : key };
  }
}
