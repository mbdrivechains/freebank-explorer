import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { FreebankHouse, FreebankHousesResponse } from '@interfaces/freebank-credit.interface';
import { formatEcx, formatUnits } from '@app/freebank/credit-units';
import { HOUSE_BADGE_LABELS, HOUSE_BADGE_ORDER, HouseBadge, HouseHealth, formatAttestedRatio, houseHealth, houseNeverAttested } from '@app/freebank/house-health';
import { AttestationClock, HouseCapacity, attestationClock, houseCapacity, houseStatusLabel } from '@app/freebank/pages/house-common/house-view';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

export interface HouseListRow {
  house: FreebankHouse;
  health: HouseHealth;
  statusLabel: string;
  ratioText: string;
  capacity: HouseCapacity;
  capitalTip: string;             // the capital-cap sum in words
  clock: AttestationClock;
  attests: boolean;               // still on the attestation clock (not insolvent or wound down)
  neverAttested: boolean;
  partnersActive: number;
}

export interface HouseListView {
  loading: boolean;               // first load in flight (no rows yet)
  refreshing: boolean;            // a reload after a new block is in flight
  error?: HttpErrorResponse;
  tip: number | null;
  rows: HouseListRow[];
  counts: { badge: HouseBadge; label: string; count: number }[];
}

function capitalCapTip(house: FreebankHouse, capacity: HouseCapacity): string {
  const sum = capacity.deposits
    ? `Notes ${formatUnits(capacity.notes)} + term deposits ${formatUnits(capacity.deposits)} = ${formatUnits(capacity.capital.used)} units`
    : `Notes ${formatUnits(capacity.notes)} units`;
  const cap = `capital cap of ${formatUnits(capacity.capital.cap)} units ` +
    `(issuance multiplier ${capacity.lambda.toFixed(1)} × ${formatEcx(house.activeescrow)} ECX of partner capital locked)`;
  const room = capacity.capital.over
    ? 'It is over the cap, so it cannot issue more notes.'
    : `Room left: ${formatUnits(capacity.capital.room)} units.`;
  return `${sum}, against a ${cap}. ${room}`;
}

// /houses - every house on the chain, one row each, with its health badge.
@Component({
  selector: 'app-house-list',
  templateUrl: './house-list.component.html',
  styleUrls: ['../house-common/house-common.scss', './house-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseListComponent implements OnInit {
  goldShown = GOLD_SHOWN; // FreeBank: gold views on or off (gold-display.ts)
  view$: Observable<HouseListView>;
  skeletonRows = [1, 2, 3];

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Houses');
    this.seoService.setDescription('FreeBank houses: the note-issuing banks on the chain, their attested reserves, notes issued and health.');
    this.websocketService.want(['blocks']);
    this.view$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankHouses$()).pipe(
      map((state) => this.toView(state)),
    );
  }

  trackByHouse(index: number, row: HouseListRow): number {
    return row.house.id;
  }

  private toView(state: CreditLoad<FreebankHousesResponse>): HouseListView {
    const data = state.data;
    const tip = data ? data.tip_height : null;
    const rows: HouseListRow[] = (data?.houses || []).map((house) => {
      const health = houseHealth(house, tip);
      const capacity = houseCapacity(house);
      return {
        house,
        health,
        statusLabel: houseStatusLabel(house.effective_status || house.status),
        ratioText: formatAttestedRatio(house),
        capacity,
        capitalTip: capitalCapTip(house, capacity),
        clock: attestationClock(house, tip ?? 0),
        attests: health.badge !== 'insolvent' && health.badge !== 'wound_down',
        neverAttested: houseNeverAttested(house),
        partnersActive: (house.partners || []).filter((p) => p.status === 'active').length,
      };
    });
    const counts = HOUSE_BADGE_ORDER
      .map((badge) => ({ badge, label: HOUSE_BADGE_LABELS[badge], count: rows.filter((row) => row.health.badge === badge).length }))
      .filter((entry) => entry.count > 0);
    return {
      loading: state.loading && !data,
      refreshing: state.loading && !!data,
      error: state.error,
      tip,
      rows,
      counts,
    };
  }
}
