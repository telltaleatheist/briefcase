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
    path: 'batch-downloads',
    loadComponent: () => import('./components/batch-download/batch-download.component').then(m => m.BatchDownloadComponent)
  },
  {
    path: 'bulk-analysis',
    loadComponent: () => import('./components/bulk-analysis/bulk-analysis.component').then(m => m.BulkAnalysisComponent)
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
    path: 'library-management',
    loadComponent: () => import('./components/library-management/library-management.component').then(m => m.LibraryManagementComponent)
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
    path: 'analysis-parameters',
    loadComponent: () => import('./components/analysis-parameters/analysis-parameters.component').then(m => m.AnalysisParametersComponent)
  },
  {
    path: 'saved-links',
    loadComponent: () => import('./components/saved-links/saved-links.component').then(m => m.SavedLinksComponent)
  },
  {
    path: 'video-info/:id',
    loadComponent: () => import('./components/video-info/video-info.component').then(m => m.VideoInfoComponent)
  },
  {
    path: 'video-editor',
    loadComponent: () => import('./components/video-player/video-player.component').then(m => m.VideoPlayerComponent)
  },
  {
    path: 'database-migration',
    loadComponent: () => import('./components/database-migration-wizard/database-migration-wizard.component').then(m => m.DatabaseMigrationWizardComponent)
  },
  {
    path: 'relink',
    loadComponent: () => import('./components/relinking-tool/relinking-tool.component').then(m => m.RelinkingToolComponent)
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