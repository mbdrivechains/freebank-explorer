import { Injectable } from '@angular/core';
import { BehaviorSubject, EMPTY, Observable, Subject, Subscription, catchError, debounceTime, distinctUntilChanged, expand, map, of, switchMap, timer } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { BmmCube, bmmCube, bmmWaiting } from '@app/freebank/bmm-view';
import { FreebankBmmListResponse } from '@interfaces/freebank-bmm.interface';

// The bid on the block cubes. Each strip of cubes in the header (the live one and each page of
// older blocks) tells this service which heights it shows. The service asks GET /bmm once for all
// of them and hands the answers back by FreeBank block hash. It asks again when the shown heights
// change (a new block, another page) and, while any of those blocks is pending, every REFRESH_MS,
// at most MAX_POLLS times per change. Nothing is asked while the BMM view is off (the config is
// asked once per session: ApiService.getFreebankBmmConfig$).

const SETTLE_MS = 250;            // a new block moves every strip at once: wait for all, then ask once
const REFRESH_MS = 15000;
const MAX_POLLS = 20;
const MAX_LIMIT = 100;            // the API's cap on limit

/** One GET /bmm: `limit` blocks below `before`. `key` tells two requests apart. */
interface BmmRange {
  limit: number;
  before: number;
  key: string;
}

@Injectable({
  providedIn: 'root'
})
export class BmmCubesService {
  /** What the cubes show, by FreeBank block hash. A block not in it shows what it shows without the BMM view. */
  readonly cubes$ = new BehaviorSubject<Record<string, BmmCube>>({});

  private strips = new Map<object, { heights: number[], key: string }>();
  private changed$ = new Subject<void>();
  private subscription: Subscription | null = null;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
  ) { }

  /**
   * A strip shows these heights now (replacing what it showed before). `key` changes when a
   * block at a shown height is replaced (a reorg at the tip), so the service asks again.
   */
  show(strip: object, heights: number[], key: string = ''): void {
    if (!this.stateService.isBrowser) {
      return;
    }
    this.strips.set(strip, { heights, key });
    if (!this.subscription) {
      this.subscription = this.changed$.pipe(
        debounceTime(SETTLE_MS),
        map(() => this.shownRange()),
        distinctUntilChanged((a, b) => a?.key === b?.key),
        switchMap((range) => range ? this.load(range) : of(null)),
      ).subscribe((list) => this.cubes$.next(list ? toCubes(list) : {}));
    }
    this.changed$.next();
  }

  /** The strip is gone. */
  hide(strip: object): void {
    if (!this.strips.delete(strip)) {
      return;
    }
    if (!this.strips.size) {
      // Keep the answers: they are keyed by FreeBank block hash, so the next strip (after a page
      // change the header strip is rebuilt) shows its bids at once, until its own request answers.
      this.subscription?.unsubscribe();
      this.subscription = null;
      return;
    }
    this.changed$.next();
  }

  /**
   * The heights to ask for: the run of at most MAX_LIMIT heights that holds the most shown cubes.
   * The strips make one run, except when the user has scrolled far back: then the live strip
   * (hidden meanwhile) and the pages of older blocks are apart, and the pages win.
   */
  private shownRange(): BmmRange | null {
    const shown = new Set<number>();
    const keys: string[] = [];
    this.strips.forEach((strip) => {
      strip.heights.forEach((height) => {
        if (height >= 0) {
          shown.add(height);
        }
      });
      if (strip.key) {
        keys.push(strip.key);
      }
    });
    const heights = Array.from(shown).sort((a, b) => b - a);
    if (!heights.length) {
      return null;
    }
    let top = 0;                  // index in heights of the best run's highest block
    let count = 0;                // shown blocks in that run
    for (let i = 0, j = 0; i < heights.length; i++) {
      while (j < heights.length && heights[j] > heights[i] - MAX_LIMIT) {
        j++;
      }
      if (j - i > count) {
        top = i;
        count = j - i;
      }
    }
    const high = heights[top];
    const limit = high - heights[top + count - 1] + 1;
    return { limit, before: high + 1, key: `${limit}:${high + 1}:${keys.sort().join(',')}` };
  }

  /** GET /bmm for the range, then again every REFRESH_MS while a block in it is pending (MAX_POLLS at most). */
  private load(range: BmmRange): Observable<FreebankBmmListResponse | null> {
    return this.apiService.getFreebankBmmConfig$().pipe(
      switchMap((config) => {
        if (!config?.enabled) {
          return of(null);
        }
        const request = () => this.apiService.getFreebankBmm$(range.limit, range.before);
        let polls = 0;
        return request().pipe(
          // a repeat that fails gives the last answer again, and the polling goes on
          expand((list) => anyPending(list) && polls++ < MAX_POLLS
            ? timer(REFRESH_MS).pipe(switchMap(() => request().pipe(catchError(() => of(list)))))
            : EMPTY),
        );
      }),
      // the first request failed: the cubes keep what they show until the next change
      catchError(() => EMPTY),
    );
  }
}

function anyPending(list: FreebankBmmListResponse): boolean {
  return !!list?.enabled && (list.items || []).some((item) => bmmWaiting(item.status));
}

function toCubes(list: FreebankBmmListResponse): Record<string, BmmCube> {
  const cubes: Record<string, BmmCube> = {};
  if (list.enabled) {
    for (const item of list.items || []) {
      const cube = bmmCube(item, list.explorer_url);
      if (cube) {
        cubes[item.freebank_hash] = cube;
      }
    }
  }
  return cubes;
}
