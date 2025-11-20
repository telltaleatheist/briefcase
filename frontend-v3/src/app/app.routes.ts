import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/library/library-page.component').then(m => m.LibraryPageComponent),
    title: 'Media Library | ClipChimp'
  },
  {
    path: 'library',
    loadComponent: () => import('./pages/library/library-page.component').then(m => m.LibraryPageComponent),
    title: 'Media Library | ClipChimp'
  },
  {
    path: 'editor',
    loadComponent: () => import('./components/video-editor/video-editor.component').then(m => m.VideoEditorComponent),
    title: 'Video Editor | ClipChimp'
  },
  {
    path: 'video/:id',
    loadComponent: () => import('./components/video-info-page/video-info-page.component').then(m => m.VideoInfoPageComponent),
    title: 'Video Info | ClipChimp'
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings-page.component').then(m => m.SettingsPageComponent),
    title: 'Settings | ClipChimp'
  },
  {
    path: '**',
    redirectTo: '',
    pathMatch: 'full'
  }
];
