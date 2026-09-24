import { HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, defer, filter, map, of, startWith, switchMap, tap } from 'rxjs';
import { StateService } from '@app/services/state.service';

// The /api/v1/freebank endpoints answer from a cache the backend refreshes once per block, so a
// credit page loads once and then again only when a newer block arrives over the websocket
// (StateService.chainTip$; the page must call websocketService.want(['blocks'])).

export interface CreditLoad<T> {
  loading: boolean;               // a request is in flight (data keeps the previous response meanwhile)
  data?: T;                       // the latest successful response
  error?: HttpErrorResponse;      // set when the latest request failed (404 for an unknown id)
}

/**
 * Load `request()` now and again on every new chain tip above the tip_height of the data
 * already loaded. Never errors: a failed request comes back as { loading: false, error }, and
 * the next block retries.
 *
 *   state$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouses$());
 *
 * With a route id:
 *   state$ = this.route.paramMap.pipe(switchMap((params) =>
 *     loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouse$(+params.get('id')))));
 */
export function loadOnEachBlock<T extends { tip_height: number }>(
  stateService: StateService,
  request: () => Observable<T>,
): Observable<CreditLoad<T>> {
  return defer(() => {
    let loadedTip: number | null = null;
    let data: T | undefined;
    return stateService.chainTip$.pipe(
      startWith(stateService.latestBlockHeight),
      filter((tip) => {
        if (loadedTip === null || tip > loadedTip) {
          loadedTip = Math.max(tip, loadedTip === null ? -1 : loadedTip);
          return true;
        }
        return false;
      }),
      switchMap(() => request().pipe(
        tap((response) => {
          data = response;
          if (typeof response?.tip_height === 'number') {
            loadedTip = Math.max(loadedTip ?? -1, response.tip_height);
          }
        }),
        map((response): CreditLoad<T> => ({ loading: false, data: response })),
        catchError((error: HttpErrorResponse) => of<CreditLoad<T>>({ loading: false, data, error })),
        startWith<CreditLoad<T>>({ loading: true, data }),
      )),
    );
  });
}
