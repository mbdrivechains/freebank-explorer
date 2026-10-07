import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Observable, catchError, combineLatest, map, of, switchMap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankActivityItem, FreebankHouse, FreebankHouseTokensResponse } from '@interfaces/freebank-credit.interface';

interface PostingTotals {
  posts: number;
  issuedUnits: number;
  spentTokens: number;
}

interface TokensView {
  loading: boolean;
  error: HttpErrorResponse | null;
  data: FreebankHouseTokensResponse | null;
  posting: PostingTotals | null;     // from the house's recent activity (token_post records)
  failed: boolean;                   // the house has failed: the claim window applies
  windowOpen: boolean;
}

// The house's Chaumian tokens (v0.2.20 records, v0.2.21 claims; D-2026-10-08-1): its mint keysets, what the mint posted
// as issued and as spent (spent tokens carry no amount, so the two do not net out), and, once the house has failed,
// the token holders' claim window, its totals and the claims (paged by Y). Hidden while the house has no keyset, no
// tokens and no claims.
@Component({
  selector: 'app-house-tokens',
  templateUrl: './house-tokens.component.html',
  styleUrls: ['../bills-pools.scss', './house-tokens.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseTokensComponent implements OnChanges {
  @Input() house: FreebankHouse;
  view$: Observable<TokensView> | null = null;
  starts: string[] = [''];
  private start$ = new BehaviorSubject<string>('');
  private houseId: number | null = null;

  constructor(private apiService: ApiService, private stateService: StateService) { }

  ngOnChanges(): void {
    if (!this.house || this.house.id === this.houseId) {
      return; // the same house: keep the streams (they reload on each block)
    }
    const id = this.houseId = this.house.id;
    this.starts = [''];
    this.start$ = new BehaviorSubject<string>('');
    // the mint's posts among this house's newest 200 note txs
    const posting$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$('note', 200, id)).pipe(
      map((state) => state.data ? postingTotals(state.data.items || [], id) : null),
      catchError(() => of(null)),
    );
    const tokens$ = this.start$.pipe(
      switchMap((start) => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouseTokens$(id, start, 100))),
    );
    this.view$ = combineLatest([tokens$, posting$]).pipe(
      map(([state, posting]): TokensView => {
        const d = state.data || null;
        return {
          loading: state.loading,
          error: !d && state.error ? state.error : null,
          data: d,
          posting,
          failed: !!d && d.insolventsince > 0,
          windowOpen: !!d && d.insolventsince > 0 && d.tip_height < d.windowend,
        };
      }),
    );
  }

  show(view: TokensView): boolean {
    const d = view.data;
    return !!d && (d.keysets.length > 0 || d.claims > 0 || (this.house?.tokenunits || 0) > 0);
  }

  nextPage(next: string): void {
    this.starts.push(next);
    this.start$.next(next);
  }

  previousPage(): void {
    if (this.starts.length > 1) {
      this.starts.pop();
      this.start$.next(this.starts[this.starts.length - 1]);
    }
  }

  keyRange(keys: { amount: number }[]): string {
    if (!keys?.length) {
      return 'no keys';
    }
    const amounts = keys.map((k) => k.amount);
    return `${keys.length} key${keys.length === 1 ? '' : 's'}, amounts ${Math.min(...amounts).toLocaleString('en-US')} to ${Math.max(...amounts).toLocaleString('en-US')}`;
  }
}

function postingTotals(items: FreebankActivityItem[], houseId: number): PostingTotals | null {
  const posts = items.filter((i) => i.family === 'note' && i.op_name === 'token_post' && i.decoded?.house_id === houseId);
  if (!posts.length) {
    return null;
  }
  return {
    posts: posts.length,
    issuedUnits: posts.reduce((s, i) => s + (Number(i.decoded?.issued_units) || 0), 0),
    spentTokens: posts.reduce((s, i) => s + (Number(i.decoded?.spent) || 0), 0),
  };
}
