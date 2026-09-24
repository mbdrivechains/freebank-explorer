import { Injectable, inject } from '@angular/core';
import { CanMatchFn, Route, Router, UrlSegment } from '@angular/router';

@Injectable({
  providedIn: 'root'
})
class GuardService {
  constructor(
    private router: Router,
  ) {}

  trackerGuard(route: Route, segments: UrlSegment[]): boolean {
    const preferredRoute = this.router.getCurrentNavigation()?.extractedUrl.queryParams?.mode;
    const path = this.router.getCurrentNavigation()?.extractedUrl.root.children.primary.segments;
    // FreeBank: phones get the full tx page (credit badge, outputs, labels) by default; the
    // tracker view has no ETA without a difficulty adjustment, so only an explicit ?mode=status opens it
    return preferredRoute === 'status' && window.innerWidth <= 767.98 && !(path.length === 2 && ['push', 'test', 'preview'].includes(path[1].path));
  }
}

export const TrackerGuard: CanMatchFn = (route: Route, segments: UrlSegment[]): boolean => {
  return inject(GuardService).trackerGuard(route, segments);
};
