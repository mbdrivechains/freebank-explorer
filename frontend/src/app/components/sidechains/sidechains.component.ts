import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable, merge, of, timer } from 'rxjs';
import { catchError, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { SidechainEvent, SidechainProposal, SidechainSummary } from '@interfaces/node-api.interface';

// easynet: which BIP 300 sidechain slots are active, which proposals (M1) are collecting acks (M2), and the latest
// changes. The backend replays every block's coinbase with the enforcer's rules (api/easynet/sidechain-rules.ts).

export const EVENT_WORDS: { [type: string]: string } = {
  proposed: 'Proposed (M1)',
  activated: 'Became active',
  replaced: 'Replaced by a new proposal',
  failed: 'Dropped: too few acks in time',
};

export function sidechainName(p: { declaration?: { title: string } | null, title?: string | null }): string {
  return p.declaration?.title ?? p.title ?? 'No declaration';
}

/** Acks counted against acks needed, as a percentage for the bar. */
export function ackPercent(p: SidechainProposal, threshold: number): number {
  return Math.min(100, Math.round(100 * p.votes / (threshold + 1)));
}

@Component({
  selector: 'app-sidechains',
  templateUrl: './sidechains.component.html',
  styleUrls: ['./sidechains.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidechainsComponent implements OnInit {
  data$: Observable<SidechainSummary | 'error'>;
  eventWords = EVENT_WORDS;
  name = sidechainName;
  ackPercent = ackPercent;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Sidechains');
    this.seoService.setDescription('easynet\'s sidechain slots: active sidechains, proposals (M1) and their acks (M2), block by block.');
    // again on each new block, and every 30 s while the backend is still reading blocks
    this.data$ = merge(this.stateService.chainTip$.pipe(distinctUntilChanged()), timer(0, 30000)).pipe(
      switchMap(() => this.apiService.getSidechains$().pipe(catchError(() => of('error' as const)))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );
  }

  threshold(s: SidechainSummary, p: SidechainProposal): number {
    return p.slotUsed ? s.rules.usedThreshold : s.rules.unusedThreshold;
  }

  activeIn(s: SidechainSummary, slot: number): SidechainProposal | undefined {
    return s.active.find((a) => a.slot === slot);
  }

  trackEvent(i: number, e: SidechainEvent): string {
    return e.height + e.type + e.slot + e.descriptionHash;
  }
}
