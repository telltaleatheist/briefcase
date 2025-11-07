// clippy/frontend/src/app/app-routing.module.ts
import { NgModule } from '@angular/core';
import { RouterModule, Routes, PreloadAllModules } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'library',
    pathMatch: 'full'
  },
  {
    path: 'batch',
    loadComponent: () => import('./components/batch-download/batch-download.component').then(m => m.BatchDownloadComponent)
  },
  {
    path: 'analysis',
    loadComponent: () => import('./components/video-analysis/video-analysis.component').then(m => m.VideoAnalysisComponent)
  },
  {
    path: 'reports',
    loadComponent: () => import('./components/analysis-reports/analysis-reports.component').then(m => m.AnalysisReportsComponent)
  },
  {
    path: 'library',
    loadComponent: () => import('./components/library/library.component').then(m => m.LibraryComponent)
  },
  {
    path: 'normalize',
    loadComponent: () => import('./components/audio-normalize/audio-normalize.component').then(m => m.AudioNormalizeComponent)
  },
  {
    path: 'settings',
    loadComponent: () => import('./components/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    path: 'video-editor',
    loadComponent: () => import('./components/video-player/video-player.component').then(m => m.VideoPlayerComponent)
  },
  {
    path: '**',
    redirectTo: 'library'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    useHash: true,
    preloadingStrategy: PreloadAllModules  // Preload all lazy-loaded modules
  })],
  exports: [RouterModule]
})
export class AppRoutingModule { }