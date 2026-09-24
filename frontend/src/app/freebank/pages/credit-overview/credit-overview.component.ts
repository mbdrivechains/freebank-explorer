import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankActivityResponse, FreebankSummaryResponse } from '@interfaces/freebank-credit.interface';

// /credit - the credit layer overview. M4 PLACEHOLDER: title + raw JSON; the page author
// replaces the template (summary tiles, house badges, recent activity).
@Component({
  selector: 'app-credit-overview',
  templateUrl: './credit-overview.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditOverviewComponent implements OnInit {
  summary$: Observable<CreditLoad<FreebankSummaryResponse>>;
  activity$: Observable<CreditLoad<FreebankActivityResponse>>;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Credit');
    this.seoService.setDescription('The FreeBank credit layer: discount houses and their notes, bills of exchange, term deposits, pools, settlements and the gold fix.');
    this.websocketService.want(['blocks']);
    this.summary$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankSummary$());
    this.activity$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$(undefined, 20));
  }
}
