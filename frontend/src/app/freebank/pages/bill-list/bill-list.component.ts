import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankBillsResponse } from '@interfaces/freebank-credit.interface';

// /bills - every bill of exchange. M4 PLACEHOLDER: title + raw JSON.
@Component({
  selector: 'app-bill-list',
  templateUrl: './bill-list.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BillListComponent implements OnInit {
  state$: Observable<CreditLoad<FreebankBillsResponse>>;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Bills');
    this.seoService.setDescription('FreeBank bills of exchange: face value, maturity, endorsements, and which were discounted at a house.');
    this.websocketService.want(['blocks']);
    this.state$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankBills$());
  }
}
