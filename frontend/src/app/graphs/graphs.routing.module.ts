import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { BlockHealthGraphComponent } from '@components/block-health-graph/block-health-graph.component';
import { BlockFeeRatesGraphComponent } from '@components/block-fee-rates-graph/block-fee-rates-graph.component';
import { BlockFeesGraphComponent } from '@components/block-fees-graph/block-fees-graph.component';
import { BlockFeesSubsidyGraphComponent } from '@components/block-fees-subsidy-graph/block-fees-subsidy-graph.component';
import { BlockRewardsGraphComponent } from '@components/block-rewards-graph/block-rewards-graph.component';
import { BlockSizesWeightsGraphComponent } from '@components/block-sizes-weights-graph/block-sizes-weights-graph.component';
import { GraphsComponent } from '@components/graphs/graphs.component';
import { HashrateChartComponent } from '@components/hashrate-chart/hashrate-chart.component';
import { HashrateChartPoolsComponent } from '@components/hashrates-chart-pools/hashrate-chart-pools.component';
import { MempoolBlockComponent } from '@components/mempool-block/mempool-block.component';
import { MiningDashboardComponent } from '@components/mining-dashboard/mining-dashboard.component';
import { PoolRankingComponent } from '@components/pool-ranking/pool-ranking.component';
import { PoolComponent } from '@components/pool/pool.component';
import { StartComponent } from '@components/start/start.component';
import { StatisticsComponent } from '@components/statistics/statistics.component';
import { DashboardComponent } from '@app/dashboard/dashboard.component';
import { CustomDashboardComponent } from '@components/custom-dashboard/custom-dashboard.component';
import { AddressComponent } from '@components/address/address.component';

const browserWindow = window || {};
// @ts-ignore
const browserWindowEnv = browserWindow.__env || {};
const isCustomized = browserWindowEnv?.customize?.dashboard;
// FreeBank Explorer: no proof of work and no mining pools, so the mining dashboard,
// pool pages and mining graphs only exist when MINING_DASHBOARD is on.
const miningDashboard = !!browserWindowEnv.MINING_DASHBOARD;

const routes: Routes = [
  {
    path: '',
    children: [
      ...(miningDashboard ? [
        {
          path: 'mining/pool/:slug',
          data: { networks: ['bitcoin'] },
          component: PoolComponent,
        },
        {
          path: 'mining',
          data: { networks: ['bitcoin'] },
          component: StartComponent,
          children: [
            {
              path: '',
              component: MiningDashboardComponent,
            },
          ]
        },
      ] : []),
      {
        path: 'mempool-block/:id',
        data: { networks: ['bitcoin', 'liquid'] },
        component: StartComponent,
        children: [
          {
            path: '',
            component: MempoolBlockComponent,
          },
        ]
      },
      {
        path: 'address/:id',
        children: [],
        component: AddressComponent,
        data: {
          ogImage: true,
          networkSpecific: true,
        }
      },
      {
        path: 'graphs',
        data: { networks: ['bitcoin', 'liquid'] },
        component: GraphsComponent,
        children: [
          {
            path: 'mempool',
            data: { networks: ['bitcoin', 'liquid'] },
            component: StatisticsComponent,
          },
          ...(miningDashboard ? [
            {
              path: 'mining/hashrate-difficulty',
              data: { networks: ['bitcoin'] },
              component: HashrateChartComponent,
            },
            {
              path: 'mining/pools-dominance',
              data: { networks: ['bitcoin'] },
              component: HashrateChartPoolsComponent,
            },
            {
              path: 'mining/pools',
              data: { networks: ['bitcoin'] },
              component: PoolRankingComponent,
            },
            {
              path: 'mining/block-fees',
              data: { networks: ['bitcoin'] },
              component: BlockFeesGraphComponent,
            },
            {
              path: 'mining/block-fees-subsidy',
              data: { networks: ['bitcoin'] },
              component: BlockFeesSubsidyGraphComponent,
            },
            {
              path: 'mining/block-rewards',
              data: { networks: ['bitcoin'] },
              component: BlockRewardsGraphComponent,
            },
            {
              path: 'mining/block-fee-rates',
              data: { networks: ['bitcoin'] },
              component: BlockFeeRatesGraphComponent,
            },
            {
              path: 'mining/block-sizes-weights',
              data: { networks: ['bitcoin'] },
              component: BlockSizesWeightsGraphComponent,
            },
          ] : []),
          {
            path: '',
            pathMatch: 'full',
            redirectTo: 'mempool',
          },
          ...(miningDashboard ? [
            {
              path: 'mining/block-health',
              data: { networks: ['bitcoin'] },
              component: BlockHealthGraphComponent,
            },
          ] : []),
        ]
      },
      {
        path: '',
        component: StartComponent,
        children: [{
          path: '',
          component: isCustomized ? CustomDashboardComponent : DashboardComponent,
        }]
      },
    ]
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
})
export class GraphsRoutingModule { }
