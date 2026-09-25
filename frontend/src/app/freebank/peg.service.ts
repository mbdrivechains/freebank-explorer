import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, catchError, distinctUntilChanged, of, shareReplay, startWith, switchMap, throwError } from 'rxjs';
import { StateService } from '@app/services/state.service';
import {
  PegBlockView, PegEcashTxView, PegList, PegListType, PegSummary, PegTxView, PegWithdrawalView,
} from '@interfaces/freebank-peg.interface';

// FreeBank's peg with eCash: /api/v1/freebank/peg*, pegs and withdrawal/:id (the backend's
// api/freebank/peg.routes.ts). The base URL is worked out as ApiService does. A tx's or block's
// answer is shared by every part of a page that asks (the output notes, the withdrawal panel)
// and kept until the next block; a 404 comes back as null.

const CACHE_MAX = 200;

@Injectable({
  providedIn: 'root'
})
export class FreebankPegService {
  private apiBaseUrl = '';
  private apiBasePath = '';
  private cache = new Map<string, Observable<any>>();
  private cacheTip = -1;

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
  ) {
    if (!stateService.isBrowser) { // as ApiService: absolute inside the SSR process
      this.apiBaseUrl = this.stateService.env.NGINX_PROTOCOL + '://' + this.stateService.env.NGINX_HOSTNAME + ':' + this.stateService.env.NGINX_PORT;
    }
    this.stateService.networkChanged$.subscribe((network) => {
      this.apiBasePath = network && network !== this.stateService.env.ROOT_NETWORK ? '/' + network : '';
      this.cache.clear();
    });
  }

  private url(path: string): string {
    return this.apiBaseUrl + this.apiBasePath + '/api/v1/freebank/' + path;
  }

  /** One request per key until the next block; a 404 gives null. */
  private cached<T>(key: string, request: () => Observable<T>): Observable<T | null> {
    const tip = this.stateService.latestBlockHeight;
    if (tip !== this.cacheTip || this.cache.size >= CACHE_MAX) {
      this.cache.clear();
      this.cacheTip = tip;
    }
    let answer = this.cache.get(key) as Observable<T | null> | undefined;
    if (!answer) {
      answer = request().pipe(
        catchError((error: HttpErrorResponse) => {
          if (error?.status === 404) {
            return of(null);
          }
          this.cache.delete(key); // a failure is not kept: the next ask tries again
          return throwError(() => error);
        }),
        shareReplay(1),
      );
      this.cache.set(key, answer);
    }
    return answer;
  }

  /** A tx's peg outputs with their status; null when it has none. */
  tx$(txid: string): Observable<PegTxView | null> {
    return this.cached('tx:' + txid, () => this.httpClient.get<PegTxView>(this.url('peg/tx/' + encodeURIComponent(txid))));
  }

  /**
   * tx$, asked again on each new block while subscribed, since a withdrawal's status moves with
   * the chain (one request per block, shared by the page's parts). A failed request gives null.
   */
  txOnEachBlock$(txid: string): Observable<PegTxView | null> {
    return this.stateService.chainTip$.pipe(
      startWith(this.stateService.latestBlockHeight),
      distinctUntilChanged(),
      switchMap(() => this.tx$(txid).pipe(catchError(() => of(null)))),
    );
  }

  /** A block's peg events. */
  block$(hash: string): Observable<PegBlockView | null> {
    return this.cached('block:' + hash, () => this.httpClient.get<PegBlockView>(this.url('peg/block/' + encodeURIComponent(hash))));
  }

  summary$(): Observable<PegSummary> {
    return this.httpClient.get<PegSummary>(this.url('peg/summary'));
  }

  /** Newest first. limit 1..200 (backend default 25). */
  list$(type: PegListType, limit?: number): Observable<PegList> {
    let params = new HttpParams().set('type', type);
    if (limit) {
      params = params.set('limit', String(limit));
    }
    return this.httpClient.get<PegList>(this.url('pegs'), { params });
  }

  withdrawal$(id: string): Observable<PegWithdrawalView | null> {
    return this.cached('withdrawal:' + id, () => this.httpClient.get<PegWithdrawalView>(this.url('withdrawal/' + encodeURIComponent(id))));
  }

  /** The FreeBank block that recorded an eCash tx (a deposit or a bundle's payment); null when none did. */
  ecashTx$(txid: string): Observable<PegEcashTxView | null> {
    return this.cached('ecash:' + txid, () => this.httpClient.get<PegEcashTxView>(this.url('peg/ecash-tx/' + encodeURIComponent(txid))));
  }
}
