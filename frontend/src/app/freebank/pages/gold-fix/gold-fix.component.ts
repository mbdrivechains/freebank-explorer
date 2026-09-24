import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankGoldResponse } from '@interfaces/freebank-credit.interface';

// /gold - the gold fix and its bonded submitters. M4 PLACEHOLDER: title + raw JSON.
@Component({
  selector: 'app-gold-fix',
  templateUrl: './gold-fix.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoldFixComponent implements OnInit {
  state$: Observable<CreditLoad<FreebankGoldResponse>>;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Gold fix');
    this.seoService.setDescription('The FreeBank gold fix: the on-chain gold price and the bonded submitters behind it.');
    this.websocketService.want(['blocks']);
    this.state$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankGold$());
  }
}
