import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankHouseResponse } from '@interfaces/freebank-credit.interface';

// /house/:id - one house: record, loan book, bills it holds, its pool. M4 PLACEHOLDER.
@Component({
  selector: 'app-house-detail',
  templateUrl: './house-detail.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseDetailComponent implements OnInit {
  houseId: number;
  state$: Observable<CreditLoad<FreebankHouseResponse>>;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // set before the first render: the tap below runs inside the first change detection pass
    this.houseId = parseInt(this.route.snapshot.paramMap.get('id'), 10);
    this.websocketService.want(['blocks']);
    this.state$ = this.route.paramMap.pipe(
      tap((params) => {
        this.houseId = parseInt(params.get('id'), 10);
        this.seoService.setTitle(`House ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank discount house ${params.get('id')}: its notes, attested reserves, loan book, pool and health.`);
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouse$(this.houseId))),
    );
  }
}
