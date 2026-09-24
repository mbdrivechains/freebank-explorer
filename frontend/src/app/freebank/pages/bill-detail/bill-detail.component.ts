import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable, switchMap, tap } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankBillResponse } from '@interfaces/freebank-credit.interface';

// /bill/:id - one bill of exchange. M4 PLACEHOLDER: title + raw JSON.
@Component({
  selector: 'app-bill-detail',
  templateUrl: './bill-detail.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BillDetailComponent implements OnInit {
  billId: number;
  state$: Observable<CreditLoad<FreebankBillResponse>>;

  constructor(
    private route: ActivatedRoute,
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    // set before the first render: the tap below runs inside the first change detection pass
    this.billId = parseInt(this.route.snapshot.paramMap.get('id'), 10);
    this.websocketService.want(['blocks']);
    this.state$ = this.route.paramMap.pipe(
      tap((params) => {
        this.billId = parseInt(params.get('id'), 10);
        this.seoService.setTitle(`Bill ${params.get('id')}`);
        this.seoService.setDescription(`FreeBank bill of exchange ${params.get('id')}: face value, escrow, maturity and endorsements.`);
      }),
      switchMap(() => loadOnEachBlock(this.stateService, () => this.apiService.getFreebankBill$(this.billId))),
    );
  }
}
