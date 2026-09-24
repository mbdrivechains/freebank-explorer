import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { formatBlocksFromTip } from '@app/freebank/credit-units';

/**
 * A block height with its distance from the tip; heights at or below the tip link to the block.
 *
 *   <app-credit-height [height]="house.lastattestheight" [tipHeight]="tip"></app-credit-height>
 *       -> 452 (2 blocks ago)        (452 links to /block/452)
 *   <app-credit-height [height]="house.attest_deadline" [tipHeight]="tip"></app-credit-height>
 *       -> 740 (in 286 blocks)       (no link: the block does not exist yet)
 *
 * Height 0 means "never" in most credit fields: pass [zeroText]="'never'" to show that instead.
 */
@Component({
  selector: 'app-credit-height',
  templateUrl: './credit-height.component.html',
  styleUrls: ['./credit-height.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditHeightComponent implements OnChanges {
  @Input() height: number;
  @Input() tipHeight: number;
  @Input() showRelative: boolean = true;
  @Input() zeroText: string = '';         // shown instead of '0' when set

  linkable = false;
  relativeText = '';
  isZero = false;

  ngOnChanges(): void {
    const hasHeight = typeof this.height === 'number' && isFinite(this.height);
    const hasTip = typeof this.tipHeight === 'number' && this.tipHeight >= 0;
    this.isZero = hasHeight && this.height === 0 && !!this.zeroText;
    this.linkable = hasHeight && this.height > 0 && (!hasTip || this.height <= this.tipHeight);
    this.relativeText = hasHeight && hasTip && this.showRelative && !this.isZero ? formatBlocksFromTip(this.height, this.tipHeight) : '';
  }
}
