import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable, combineLatest, map } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { ecashExplorerHost } from '@app/freebank/bmm-view';
import { FreebankPegService } from '@app/freebank/peg.service';
import {
  PegLine, PegTableRow, bundleLine, bundleTableRow, depositTableRow, formatPegAmount, treasuryLine, withdrawalTableRow,
} from '@app/freebank/peg-view';
import { PegBundle, PegDeposit, PegList, PegSummary, PegWithdrawal } from '@interfaces/freebank-peg.interface';

// /peg - FreeBank's peg with eCash: what the eCash treasury holds for FreeBank, the deposits from
// eCash, the withdrawals to eCash and the withdrawal bundles, newest first. The summary and the
// three lists come from /api/v1/freebank/peg/summary and pegs?type=, loaded again on each new
// block. eCash txs link to the eCash explorer the API names (explorer_url).

const LIST_SIZE = 25;

interface ListView {
  load: CreditLoad<PegList>;
  rows: PegTableRow[];
  total: number;
}

interface PageView {
  summary: CreditLoad<PegSummary>;
  treasury: PegLine | null;
  currentBundle: PegLine | null;
  depositsText: string;
  explorerHost: string;
  deposits: ListView;
  withdrawals: ListView;
  bundles: ListView;
}

@Component({
  selector: 'app-peg',
  templateUrl: './peg.component.html',
  styleUrls: ['../bills-pools.scss', './peg.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PegComponent implements OnInit {
  view$: Observable<PageView>;

  readonly skeletonTiles = [1, 2, 3, 4];
  readonly skeletonRows = [1, 2, 3];

  constructor(
    private pegService: FreebankPegService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('eCash ⇄ FreeBank');
    this.seoService.setDescription('FreeBank\'s peg with eCash: what the eCash treasury holds for FreeBank, deposits from eCash, withdrawals to eCash and withdrawal bundles.');
    this.websocketService.want(['blocks']);

    const summary$ = loadOnEachBlock(this.stateService, () => this.pegService.summary$());
    const list$ = (type: 'deposit' | 'withdrawal' | 'bundle', row: (item: any, base: string) => PegTableRow): Observable<ListView> =>
      loadOnEachBlock(this.stateService, () => this.pegService.list$(type, LIST_SIZE)).pipe(
        map((load) => ({
          load,
          rows: (load.data?.items || []).map((item) => row(item, load.data.explorer_url)),
          total: load.data?.total ?? 0,
        })),
      );

    this.view$ = combineLatest([
      summary$,
      list$('deposit', (d: PegDeposit, base) => depositTableRow(d, base)),
      list$('withdrawal', (w: PegWithdrawal, base) => withdrawalTableRow(w, base)),
      list$('bundle', (b: PegBundle, base) => bundleTableRow(b, base)),
    ]).pipe(
      map(([summary, deposits, withdrawals, bundles]): PageView => {
        const s = summary.data;
        const base = s?.explorer_url || '';
        return {
          summary,
          treasury: s ? treasuryLine(s.treasury, base) : null,
          currentBundle: s?.current_bundle ? bundleLine(s.current_bundle, base, false) : null,
          depositsText: s ? formatPegAmount(s.deposits_amount) : '',
          explorerHost: ecashExplorerHost(base),
          deposits,
          withdrawals,
          bundles,
        };
      }),
    );
  }

  trackByKey(index: number, row: PegTableRow): string {
    return row.key;
  }
}
