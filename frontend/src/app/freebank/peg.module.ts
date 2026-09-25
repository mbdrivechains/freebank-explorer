import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { PegComponent } from '@app/freebank/pages/peg/peg.component';

// The FreeBank peg page (/peg, /regtest/peg, ...): deposits from eCash, withdrawals to eCash and
// withdrawal bundles. Lazy-loaded by master-page.module.ts beside /bmm; its own small chunk.

const routes: Routes = [
  {
    path: '',
    component: PegComponent,
  },
];

@NgModule({
  imports: [
    RouterModule.forChild(routes)
  ],
  exports: [
    RouterModule
  ]
})
export class PegRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    PegRoutingModule,
    SharedModule,
  ],
  declarations: [
    PegComponent,
  ]
})
export class PegModule { }
