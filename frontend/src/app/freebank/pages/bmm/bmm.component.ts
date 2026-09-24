import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, Observable, Subject, combineLatest, distinctUntilChanged, expand, map, merge, switchMap, timer } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import {
  BmmPaging, BmmRow, bmmPaging, bmmRow, ecashExplorerHost, ecashExplorerUrl, formatBidSats, formatShare, parseBmmBefore,
} from '@app/freebank/bmm-view';
import { FreebankBmmBlock, FreebankBmmListResponse, FreebankBmmSummaryResponse } from '@interfaces/freebank-bmm.interface';

// /bmm - which eCash block carried each FreeBank block, the pool that mined it and the bid paid.
// Summary cards and pool shares from GET /bmm/summary, then the blocks from GET /bmm, paged with
// ?before=<height>. Like the /credit filters, Older/Newer rewrite the URL in place
// (Location.replaceState) so the page does not jump back to the top on every click.
//
// The backend looks blocks up on the eCash explorer one request at a time, so right after a
// start many rows are still pending: while any are, the page asks our API again every
// REFRESH_MS as well as on each new block.

const PAGE_SIZE = 25;
const REFRESH_MS = 15000;

interface SummaryView {
  load: CreditLoad<{ tip_height: number; summary: FreebankBmmSummaryResponse }>;
  summary: FreebankBmmSummaryResponse | null;
  lastEcashUrl: string | null;
  pools: { name: string; url: string | null; blocks: number; share: number; shareText: string }[];
  totalBidText: string;
  avgBidText: string;
  medianBidText: string;
}

interface BlocksView {
  before: number | null;
  load: CreditLoad<FreebankBmmListResponse>;
  rows: BmmRow[];
  paging: BmmPaging | null;
}

interface PageView {
  disabled: boolean;              // the backend says the BMM view is off: the page shows one line
  explorerHost: string;           // 'explorer.beta.ecash.ninja', for the note under the table
  summary: SummaryView;
  blocks: BlocksView;
}

@Component({
  selector: 'app-bmm',
  templateUrl: './bmm.component.html',
  styleUrls: ['../bills-pools.scss', './bmm.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BmmComponent implements OnInit {
  view$: Observable<PageView>;

  readonly skeletonTiles = [1, 2, 3, 4];
  readonly skeletonRows = Array.from({ length: 10 }, (_, i) => i);

  private pageClick$ = new Subject<number | null>();

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
    private route: ActivatedRoute,
    private router: Router,
    private location: Location,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('BMM');
    this.seoService.setDescription('The eCash blocks that carried FreeBank: for each FreeBank block, the eCash block that committed it, the pool that mined it and the bid paid.');
    this.websocketService.want(['blocks']);

    // The summary carries no tip_height; the tip the browser knew when it answered stands in for it.
    const summary$ = loadOnEachBlock(this.stateService, () => repeatWhileWaiting(
      () => this.apiService.getFreebankBmmSummary$().pipe(
        map((summary) => ({ tip_height: this.stateService.latestBlockHeight, summary })),
      ),
      (data) => data.summary.enabled && data.summary.pending > 0,
    )).pipe(
      map((load): SummaryView => {
        const summary = load.data?.summary || null;
        const base = summary?.explorer_url || '';
        const last = summary?.last;
        return {
          load,
          summary,
          lastEcashUrl: last && typeof last.ecash_height === 'number' && last.ecash_height === summary.latest_ecash_height
            ? ecashExplorerUrl(base, 'block', last.ecash_hash) : null,
          pools: (summary?.pools || []).map((pool) => ({
            name: pool.name || pool.slug || 'Unknown',
            url: pool.slug ? ecashExplorerUrl(base, 'mining/pool', pool.slug) : null,
            blocks: pool.blocks,
            share: Math.max(0, Math.min(1, pool.share || 0)),
            shareText: formatShare(pool.share),
          })),
          totalBidText: formatBidSats(summary?.total_bid_sats ?? null),
          avgBidText: summary?.avg_bid_sats ? formatBidSats(Math.round(summary.avg_bid_sats)) : '',
          medianBidText: summary?.median_bid_sats ? formatBidSats(Math.round(summary.median_bid_sats)) : '',
        };
      }),
    );

    const blocks$ = merge(
      this.route.queryParamMap.pipe(map((params) => parseBmmBefore(params.get('before')))),
      this.pageClick$,
    ).pipe(
      distinctUntilChanged(),
      switchMap((before) => loadOnEachBlock(this.stateService, () => repeatWhileWaiting(
        () => this.apiService.getFreebankBmm$(PAGE_SIZE + 1, before ?? undefined),
        (list) => list.enabled && (list.items || []).some((item) => item.status === 'pending' || item.status === 'error'),
      )).pipe(
        map((load): BlocksView => {
          const list = load.data;
          // PAGE_SIZE + 1 were asked for: a full answer means there are older blocks
          const received = list?.items || [];
          const shown: FreebankBmmBlock[] = received.slice(0, PAGE_SIZE);
          return {
            before,
            load,
            rows: shown.map((item) => bmmRow(item, list.explorer_url)),
            paging: list ? bmmPaging(shown, received.length, PAGE_SIZE, before, list.tip_height) : null,
          };
        }),
      )),
    );

    // both emit at once (a loading state first), so neither waits for the other
    this.view$ = combineLatest([summary$, blocks$]).pipe(
      map(([summary, blocks]): PageView => {
        const list = blocks.load.data;
        const disabled = (!!summary.summary && !summary.summary.enabled) || (!!list && !list.enabled);
        return {
          disabled,
          explorerHost: disabled ? '' : ecashExplorerHost(summary.summary?.explorer_url || list?.explorer_url || ''),
          summary,
          blocks,
        };
      }),
    );
  }

  goToPage(before: number | null): void {
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: before === null ? {} : { before },
    });
    this.location.replaceState(this.router.serializeUrl(tree));
    this.pageClick$.next(before);
  }

  trackByHash(index: number, row: BmmRow): string {
    return row.item.freebank_hash;
  }
}

/** request() now, then again every REFRESH_MS for as long as waiting(answer) holds. */
function repeatWhileWaiting<T>(request: () => Observable<T>, waiting: (answer: T) => boolean): Observable<T> {
  return request().pipe(
    expand((answer) => waiting(answer) ? timer(REFRESH_MS).pipe(switchMap(() => request())) : EMPTY),
  );
}
