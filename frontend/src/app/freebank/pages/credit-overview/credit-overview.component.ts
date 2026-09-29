import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { Observable, Subject, distinctUntilChanged, filter, map, merge, shareReplay, switchMap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { CREDIT_FAMILY_FILTERS, CreditActivityRow, creditActivityRow, parseCreditFamily } from '@app/freebank/credit-activity-summary';
import { CreditBadgeCount, creditBadgeCounts, creditBadgeCountsText } from '@app/freebank/credit-summary-view';
import { formatGoldFixPrice } from '@app/freebank/gold-fix-format';
import { FreebankActivityResponse, FreebankSummaryResponse, FreebankTxFamily } from '@interfaces/freebank-credit.interface';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

// /credit - the credit layer at a glance: summary tiles from GET /summary, then the recent credit
// txs from GET /activity with a family filter (?family=bill). The filter buttons rewrite the URL
// in place (Location.replaceState) instead of navigating, because a router navigation would
// scroll the page back to the top (scrollPositionRestoration) every time a filter is clicked.
// The router does not see that rewrite, so a later link to /credit (the nav icon, the footer)
// navigates without changing queryParamMap; the page reads ?family= again after each navigation.

const ACTIVITY_LIMIT = 50;

interface SummaryView {
  load: CreditLoad<FreebankSummaryResponse>;
  badges: CreditBadgeCount[];
  badgesText: string;
  goldFixPrice: string;           // '800 g per ECX', '' before the first fix
  goldFixAge: number | null;      // blocks since the fix formed
}

interface ActivityView {
  family: FreebankTxFamily | null;
  load: CreditLoad<FreebankActivityResponse>;
  rows: CreditActivityRow[];
}

@Component({
  selector: 'app-credit-overview',
  templateUrl: './credit-overview.component.html',
  styleUrls: ['./credit-overview.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditOverviewComponent implements OnInit {
  goldShown = GOLD_SHOWN; // FreeBank: gold views on or off (gold-display.ts)
  summary$: Observable<SummaryView>;
  activity$: Observable<ActivityView>;

  readonly families = CREDIT_FAMILY_FILTERS;
  readonly activityLimit = ACTIVITY_LIMIT;
  readonly skeletonRows = [1, 2, 3, 4, 5, 6, 7, 8];
  readonly skeletonTiles = [1, 2, 3, 4, 5, 6];

  private familyClick$ = new Subject<FreebankTxFamily | null>();

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
    this.seoService.setTitle('Credit');
    this.seoService.setDescription('The FreeBank credit layer: discount houses and their notes, bills of exchange, term deposits, pools, settlements and the gold fix.');
    this.websocketService.want(['blocks']);

    this.summary$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankSummary$()).pipe(
      map((load): SummaryView => {
        const summary = load.data;
        const fix = summary?.gold_fix;
        const badges = creditBadgeCounts(summary?.houses_by_badge);
        let goldFixAge: number | null = null;
        if (fix) {
          goldFixAge = typeof fix.ageblocks === 'number' ? fix.ageblocks : Math.max(0, summary.tip_height - fix.fixheight);
        }
        return {
          load,
          badges,
          badgesText: creditBadgeCountsText(badges),
          goldFixPrice: fix ? formatGoldFixPrice(fix.raw) : '',
          goldFixAge,
        };
      }),
      shareReplay({ bufferSize: 1, refCount: true }), // the intro line and the tiles share one request
    );

    this.activity$ = merge(
      this.route.queryParamMap.pipe(map((params) => parseCreditFamily(params.get('family')))),
      this.router.events.pipe(
        filter((event) => event instanceof NavigationEnd),
        map(() => parseCreditFamily(this.route.snapshot.queryParamMap.get('family'))),
      ),
      this.familyClick$,
    ).pipe(
      distinctUntilChanged(),
      switchMap((family) => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$(family || undefined, ACTIVITY_LIMIT)).pipe(
        map((load): ActivityView => ({
          family,
          load,
          rows: (load.data?.items || []).map((item) => creditActivityRow(item)),
        })),
      )),
    );
  }

  setFamily(family: FreebankTxFamily | null): void {
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: family ? { family } : {},
    });
    this.location.replaceState(this.router.serializeUrl(tree));
    this.familyClick$.next(family);
  }

  trackByTxid(index: number, row: CreditActivityRow): string {
    return row.item.txid;
  }
}
