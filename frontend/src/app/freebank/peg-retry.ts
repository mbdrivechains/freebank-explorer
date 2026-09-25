import { EMPTY, Observable, expand, switchMap, timer } from 'rxjs';

// While the backend's peg index is still reading the chain (behind_by > 0, e.g. right after a
// deploy), peg.service.ts asks again every few seconds, so 'indexing: block N of M' does not stay
// up until the next block. Pure rxjs, so tests/peg-view-test.ts can run it in node.

const RETRY_MS = 5_000;
const RETRY_MAX = 24; // two minutes; after that the next block asks again

export function behind(answer: any): boolean {
  return answer?.behind_by > 0;
}

/** The request's answer, then fresh ones every `ms` while they say the index is behind. */
export function whileIndexing<T>(request: () => Observable<T>, ms = RETRY_MS, max = RETRY_MAX): Observable<T> {
  return request().pipe(
    expand((answer, i) => behind(answer) && i < max ? timer(ms).pipe(switchMap(() => request())) : EMPTY),
  );
}
