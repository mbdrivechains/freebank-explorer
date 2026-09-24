import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankHouse, FreebankPool } from '@interfaces/freebank-credit.interface';
import { houseHealth } from '@app/freebank/house-health';
import { PoolPrice, poolPrice } from '@app/freebank/pages/pool-list/pool-view';

/** GET /pools plus GET /houses (for each pool's house badge and note class). */
interface PoolListData {
  tip_height: number;
  pools: FreebankPool[];
  houses: FreebankHouse[];        // empty when /houses failed: the page then shows no badges
}

interface PoolRow {
  pool: FreebankPool;
  house: FreebankHouse | null;
  noteLabel: string;              // 'hone notes', or 'note units' before the house is known
  price: PoolPrice;
  parCaveat: string;              // why par does not apply to this house's notes right now; '' if it does
}

interface PoolListView {
  loading: boolean;
  error: HttpErrorResponse | null;
  tipHeight: number;
  rows: PoolRow[] | null;         // null until the first response
}

// /pools - every pool of a house's notes against ECX.
@Component({
  selector: 'app-pool-list',
  templateUrl: './pool-list.component.html',
  styleUrls: ['../bills-pools.scss', './pool-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolListComponent implements OnInit {
  view$: Observable<PoolListView>;
  skeletonRows = [1, 2, 3];

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Pools');
    this.seoService.setDescription('FreeBank pools: each house\'s notes traded against ECX, with reserves, fee and price.');
    this.websocketService.want(['blocks']);

    this.view$ = loadOnEachBlock(this.stateService, () => forkJoin({
      pools: this.apiService.getFreebankPools$(),
      houses: this.apiService.getFreebankHouses$().pipe(catchError(() => of(null))),
    }).pipe(
      map(({ pools, houses }): PoolListData => ({
        tip_height: pools.tip_height,
        pools: pools.pools || [],
        houses: houses?.houses || [],
      })),
    )).pipe(
      map((state): PoolListView => ({
        loading: state.loading,
        error: state.error || null,
        tipHeight: state.data ? state.data.tip_height : this.stateService.latestBlockHeight,
        rows: state.data ? this.buildRows(state.data) : null,
      })),
    );
  }

  private buildRows(data: PoolListData): PoolRow[] {
    const houses = new Map<number, FreebankHouse>();
    for (const house of data.houses) {
      houses.set(house.id, house);
    }
    return [...data.pools]
      .sort((a, b) => a.pool_id - b.pool_id)
      .map((pool) => {
        const house = houses.get(pool.house_id) || null;
        const health = house ? houseHealth(house, data.tip_height) : null;
        let parCaveat = '';
        if (health?.notesImpaired) {
          parCaveat = 'house insolvent: notes are claims, not par';
        } else if (health && !health.notesAtPar) {
          parCaveat = 'house not redeeming at par now';
        }
        return {
          pool,
          house,
          noteLabel: house?.classid ? `${house.classid} notes` : 'note units',
          price: poolPrice(pool),
          parCaveat,
        };
      });
  }

  trackByPool(index: number, row: PoolRow): number {
    return row.pool.pool_id;
  }
}
