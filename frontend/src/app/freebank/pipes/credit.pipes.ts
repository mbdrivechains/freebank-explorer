import { Pipe, PipeTransform } from '@angular/core';
import { FreebankBill, FreebankTxFamily } from '@interfaces/freebank-credit.interface';
import {
  formatBlockCount, formatBlocksFromTip, formatBps, formatEcx, formatGrams, formatSatsAsEcx, formatUnits,
} from '@app/freebank/credit-units';
import { billStatusLabel, creditOpLabel } from '@app/freebank/credit-ops';

// Display pipes for the credit pages (declared and exported by CreditSharedModule).
// All return plain text; none adds the coin symbol except where noted.

/** {{ house.activeescrow_grams | grams }} -> '20.74 g'; below 1 g in mg: '435.4 mg' */
@Pipe({ name: 'grams', standalone: false })
export class GramsPipe implements PipeTransform {
  transform(grams: number): string {
    return formatGrams(grams);
  }
}

/** {{ house.attestedratiobps | bps }} -> '100%'; {{ pool.fee_bps | bps }} -> '0.3%' */
@Pipe({ name: 'bps', standalone: false })
export class BpsPipe implements PipeTransform {
  transform(bps: number): string {
    return formatBps(bps);
  }
}

/** {{ bill.amount | ecx }} -> '1.00' (a decimal ECX field; add the ECX symbol yourself) */
@Pipe({ name: 'ecx', standalone: false })
export class EcxPipe implements PipeTransform {
  transform(ecx: number): string {
    return formatEcx(ecx);
  }
}

/** {{ pool.btx_reserve | satsAsEcx }} -> '0.01955035' (a sats field shown in ECX) */
@Pipe({ name: 'satsAsEcx', standalone: false })
export class SatsAsEcxPipe implements PipeTransform {
  transform(sats: number): string {
    return formatSatsAsEcx(sats);
  }
}

/** {{ house.mintedunits | noteUnits }} -> '5,040,000' (any integer count) */
@Pipe({ name: 'noteUnits', standalone: false })
export class NoteUnitsPipe implements PipeTransform {
  transform(units: number): string {
    return formatUnits(units);
  }
}

/** {{ 288 | blockCount }} -> '288 blocks'; {{ 1 | blockCount }} -> '1 block' */
@Pipe({ name: 'blockCount', standalone: false })
export class BlockCountPipe implements PipeTransform {
  transform(blocks: number): string {
    return formatBlockCount(blocks);
  }
}

/** {{ house.attest_deadline | blocksFromTip: tipHeight }} -> 'in 286 blocks' / '2 blocks ago' / 'at the tip' */
@Pipe({ name: 'blocksFromTip', standalone: false })
export class BlocksFromTipPipe implements PipeTransform {
  transform(height: number, tipHeight: number): string {
    return formatBlocksFromTip(height, tipHeight);
  }
}

/** {{ item.family | creditOp: item.op : item.op_name }} -> 'Reserve attestation' */
@Pipe({ name: 'creditOp', standalone: false })
export class CreditOpPipe implements PipeTransform {
  transform(family: FreebankTxFamily | string, op: number | null, opName?: string | null): string {
    return creditOpLabel(family, op, opName);
  }
}

/** {{ bill | billStatus }} -> 'Active' / 'Discounted' / 'Retired' / 'Defaulted' */
@Pipe({ name: 'billStatus', standalone: false })
export class BillStatusPipe implements PipeTransform {
  transform(bill: Pick<FreebankBill, 'status' | 'owner_house_id'>): string {
    return billStatusLabel(bill);
  }
}
