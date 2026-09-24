import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { BmmComponent } from '@app/freebank/pages/bmm/bmm.component';

// The FreeBank BMM view (/bmm, /regtest/bmm, ...). Lazy-loaded by master-page.module.ts beside the
// credit pages; its own small chunk, so /bmm does not fetch the credit pages and vice versa.

const routes: Routes = [
  {
    path: '',
    component: BmmComponent,
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
export class BmmRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    BmmRoutingModule,
    SharedModule,
  ],
  declarations: [
    BmmComponent,
  ]
})
export class BmmModule { }
