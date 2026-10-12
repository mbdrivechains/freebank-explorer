import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable, combineLatest, merge, of, timer } from 'rxjs';
import { catchError, distinctUntilChanged, map, switchMap, tap } from 'rxjs/operators';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { SidechainProposal, SidechainSlot } from '@interfaces/node-api.interface';
import { ackPercent, sidechainName } from '@components/sidechains/sidechains.component';

// easynet: one sidechain slot: the active sidechain's declaration, and every proposal ever made for the slot.

@Component({
  selector: 'app-sidechain-slot',
  templateUrl: './sidechain-slot.component.html',
  styleUrls: ['./sidechains.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidechainSlotComponent implements OnInit {
  data$: Observable<SidechainSlot | 'error'>;
  name = sidechainName;
  ackPercent = ackPercent;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    const slot$ = this.route.paramMap.pipe(
      map((params) => parseInt(params.get('slot') ?? '', 10)),
      distinctUntilChanged(),
      tap((slot) => this.seoService.setTitle('Sidechain slot ' + slot)),
    );
    const tick$ = merge(this.stateService.chainTip$.pipe(distinctUntilChanged()), timer(0, 30000));
    this.data$ = combineLatest([slot$, tick$]).pipe(
      switchMap(([slot]) => Number.isInteger(slot) && slot >= 0 && slot <= 255
        ? this.apiService.getSidechainSlot$(slot).pipe(catchError(() => of('error' as const)))
        : of('error' as const)),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );
  }

  threshold(s: SidechainSlot, p: SidechainProposal): number {
    return p.slotUsed ? s.rules.usedThreshold : s.rules.unusedThreshold;
  }
}
