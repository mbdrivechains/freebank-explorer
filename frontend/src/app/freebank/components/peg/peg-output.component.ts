import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { Transaction } from '@interfaces/electrs.interface';
import { FreebankPegService } from '@app/freebank/peg.service';
import { PegLine, isPegOutputScript, pegOutputLines } from '@app/freebank/peg-view';

// FreeBank: what a peg output means, under its label in a tx's output list: a deposit from eCash
// and its eCash tx, a withdrawal to eCash and its status, a bundle, a refund. Asks
// /api/v1/freebank/peg/tx once per tx and block (FreebankPegService shares the answer between
// outputs) and shows nothing until it answers, or when it has nothing to say.

@Component({
  selector: 'app-freebank-peg-output',
  templateUrl: './peg-output.component.html',
  styleUrls: ['./peg.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FreebankPegOutputComponent implements OnChanges {
  @Input() tx: Transaction;
  @Input() vout: number;

  lines$: Observable<PegLine[]> = of([]);

  constructor(private pegService: FreebankPegService) { }

  ngOnChanges(): void {
    const script = this.tx?.vout?.[this.vout]?.scriptpubkey;
    if (!this.tx?.txid || !isPegOutputScript(script)) {
      this.lines$ = of([]);
      return;
    }
    const vout = this.vout;
    this.lines$ = this.pegService.txOnEachBlock$(this.tx.txid).pipe(
      map((view) => pegOutputLines(view, vout)),
      catchError(() => of([])),
    );
  }
}
