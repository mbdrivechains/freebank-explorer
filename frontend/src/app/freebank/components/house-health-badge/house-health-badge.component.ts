import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { FreebankHouse } from '@interfaces/freebank-credit.interface';
import { HouseHealth, houseHealth } from '@app/freebank/house-health';

/**
 * The house health badge (design decision 39): SOUND / ATTESTATION DUE / STRESSED / INSOLVENT
 * (and WOUND DOWN for a closed house), with a tooltip saying why. The rules are in
 * freebank/house-health.ts.
 *
 *   <app-house-health-badge [house]="house" [tipHeight]="response.tip_height"></app-house-health-badge>
 *   <app-house-health-badge [house]="house" [tipHeight]="tip" [showSummary]="true"></app-house-health-badge>
 */
@Component({
  selector: 'app-house-health-badge',
  templateUrl: './house-health-badge.component.html',
  styleUrls: ['./house-health-badge.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseHealthBadgeComponent implements OnChanges {
  @Input() house: FreebankHouse;          // a gethouse / listhouses record
  @Input() tipHeight: number;             // the tip_height of the API response the house came from
  @Input() showSummary: boolean = false;  // also print the one-line summary after the badge
  @Input() placement: string = 'bottom';  // tooltip placement

  health: HouseHealth | null = null;

  ngOnChanges(): void {
    this.health = this.house ? houseHealth(this.house, this.tipHeight) : null;
  }
}
