import { Component, ChangeDetectionStrategy, OnChanges, Input } from '@angular/core';
import { calcSegwitFeeGains } from '@app/bitcoin.utils';
import { Transaction } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';

@Component({
  selector: 'app-tx-features',
  templateUrl: './tx-features.component.html',
  styleUrls: ['./tx-features.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TxFeaturesComponent implements OnChanges {
  @Input() tx: Transaction;

  segwitGains = {
    realizedSegwitGains: 0,
    potentialSegwitGains: 0,
    potentialP2shSegwitGains: 0,
    potentialTaprootGains: 0,
    realizedTaprootGains: 0
  };
  isRbfTransaction: boolean;
  isTaproot: boolean;

  segwitEnabled: boolean;
  rbfEnabled: boolean;
  taprootEnabled: boolean;

  constructor(
    private stateService: StateService,
  ) { }

  ngOnChanges() {
    if (!this.tx) {
      return;
    }
    // FreeBank: SegWit (ALWAYS_ACTIVE) and opt-in RBF work from genesis, so no Bitcoin
    // activation heights; there is no Taproot, so no Taproot badge or fee-saving advice
    this.segwitEnabled = true;
    this.taprootEnabled = false;
    this.rbfEnabled = true;
    this.segwitGains = calcSegwitFeeGains(this.tx);
    this.isRbfTransaction = this.tx.vin.some((v) => v.sequence < 0xfffffffe);
    this.isTaproot = this.tx.vin.some((v) => v.prevout && v.prevout.scriptpubkey_type === 'v1_p2tr');
  }
}
