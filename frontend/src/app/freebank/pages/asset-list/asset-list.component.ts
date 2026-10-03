import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { loadOnEachBlock } from '@app/freebank/credit-load';
import { whileIndexing } from '@app/freebank/peg-retry';
import { formatAssetUnits } from '@app/freebank/asset-coins';
import { FreebankAsset } from '@interfaces/freebank-credit.interface';

interface AssetRow {
  asset: FreebankAsset;
  circulating: string;            // in the asset's display form
  supply: string;
  sameTicker: boolean;            // another asset uses this ticker too
}

interface AssetListView {
  loading: boolean;
  error: HttpErrorResponse | null;
  tipHeight: number;
  behindBy: number;
  rows: AssetRow[] | null;        // null until the first response
}

// /assets - every asset created on FreeBank (v0.2.18, tx v10), oldest first.
@Component({
  selector: 'app-asset-list',
  templateUrl: './asset-list.component.html',
  styleUrls: ['../bills-pools.scss', './asset-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetListComponent implements OnInit {
  view$: Observable<AssetListView>;
  skeletonRows = [1, 2, 3];

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Assets');
    this.seoService.setDescription('FreeBank assets: tokens anyone can create, with their supply, holders and transfers.');
    this.websocketService.want(['blocks']);
    // while the asset index is still reading the chain (after a deploy), ask again every few seconds
    this.view$ = loadOnEachBlock(this.stateService, () => whileIndexing(() => this.apiService.getFreebankAssets$())).pipe(
      map((state): AssetListView => {
        const assets = state.data?.assets || [];
        const tickers = new Map<string, number>();
        for (const a of assets) {
          tickers.set(a.ticker, (tickers.get(a.ticker) || 0) + 1);
        }
        return {
          loading: state.loading,
          error: state.error || null,
          tipHeight: state.data ? state.data.tip_height : this.stateService.latestBlockHeight,
          behindBy: state.data?.behind_by || 0,
          rows: state.data ? assets.map((asset) => ({
            asset,
            circulating: formatAssetUnits(asset.circulating, asset.decimals),
            supply: formatAssetUnits(asset.supply, asset.decimals),
            sameTicker: (tickers.get(asset.ticker) || 0) > 1,
          })) : null,
        };
      }),
    );
  }

  trackByAsset(index: number, row: AssetRow): string {
    return row.asset.asset_id;
  }
}
