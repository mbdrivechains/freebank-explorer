import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SharedModule } from '@app/shared/shared.module';
import { HouseHealthBadgeComponent } from '@app/freebank/components/house-health-badge/house-health-badge.component';
import { CreditAmountComponent } from '@app/freebank/components/credit-amount/credit-amount.component';
import { CreditHeightComponent } from '@app/freebank/components/credit-height/credit-height.component';
import {
  BillStatusPipe, BlockCountPipe, BlocksFromTipPipe, BpsPipe, CreditOpPipe, EcxPipe, GramsPipe, NoteUnitsPipe, SatsAsEcxPipe,
} from '@app/freebank/pipes/credit.pipes';

// The credit display building blocks: the house health badge, amounts with grams, heights
// relative to the tip, and the unit pipes. Imported by CreditModule; any other module that
// wants the badge or the pipes (a tx page, the dashboard) can import this without the pages.
const CREDIT_SHARED = [
  HouseHealthBadgeComponent,
  CreditAmountComponent,
  CreditHeightComponent,
  GramsPipe,
  BpsPipe,
  EcxPipe,
  SatsAsEcxPipe,
  NoteUnitsPipe,
  BlockCountPipe,
  BlocksFromTipPipe,
  CreditOpPipe,
  BillStatusPipe,
];

@NgModule({
  imports: [
    CommonModule,
    SharedModule,
  ],
  declarations: CREDIT_SHARED,
  exports: CREDIT_SHARED,
})
export class CreditSharedModule { }
