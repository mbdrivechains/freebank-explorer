import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { UNIT } from '@app/app.constants';
import { formatEcx, formatGrams, formatSatsAsEcx, formatUnits } from '@app/freebank/credit-units';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

/**
 * A credit amount with its grams-of-gold equivalent. Set exactly one of ecx / sats / units,
 * plus the node's matching *_grams field:
 *
 *   <app-credit-amount [ecx]="bill.amount" [grams]="bill.amount_grams"></app-credit-amount>
 *       -> 1.00 ECX (20.74 g)
 *   <app-credit-amount [sats]="pool.btx_reserve" [grams]="pool.btx_reserve_grams"></app-credit-amount>
 *       -> 0.01955035 ECX (405.4 mg)
 *   <app-credit-amount [units]="house.mintedunits" [grams]="house.mintedunits_grams"></app-credit-amount>
 *       -> 5,040,000 units (1.05 g)
 *   [unitLabel]="house.classid + ' notes'" -> 5,040,000 hone notes (1.05 g)
 *   [gramsFirst]="true"                   -> 1.05 g (5,040,000 units)
 *
 * With no grams input, or while gold is not shown (gold-display.ts), only the amount shows. The grams come from the node's presentation scale
 * (see interfaces/freebank-credit.interface.ts); they are not the gold fix.
 */
@Component({
  selector: 'app-credit-amount',
  templateUrl: './credit-amount.component.html',
  styleUrls: ['./credit-amount.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditAmountComponent implements OnChanges {
  @Input() ecx: number;                   // a decimal ECX field (bill amount, activeescrow, ...)
  @Input() sats: number;                  // an integer sats field (loanbookface, btx_reserve, ...), shown in ECX
  @Input() units: number;                 // note units (mintedunits, note_reserve, ...)
  @Input() grams: number;                 // the matching *_grams field
  @Input() unitLabel: string = 'units';   // the word after a note-unit amount
  @Input() gramsFirst: boolean = false;   // grams as the main figure, the amount in brackets
  @Input() hideGrams: boolean = false;

  amountText = '';
  symbol = '';
  gramsText = '';

  ngOnChanges(): void {
    if (isNumber(this.units)) {
      this.amountText = formatUnits(this.units);
      this.symbol = this.unitLabel;
    } else if (isNumber(this.sats)) {
      this.amountText = formatSatsAsEcx(this.sats);
      this.symbol = UNIT;
    } else if (isNumber(this.ecx)) {
      this.amountText = formatEcx(this.ecx);
      this.symbol = UNIT;
    } else {
      this.amountText = '';
      this.symbol = '';
    }
    this.gramsText = GOLD_SHOWN && !this.hideGrams && isNumber(this.grams) ? formatGrams(this.grams) : '';
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}
