import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { PegLine } from '@app/freebank/peg-view';

// One line of a FreeBank peg note (freebank/peg-view.ts): its parts with ' · ' between them;
// links into this explorer by route, links to the eCash explorer in a new tab (marked ↗).

@Component({
  selector: 'app-freebank-peg-line',
  templateUrl: './peg-line.component.html',
  styleUrls: ['./peg.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FreebankPegLineComponent {
  @Input() line: PegLine | null = null;
}
