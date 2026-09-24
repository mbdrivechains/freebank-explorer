import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { FreebankApiDocsComponent } from '@app/freebank/pages/api-docs/api-docs.component';

// The FreeBank explorer's REST API documentation (/docs/api/rest; /docs, /docs/api and /api redirect here).
// Lazy-loaded by master-page.module.ts, its own small chunk.

const routes: Routes = [
  {
    path: '',
    component: FreebankApiDocsComponent,
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
export class FreebankApiDocsRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    FreebankApiDocsRoutingModule,
    SharedModule,
  ],
  declarations: [
    FreebankApiDocsComponent,
  ]
})
export class FreebankApiDocsModule { }
