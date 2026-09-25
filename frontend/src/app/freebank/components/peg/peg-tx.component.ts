import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { Transaction } from '@interfaces/electrs.interface';
import { FreebankPegService } from '@app/freebank/peg.service';
import { PegPanel, pegTxPanels } from '@app/freebank/peg-view';
import { isRefundRequest } from '@app/freebank/freebank-tx-flags';

// FreeBank: on the tx page of a withdrawal to eCash (or of a withdrawal refund request), what it
// pays on eCash, where, and where it stands. Asks /api/v1/freebank/peg/tx only for a tx with a
// withdrawal or refund-request output (a coinbase can have one too: the node reads them from
// every tx); shows nothing for any other tx.

const WITHDRAWAL = /^6aacdcf66f57/;
const isWithdrawalOrRefund = (script: string): boolean => WITHDRAWAL.test(script) || isRefundRequest(script);

@Component({
  selector: 'app-freebank-peg-tx',
  templateUrl: './peg-tx.component.html',
  styleUrls: ['./peg.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FreebankPegTxComponent implements OnChanges {
  @Input() tx: Transaction;

  panels$: Observable<PegPanel[]> = of([]);

  constructor(private pegService: FreebankPegService) { }

  ngOnChanges(): void {
    const has = !!this.tx?.txid && !!this.tx.vout?.some((v) => isWithdrawalOrRefund(v?.scriptpubkey || ''));
    this.panels$ = has
      ? this.pegService.txOnEachBlock$(this.tx.txid).pipe(map(pegTxPanels), catchError(() => of([])))
      : of([]);
  }
}
