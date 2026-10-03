import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Observable, map, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { loadOnEachBlock } from '@app/freebank/credit-load';
import { formatAssetUnits } from '@app/freebank/asset-coins';
import { FreebankAssetDetail, FreebankAssetTx } from '@interfaces/freebank-credit.interface';

interface AssetTxRow {
  tx: FreebankAssetTx;
  what: string;                   // 'Created 1,000,000.000', 'Moved 250.000', ...
}

interface AssetDetailView {
  loading: boolean;
  error: HttpErrorResponse | null;
  refreshFailed: boolean;
  tipHeight: number;
  behindBy: number;
  asset: FreebankAssetDetail | null;
  fmt: (units: number) => string;
  rows: AssetTxRow[];
}

const HASH_RE = /^[0-9a-f]{64}$/;

// /asset/:id - one asset: what its creator wrote, its supply, who holds it, where its control coin is, its transfers.
@Component({
  selector: 'app-asset-detail',
  templateUrl: './asset-detail.component.html',
  styleUrls: ['../bills-pools.scss', './asset-detail.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetDetailComponent implements OnInit {
  id = '';
  validId = false;
  view$: Observable<AssetDetailView>;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.id = (this.route.snapshot.paramMap.get('id') || '').toLowerCase();
    this.validId = HASH_RE.test(this.id);
    this.websocketService.want(['blocks']);
    this.view$ = this.route.paramMap.pipe(
      tap((params) => {
        this.id = (params.get('id') || '').toLowerCase();
        this.validId = HASH_RE.test(this.id);
        this.seoService.setTitle(`Asset ${this.id.slice(0, 16)}`);
        this.seoService.setDescription('A FreeBank asset: its supply, holders, control coin and transfers.');
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankAsset$(this.id))),
      map((state): AssetDetailView => {
        const asset = state.data?.asset || null;
        if (asset) {
          this.seoService.setTitle(`Asset ${asset.ticker} (${asset.asset_id.slice(0, 8)})`);
        }
        const fmt = (units: number): string => formatAssetUnits(units, asset?.decimals ?? 0);
        return {
          loading: state.loading,
          error: !asset && state.error ? state.error : null,
          refreshFailed: !!asset && !!state.error,
          tipHeight: state.data ? state.data.tip_height : this.stateService.latestBlockHeight,
          behindBy: state.data?.behind_by || 0,
          asset,
          fmt,
          rows: (asset?.txs || []).map((tx) => ({ tx, what: txWhat(tx, fmt) })),
        };
      }),
    );
  }

  trackByTx(index: number, row: AssetTxRow): string {
    return row.tx.txid;
  }
}

function txWhat(tx: FreebankAssetTx, fmt: (units: number) => string): string {
  if (tx.kind === 'genesis') {
    return `Created ${fmt(tx.units_moved)}`;
  }
  if (tx.kind === 'invalid') {
    return 'Does not fit the asset rule (its outputs are plain ECX)';
  }
  const parts: string[] = [];
  if (tx.units_moved > 0) {
    parts.push(`Moved ${fmt(tx.units_moved)}`);
  }
  if (tx.burned > 0) {
    parts.push(`burned ${fmt(tx.burned)}`);
  }
  if (tx.control_moved) {
    parts.push(parts.length ? 'moved the control coin' : 'Moved the control coin');
  }
  return parts.join(', ');
}
