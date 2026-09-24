import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankPoolResponse } from '@interfaces/freebank-credit.interface';

// /pool/:id - one pool and the house whose notes it trades. M4 PLACEHOLDER: title + raw JSON.
@Component({
  selector: 'app-pool-detail',
  templateUrl: './pool-detail.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolDetailComponent implements OnInit {
  poolId: number;
  state$: Observable<CreditLoad<FreebankPoolResponse>>;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // set before the first render: the tap below runs inside the first change detection pass
    this.poolId = parseInt(this.route.snapshot.paramMap.get('id'), 10);
    this.websocketService.want(['blocks']);
    this.state$ = this.route.paramMap.pipe(
      tap((params) => {
        this.poolId = parseInt(params.get('id'), 10);
        this.seoService.setTitle(`Pool ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank pool ${params.get('id')}: a house's notes against ECX, with reserves, fee and price.`);
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankPool$(this.poolId))),
    );
  }
}
