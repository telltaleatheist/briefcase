// clippy/frontend/src/app/app.routes.ts
import { Routes } from '@angular/router';
import { BatchDownloadComponent } from './components/batch-download/batch-download.component';
import { VideoAnalysisComponent } from './components/video-analysis/video-analysis.component';

export const routes: Routes = [
  { path: '', redirectTo: '/batch', pathMatch: 'full' },
  { path: 'batch', component: BatchDownloadComponent },
  { path: 'analysis', component: VideoAnalysisComponent },
  { path: 'normalize', component: BatchDownloadComponent }, // Placeholder - reuses batch for now
];
