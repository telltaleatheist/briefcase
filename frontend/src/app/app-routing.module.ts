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
    path: 'single',
    loadComponent: () => import('./components/download-form/download-form.component').then(m => m.DownloadFormComponent)
  },
  {
    path: 'batch',
    loadComponent: () => import('./components/batch-download/batch-download.component').then(m => m.BatchDownloadComponent)
  },
  {
    path: 'settings',
    loadComponent: () => import('./components/settings/settings.component').then(m => m.SettingsComponent)
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