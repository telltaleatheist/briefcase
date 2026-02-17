import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/library/library-page.component').then(m => m.LibraryPageComponent),
    title: 'Media Library | Briefcase'
  },
  {
    path: 'library',
    loadComponent: () => import('./pages/library/library-page.component').then(m => m.LibraryPageComponent),
    title: 'Media Library | Briefcase'
  },
  {
    path: 'editor',
    loadComponent: () => import('./components/video-player/video-player.component').then(m => m.VideoPlayerComponent),
    title: 'Video Player | Briefcase'
  },
  {
    path: 'ripplecut',
    loadComponent: () => import('./pages/ripplecut/ripplecut-page.component').then(m => m.RipplecutPageComponent),
    title: 'RippleCut | Briefcase'
  },
  {
    path: 'video/:id',
    loadComponent: () => import('./components/video-info-page/video-info-page.component').then(m => m.VideoInfoPageComponent),
    title: 'Video Info | Briefcase'
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings-page.component').then(m => m.SettingsPageComponent),
    title: 'Settings | Briefcase'
  },
  {
    path: '**',
    redirectTo: '',
    pathMatch: 'full'
  }
];
