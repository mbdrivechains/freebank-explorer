import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject, Observable, catchError, combineLatest, map, of, startWith, switchMap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { FreebankHouseMembersResponse } from '@interfaces/freebank-credit.interface';

interface MembersView {
  loading: boolean;
  error: HttpErrorResponse | null;
  data: FreebankHouseMembersResponse | null;
}

const PAGE = 100;

// /house/:id/members - a members-only (or redeem-only) house's public member list (v0.2.19), in address order, paged by
// address (the list can reach 100,000). The house's own keys (partners, redemption destination) are members too and
// are not listed by the node.
@Component({
  selector: 'app-house-members',
  templateUrl: './house-members.component.html',
  styleUrls: ['../bills-pools.scss', './house-members.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseMembersComponent implements OnInit {
  idText = '';
  houseId = 0;
  starts: string[] = [''];        // the start address of each page seen, for "previous"
  private start$ = new BehaviorSubject<string>('');
  view$: Observable<MembersView>;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private seoService: SeoService,
    private stateService: StateService,
  ) { }

  ngOnInit(): void {
    this.view$ = combineLatest([this.route.paramMap, this.start$]).pipe(
      switchMap(([params, start]) => {
        this.idText = params.get('id') || '';
        this.houseId = parseInt(this.idText, 10);
        this.seoService.setTitle(`House ${this.idText} members`);
        this.seoService.setDescription(`The public member list of FreeBank house ${this.idText}.`);
        return this.apiService.getFreebankHouseMembers$(this.houseId, start, PAGE).pipe(
          map((data): MembersView => ({ loading: false, error: null, data })),
          catchError((error: HttpErrorResponse) => of<MembersView>({ loading: false, error, data: null })),
          startWith<MembersView>({ loading: true, error: null, data: null }),
        );
      }),
    );
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

  get pageNumber(): number {
    return this.starts.length;
  }

  get tipHeight(): number {
    return this.stateService.latestBlockHeight;
  }
}
