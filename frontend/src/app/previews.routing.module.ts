import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { TransactionPreviewComponent } from '@components/transaction/transaction-preview.component';
import { BlockPreviewComponent } from '@components/block/block-preview.component';
import { AddressPreviewComponent } from '@components/address/address-preview.component';
import { PoolPreviewComponent } from '@components/pool/pool-preview.component';
import { MasterPagePreviewComponent } from '@components/master-page-preview/master-page-preview.component';

const browserWindow = window || {};
// @ts-ignore
const browserWindowEnv = browserWindow.__env || {};
// FreeBank Explorer: no mining pools, so no pool preview unless MINING_DASHBOARD is on.
const miningDashboard = !!browserWindowEnv.MINING_DASHBOARD;

const routes: Routes = [
  {
    path: '',
    component: MasterPagePreviewComponent,
    children: [
      {
        path: 'block/:id',
        component: BlockPreviewComponent
      },
      {
        path: 'address/:id',
        children: [],
        component: AddressPreviewComponent
      },
      {
        path: 'tx/:id',
        children: [],
        component: TransactionPreviewComponent
      },
      ...(miningDashboard ? [
        {
          path: 'mining/pool/:slug',
          component: PoolPreviewComponent
        },
      ] : []),
    ],
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class PreviewsRoutingModule { }
