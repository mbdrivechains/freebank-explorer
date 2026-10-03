import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import {
  FreebankCustodyResponse, FreebankCustodyTx, getFreebankCustodyLabels, mergeCustodyLabels,
} from '@app/freebank/custody-labels';
import { FreebankAssetCoinsResponse, FreebankAssetTxCoins, assetCoinLabels } from '@app/freebank/asset-coins';

// Custody labels on the transaction lists (freebank/custody-labels.ts): each input and output
// gets `_custody`, the family label at once, then for credit txs (v11-v17, the only ones that
// create or spend a tagged coin) the exact label from GET /api/v1/freebank/custody, at most 25
// txids a request. The base URL is worked out as ApiService does.
//
// A confirmed tx's answer is kept for the session: its coins' numbers only change in a reorg.
// An unconfirmed tx is asked again each time, since a bill or house it creates is numbered when
// it confirms. A failed request leaves the family labels in place.
//
// Asset coins (v0.2.18): every confirmed tx but a coinbase is also looked up in GET /api/v1/freebank/asset-coins (the
// backend's in-memory asset index, at most 50 txids a request) and its inputs and outputs get `_asset` labels. Only
// confirmed txs: a coin's colour is fixed when its tx confirms.

const MAX_TXIDS = 25; // the API's cap
const CACHE_MAX = 2000;
const CREDIT_VERSIONS = [11, 12, 13, 14, 15, 16, 17];
const ASSET_MAX_TXIDS = 50; // the asset-coins API's cap

@Injectable({
  providedIn: 'root'
})
export class FreebankCustodyService {
  private apiBaseUrl = '';
  private apiBasePath = '';
  private cache = new Map<string, FreebankCustodyTx | null>();
  private assetCache = new Map<string, FreebankAssetTxCoins | null>(); // confirmed txs only

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
      this.assetCache.clear();
    });
  }

  /** Sets `_custody` on the tx's inputs and outputs: the exact labels if kept, else the family ones. */
  applyLabels(tx: Transaction): void {
    setLabels(tx, this.cache.get(tx.txid));
    setAssetLabels(tx, this.assetCache.get(tx.txid));
  }

  /**
   * Asks for the exact labels of the credit txs among these that are not kept yet, and sets them.
   * Emits true once they are set, false when there was nothing to ask.
   */
  loadExact$(transactions: Transaction[]): Observable<boolean> {
    const wanted = new Map<string, Transaction[]>();
    for (const tx of transactions || []) {
      if (tx?.txid && CREDIT_VERSIONS.includes(tx.version) && !this.cache.has(tx.txid)) {
        wanted.set(tx.txid, [...(wanted.get(tx.txid) || []), tx]);
      }
    }
    if (!this.stateService.isBrowser) {
      return of(false);
    }
    const assetWanted = new Map<string, Transaction[]>();
    for (const tx of transactions || []) {
      if (tx?.txid && tx.status?.confirmed && !tx.vin?.[0]?.is_coinbase && !this.assetCache.has(tx.txid)) {
        assetWanted.set(tx.txid, [...(assetWanted.get(tx.txid) || []), tx]);
      }
    }
    if (!wanted.size && !assetWanted.size) {
      return of(false);
    }
    return forkJoin([
      wanted.size ? this.loadCustody$(wanted) : of(false),
      assetWanted.size ? this.loadAssets$(assetWanted) : of(false),
    ]).pipe(map(([a, b]) => a || b));
  }

  private loadAssets$(wanted: Map<string, Transaction[]>): Observable<boolean> {
    const txids = [...wanted.keys()];
    const batches: string[][] = [];
    for (let i = 0; i < txids.length; i += ASSET_MAX_TXIDS) {
      batches.push(txids.slice(i, i + ASSET_MAX_TXIDS));
    }
    return forkJoin(batches.map((batch) => this.httpClient.get<FreebankAssetCoinsResponse>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/freebank/asset-coins', { params: { txids: batch.join(',') } },
    ).pipe(catchError(() => of(null))))).pipe(
      map((answers) => {
        if (this.assetCache.size > CACHE_MAX) {
          this.assetCache.clear();
        }
        let changed = false;
        answers.forEach((answer, i) => {
          // an index still reading the chain (behind_by) may not know a tx yet: keep only complete answers
          const complete = !!answer && answer.behind_by === 0;
          for (const txid of batches[i]) {
            const coins = answer?.txs?.[txid] ?? null;
            if (complete) {
              this.assetCache.set(txid, coins);
            }
            if (coins) {
              changed = true;
              for (const tx of wanted.get(txid) || []) {
                setAssetLabels(tx, coins);
              }
            }
          }
        });
        return changed;
      }),
    );
  }

  private loadCustody$(wanted: Map<string, Transaction[]>): Observable<boolean> {
    const txids = [...wanted.keys()];
    const batches: string[][] = [];
    for (let i = 0; i < txids.length; i += MAX_TXIDS) {
      batches.push(txids.slice(i, i + MAX_TXIDS));
    }
    return forkJoin(batches.map((batch) => this.httpClient.get<FreebankCustodyResponse>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/freebank/custody', { params: { txids: batch.join(',') } },
    ).pipe(catchError(() => of(null))))).pipe(
      map((answers) => {
        if (this.cache.size > CACHE_MAX) {
          this.cache.clear();
        }
        for (const answer of answers) {
          for (const [txid, labels] of Object.entries(answer?.txs || {})) {
            for (const tx of wanted.get(txid) || []) {
              if (tx.status?.confirmed && labels) {
                this.cache.set(txid, labels);
              }
              setLabels(tx, labels);
            }
          }
        }
        return true;
      }),
    );
  }
}

function setAssetLabels(tx: Transaction, coins: FreebankAssetTxCoins | null | undefined): void {
  if (!coins) {
    return;
  }
  const labels = assetCoinLabels(tx, coins);
  tx.vin.forEach((input, i) => {
    input['_asset'] = labels.vin[i];
  });
  tx.vout.forEach((output, i) => {
    output['_asset'] = labels.vout[i];
  });
}

function setLabels(tx: Transaction, exact: FreebankCustodyTx | null | undefined): void {
  const family = getFreebankCustodyLabels(tx);
  const vin = mergeCustodyLabels(family.vin, exact?.vin);
  const vout = mergeCustodyLabels(family.vout, exact?.vout);
  tx.vin.forEach((input, i) => {
    input['_custody'] = vin[i];
  });
  tx.vout.forEach((output, i) => {
    output['_custody'] = vout[i];
  });
}
