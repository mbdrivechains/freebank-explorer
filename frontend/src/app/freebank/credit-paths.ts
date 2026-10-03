import { Route, UrlSegment } from '@angular/router';

// The first URL segments served by the lazy CreditModule (freebank/credit.module.ts). Kept in
// this tiny file because master-page.module.ts is eager: importing it from credit.module.ts would
// pull every credit page into the main bundle. Keep in step with the routes in credit.module.ts.
export const CREDIT_ROOT_SEGMENTS = ['credit', 'houses', 'house', 'bills', 'bill', 'pools', 'pool', 'gold', 'assets', 'asset'];

/**
 * canMatch for the credit module's empty-path mount in master-page.module.ts: matches only the
 * credit URLs, so the module is fetched on first visit to a credit page and never for other pages.
 */
export function matchCreditPages(route: Route, segments: UrlSegment[]): boolean {
  return segments.length > 0 && CREDIT_ROOT_SEGMENTS.includes(segments[0].path);
}
