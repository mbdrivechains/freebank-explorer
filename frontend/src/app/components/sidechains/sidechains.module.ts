import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { SidechainsComponent } from '@components/sidechains/sidechains.component';
import { SidechainSlotComponent } from '@components/sidechains/sidechain-slot.component';

// easynet: the sidechain slots page (/sidechains) and one slot's history (/sidechains/:slot)
const routes: Routes = [
  {
    path: '',
    component: SidechainsComponent,
  },
  {
    path: ':slot',
    component: SidechainSlotComponent,
  },
];

@NgModule({
  imports: [
    RouterModule.forChild(routes),
  ],
  exports: [
    RouterModule,
  ],
})
export class SidechainsRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    SidechainsRoutingModule,
    SharedModule,
  ],
  declarations: [
    SidechainsComponent,
    SidechainSlotComponent,
  ],
})
export class SidechainsModule { }
