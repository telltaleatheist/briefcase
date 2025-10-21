// clippy/frontend/src/app/app-routing.module.ts
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'batch',
    pathMatch: 'full'
  },
  {
    path: 'batch',
    loadComponent: () => import('./components/batch-download/batch-download.component').then(m => m.BatchDownloadComponent)
  },
  {
    path: 'normalize',
    loadComponent: () => import('./components/audio-normalize/audio-normalize.component').then(m => m.AudioNormalizeComponent)
  },
  {
    path: '**',
    redirectTo: 'batch'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }