import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankHousesResponse } from '@interfaces/freebank-credit.interface';

// /houses - every discount house. M4 PLACEHOLDER: title, one badge per house, raw JSON.
@Component({
  selector: 'app-house-list',
  templateUrl: './house-list.component.html',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseListComponent implements OnInit {
  state$: Observable<CreditLoad<FreebankHousesResponse>>;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Houses');
    this.seoService.setDescription('FreeBank discount houses: the notes each has issued, its attested reserves and its health.');
    this.websocketService.want(['blocks']);
    this.state$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouses$());
  }
}
