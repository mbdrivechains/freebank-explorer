import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Observable, combineLatest, map, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankActivityResponse, FreebankHouse, FreebankPool, FreebankPoolResponse } from '@interfaces/freebank-credit.interface';
import { houseHealth } from '@app/freebank/house-health';
import { PoolActivityRow, PoolPrice, activityNamesPool, poolActivityRow, poolPrice } from '@app/freebank/pages/pool-list/pool-view';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

/** How many pool txs the page asks /activity for (the backend's maximum). */
const POOL_ACTIVITY_LIMIT = 200;

interface Outpoint {
  txid: string;
  vout: number;
}

interface PoolDetailView {
  loading: boolean;
  error: HttpErrorResponse | null;    // the pool request failed and there is nothing to show
  refreshFailed: boolean;             // the latest refresh failed; the page shows the last good data
  tipHeight: number;
  pool: FreebankPool | null;
  house: FreebankHouse | null;
  noteLabel: string;                  // 'hone notes', or 'note units' without the house
  price: PoolPrice | null;
  notesAtPar: boolean;                // the house redeems its notes at par right now (true until the house loads)
  notesImpaired: boolean;             // the house is insolvent: its notes are claims on its pot
  providerLp: number | null;          // shares held by providers: lp_supply - locked_lp
  lockedPercent: number | null;       // locked_lp as a percent of lp_supply
  unitsPerShare: number | null;       // note units behind one share
  satsPerShare: number | null;        // sats behind one share
  shareOfHouseNotes: number | null;   // note_reserve as a percent of the house's notes outstanding
  totalAtParSats: number | null;      // both sides in sats, counting a note unit at par (1 sat)
  totalGrams: number | null;
  noteCoin: Outpoint | null;
  ecxCoin: Outpoint | null;
  rows: PoolActivityRow[];
  activityLoading: boolean;
  activityFailed: boolean;
  activityComplete: boolean;
  activityScannedFrom: number | null;
}

// /pool/:id - one pool of a house's notes against ECX: reserves, price, fee and liquidity, escrow
// coins, and its recent swaps and liquidity changes.
@Component({
  selector: 'app-pool-detail',
  templateUrl: './pool-detail.component.html',
  styleUrls: ['../bills-pools.scss', './pool-detail.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolDetailComponent implements OnInit {
  goldShown = GOLD_SHOWN; // FreeBank: gold views on or off (gold-display.ts)
  poolId: number;
  idText = '';                        // the id as typed in the URL, for the title and the not-found line
  view$: Observable<PoolDetailView>;
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
    this.poolId = parseInt(this.idText, 10);
    this.websocketService.want(['blocks']);

    const pool$ = this.route.paramMap.pipe(
      tap((params) => {
        this.idText = params.get('id') || '';
        this.poolId = parseInt(this.idText, 10);
        this.seoService.setTitle(`Pool ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank pool ${params.get('id')}: a house's notes against ECX, with reserves, fee and price.`);
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankPool$(this.poolId))),
    );

    // every recent pool tx; the page picks out the ones naming this pool
    const activity$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$('pool', POOL_ACTIVITY_LIMIT));

    this.view$ = combineLatest([pool$, activity$]).pipe(
      map(([poolState, activityState]) => this.buildView(poolState, activityState)),
    );
  }

  private buildView(poolState: CreditLoad<FreebankPoolResponse>, activityState: CreditLoad<FreebankActivityResponse>): PoolDetailView {
    const pool = poolState.data?.pool || null;
    const house = pool && poolState.data.house?.id === pool.house_id ? poolState.data.house : null;
    const tipHeight = poolState.data ? poolState.data.tip_height : this.stateService.latestBlockHeight;
    const poolId = pool ? pool.pool_id : this.poolId;

    const items = activityState.data?.items || [];
    const rows = items.filter((item) => activityNamesPool(item, poolId)).map((item) => poolActivityRow(item));
    const scannedFrom = typeof activityState.data?.scanned_from_height === 'number' ? activityState.data.scanned_from_height : null;
    const oldest = items.length ? Math.min(...items.map((item) => item.height)) : null;
    const truncated = items.length >= POOL_ACTIVITY_LIMIT && oldest !== null && pool !== null && oldest > pool.createheight;

    const health = house ? houseHealth(house, tipHeight) : null;
    const lpSupply = isNumber(pool?.lp_supply) ? pool.lp_supply : null;
    const lockedLp = isNumber(pool?.locked_lp) ? pool.locked_lp : null;

    return {
      loading: poolState.loading,
      error: !pool && poolState.error ? poolState.error : null,
      refreshFailed: !!pool && !!poolState.error,
      tipHeight,
      pool,
      house,
      noteLabel: house?.classid ? `${house.classid} notes` : 'note units',
      price: pool ? poolPrice(pool) : null,
      notesAtPar: health ? health.notesAtPar : true,
      notesImpaired: health ? health.notesImpaired : false,
      providerLp: lpSupply !== null && lockedLp !== null ? Math.max(0, lpSupply - lockedLp) : null,
      lockedPercent: lpSupply && lockedLp !== null ? lockedLp / lpSupply * 100 : null,
      unitsPerShare: pool && lpSupply ? pool.note_reserve / lpSupply : null,
      satsPerShare: pool && lpSupply ? pool.btx_reserve / lpSupply : null,
      shareOfHouseNotes: pool && house && house.mintedunits > 0 ? pool.note_reserve / house.mintedunits * 100 : null,
      totalAtParSats: pool && isNumber(pool.note_reserve) && isNumber(pool.btx_reserve) ? pool.note_reserve + pool.btx_reserve : null,
      totalGrams: pool && isNumber(pool.note_reserve_grams) && isNumber(pool.btx_reserve_grams) ? pool.note_reserve_grams + pool.btx_reserve_grams : null,
      noteCoin: pool?.note_escrow_txid ? { txid: pool.note_escrow_txid, vout: pool.note_escrow_vout } : null,
      ecxCoin: pool?.btx_escrow_txid ? { txid: pool.btx_escrow_txid, vout: pool.btx_escrow_vout } : null,
      rows,
      activityLoading: activityState.loading && !activityState.data,
      activityFailed: !activityState.data && !!activityState.error,
      activityComplete: !!activityState.data && scannedFrom !== null && pool !== null && scannedFrom <= pool.createheight && !truncated,
      activityScannedFrom: scannedFrom,
    };
  }

  trackByRow(index: number, row: PoolActivityRow): string {
    return row.txid;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}
