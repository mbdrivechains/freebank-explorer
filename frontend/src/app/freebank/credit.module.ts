import { NgModule, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule, Router } from '@angular/router';
import { GOLD_SHOWN } from '@app/freebank/gold-display';
import { SharedModule } from '@app/shared/shared.module';
import { CreditSharedModule } from '@app/freebank/credit-shared.module';
import { CreditRawJsonComponent } from '@app/freebank/components/credit-raw-json/credit-raw-json.component';
import { CreditOverviewComponent } from '@app/freebank/pages/credit-overview/credit-overview.component';
import { HouseListComponent } from '@app/freebank/pages/house-list/house-list.component';
import { HouseDetailComponent } from '@app/freebank/pages/house-detail/house-detail.component';
import { BillListComponent } from '@app/freebank/pages/bill-list/bill-list.component';
import { BillDetailComponent } from '@app/freebank/pages/bill-detail/bill-detail.component';
import { PoolListComponent } from '@app/freebank/pages/pool-list/pool-list.component';
import { PoolDetailComponent } from '@app/freebank/pages/pool-detail/pool-detail.component';
import { GoldFixComponent } from '@app/freebank/pages/gold-fix/gold-fix.component';
import { AssetListComponent } from '@app/freebank/pages/asset-list/asset-list.component';
import { AssetDetailComponent } from '@app/freebank/pages/asset-detail/asset-detail.component';

// The FreeBank credit pages. Lazy-loaded by master-page.module.ts, which mounts this module at
// the root of the master page (so /credit, /regtest/credit, ...) and only for URLs whose first
// segment is in CREDIT_ROOT_SEGMENTS (freebank/credit-paths.ts) - keep that list in step with
// the paths below. Detail pages are networkSpecific: house 1 on one network is not house 1 on
// another, so the network switcher drops the id (see services/navigation.service.ts).

const routes: Routes = [
  {
    path: 'credit',
    component: CreditOverviewComponent,
  },
  {
    path: 'houses',
    component: HouseListComponent,
  },
  {
    path: 'house/:id',
    component: HouseDetailComponent,
    data: { networkSpecific: true },
  },
  {
    path: 'bills',
    component: BillListComponent,
  },
  {
    path: 'bill/:id',
    component: BillDetailComponent,
    data: { networkSpecific: true },
  },
  {
    path: 'pools',
    component: PoolListComponent,
  },
  {
    path: 'pool/:id',
    component: PoolDetailComponent,
    data: { networkSpecific: true },
  },
  {
    path: 'assets',
    component: AssetListComponent,
  },
  {
    path: 'asset/:id',
    component: AssetDetailComponent,
    data: { networkSpecific: true },
  },
  {
    path: 'gold',
    component: GoldFixComponent,
    // FreeBank: no gold fix while gold is not shown (gold-display.ts); an old link lands on /credit
    canActivate: [() => GOLD_SHOWN || inject(Router).parseUrl('/credit')],
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
export class CreditRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    CreditRoutingModule,
    SharedModule,
    CreditSharedModule,
  ],
  declarations: [
    CreditRawJsonComponent,
    CreditOverviewComponent,
    HouseListComponent,
    HouseDetailComponent,
    BillListComponent,
    BillDetailComponent,
    PoolListComponent,
    PoolDetailComponent,
    GoldFixComponent,
    AssetListComponent,
    AssetDetailComponent,
  ]
})
export class CreditModule { }
