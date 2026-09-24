import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CreditLoad } from '@app/freebank/credit-load';

/**
 * Loading spinner, HTTP error, or the raw JSON of a credit API response (a CreditLoad from
 * loadOnEachBlock). The M4 placeholder pages use it to prove the wiring; a finished page can
 * keep it inside a collapsed "Raw data" section or drop it.
 *
 *   <app-credit-raw-json [state]="state" errorText="Could not load the houses"></app-credit-raw-json>
 */
@Component({
  selector: 'app-credit-raw-json',
  templateUrl: './credit-raw-json.component.html',
  styleUrls: ['./credit-raw-json.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditRawJsonComponent {
  @Input() state: CreditLoad<unknown>;
  @Input() errorText: string = 'Could not load this data';
  @Input() showJson: boolean = true;
}
