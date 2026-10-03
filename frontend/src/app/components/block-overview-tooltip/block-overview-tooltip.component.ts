import { Component, ElementRef, ViewChild, Input, OnChanges, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, map, switchMap } from 'rxjs/operators';
import { Position } from '@components/block-overview-graph/sprite-types.js';
import { Price } from '@app/services/price.service';
import { TransactionStripped } from '@interfaces/node-api.interface.js';
import { Filter, FilterMode, TransactionFlags, toFilters } from '@app/shared/filters.utils';
import { Block } from '@interfaces/electrs.interface.js';
import { CacheService } from '@app/services/cache.service';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { getCreditTxLabel } from '@app/shared/transaction.utils';
import { ASSET_GENESIS_VERSION, FREEBANK_TX_FLAGS, creditVersionFromFlags } from '@app/freebank/freebank-tx-flags';

// FreeBank: the stripped txs behind the block overview carry no tx version. The credit type badge
// comes from the family bit in the tx's flags; only when a tx has no flags does it come from the
// tx list cache or from the version bytes of the raw tx (first 4, little endian), one request per
// tx. Fetched results are kept per txid for the session.
const creditLabelByTxid = new Map<string, string | null>();

@Component({
  selector: 'app-block-overview-tooltip',
  templateUrl: './block-overview-tooltip.component.html',
  styleUrls: ['./block-overview-tooltip.component.scss'],
  standalone: false,
})
export class BlockOverviewTooltipComponent implements OnChanges, OnDestroy {
  @Input() tx: TransactionStripped | void;
  @Input() relativeTime?: number;
  @Input() cursorPosition: Position;
  @Input() clickable: boolean;
  @Input() auditEnabled: boolean = false;
  @Input() blockConversion: Price;
  @Input() filterFlags: bigint | null = null;
  @Input() filterMode: FilterMode = 'and';

  txid = '';
  time: number = 0;
  fee = 0;
  value = 0;
  vsize = 1;
  feeRate = 0;
  effectiveRate;
  acceleration;
  hasEffectiveRate: boolean = false;
  timeMode: 'mempool' | 'mined' | 'missed' | 'after' = 'mempool';
  filters: Filter[] = [];
  activeFilters: { [key: string]: boolean } = {};
  creditLabel: string | null = null;
  creditLookup$ = new Subject<string>();
  creditLookupSubscription: Subscription;

  tooltipPosition: Position = { x: 0, y: 0 };

  @ViewChild('tooltip') tooltipElement: ElementRef<HTMLCanvasElement>;

  constructor(
    private cd: ChangeDetectorRef,
    private cacheService: CacheService,
    private electrsApiService: ElectrsApiService,
  ) {
    this.creditLookupSubscription = this.creditLookup$.pipe(
      debounceTime(100),
      switchMap((txid) => this.electrsApiService.getTransactionHex$(txid).pipe(
        map((hex) => {
          const version = parseInt(hex.slice(0, 8).match(/../g).reverse().join(''), 16);
          return { txid, label: getCreditTxLabel({ version }) ?? null };
        }),
        catchError(() => of(null)),
      )),
    ).subscribe((result) => {
      if (!result) {
        return;
      }
      creditLabelByTxid.set(result.txid, result.label);
      if (result.txid === this.txid) {
        this.creditLabel = result.label;
        this.cd.markForCheck();
      }
    });
  }

  ngOnChanges(changes): void {
    if (changes.cursorPosition && changes.cursorPosition.currentValue) {
      let x = changes.cursorPosition.currentValue.x + 10;
      let y = changes.cursorPosition.currentValue.y + 10;
      if (this.tooltipElement) {
        const elementBounds = this.tooltipElement.nativeElement.getBoundingClientRect();
        const parentBounds = this.tooltipElement.nativeElement.offsetParent.getBoundingClientRect();
        if ((parentBounds.left + x + elementBounds.width) > parentBounds.right) {
          x = Math.max(0, parentBounds.width - elementBounds.width - 10);
        }
        if (y + elementBounds.height > parentBounds.height) {
          y = y - elementBounds.height - 20;
        }
      }
      this.tooltipPosition = { x, y };
    }

    if (this.tx && (changes.tx || changes.filterFlags || changes.filterMode)) {
      if (changes.tx && this.tx.txid !== this.txid) {
        this.creditLabel = this.getCreditLabel(this.tx);
      }
      this.txid = this.tx.txid || '';
      this.time = this.tx.time || 0;
      this.fee = this.tx.fee || 0;
      this.value = this.tx.value || 0;
      this.vsize = this.tx.vsize || 1;
      this.feeRate = this.fee / this.vsize;
      this.effectiveRate = this.tx.rate;
      const txFlags = BigInt(this.tx.flags) || 0n;
      this.acceleration = this.tx.acc || (txFlags & TransactionFlags.acceleration);
      this.hasEffectiveRate = this.tx.acc || !(Math.abs((this.fee / this.vsize) - this.effectiveRate) <= 0.1 && Math.abs((this.fee / Math.ceil(this.vsize)) - this.effectiveRate) <= 0.1)
        || (txFlags && (txFlags & (TransactionFlags.cpfp_child | TransactionFlags.cpfp_parent)) > 0n);
      this.filters = this.tx.flags ? toFilters(txFlags).filter(f => f.tooltip) : [];
      this.activeFilters = {};
      for (const filter of this.filters) {
        if (this.filterFlags && (this.filterFlags & BigInt(filter.flag))) {
          this.activeFilters[filter.key] = true;
        }
      }

      if (!this.relativeTime) {
        this.timeMode = 'mempool';
      } else {
        if (this.tx?.context === 'actual' || this.tx?.status === 'found') {
          this.timeMode = 'mined';
        } else {
          const time = this.relativeTime || Date.now();
          if (this.time <= time) {
            this.timeMode = 'missed';
          } else {
            this.timeMode = 'after';
          }
        }
      }

      this.cd.markForCheck();
    }
  }

  getTooltipLeftPosition(): string {
    return window.innerWidth < 392 ? '-50px' : this.tooltipPosition.x + 'px';
  }

  getCreditLabel(tx: TransactionStripped): string | null {
    const txid = tx?.txid;
    if (!txid) {
      return null;
    }
    if (tx.flags) {
      const flags = BigInt(tx.flags);
      const version = flags & FREEBANK_TX_FLAGS.asset_created ? ASSET_GENESIS_VERSION : creditVersionFromFlags(flags);
      return getCreditTxLabel({ version }) ?? null;
    }
    if (creditLabelByTxid.has(txid)) {
      return creditLabelByTxid.get(txid);
    }
    const cachedTx = this.cacheService.getTxFromCache(txid);
    if (cachedTx) {
      return getCreditTxLabel(cachedTx) ?? null;
    }
    this.creditLookup$.next(txid);
    return null;
  }

  ngOnDestroy(): void {
    this.creditLookupSubscription?.unsubscribe();
  }
}
