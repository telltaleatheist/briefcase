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
    loadComponent: () => import('./components/video-player/video-player.component').then(m => m.VideoPlayerComponent),
    title: 'Video Editor | ClipChimp'
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
