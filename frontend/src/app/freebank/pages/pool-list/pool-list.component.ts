import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankPoolsResponse } from '@interfaces/freebank-credit.interface';

// /pools - every pool of house notes against ECX. M4 PLACEHOLDER: title + raw JSON.
@Component({
  selector: 'app-pool-list',
  templateUrl: './pool-list.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolListComponent implements OnInit {
  state$: Observable<CreditLoad<FreebankPoolsResponse>>;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Pools');
    this.seoService.setDescription('FreeBank pools: each house\'s notes traded against ECX, with reserves, fee and price.');
    this.websocketService.want(['blocks']);
    this.state$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankPools$());
  }
}
