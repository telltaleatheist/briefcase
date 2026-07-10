import { Routes } from '@angular/router';

/**
 * Shell-parent routing: AppShellComponent owns the chrome (sidebar/toolbar/
 * inspector); destinations render in its outlet.
 *
 * The library/queue/collections/manager/saved/archives routes all load the
 * persistent workspace host (LibraryPageComponent) and carry
 * `data.reuseKey: 'workspace'` so WorkspaceReuseStrategy keeps ONE instance
 * alive across them — the URL (data.section) tells it which view to show.
 *
 * Temporary routes (slated for later phases): manager/saved/archives live
 * under the sidebar "More" disclosure until they're folded into Settings,
 * deleted, or become a Library type-filter respectively.
 */
const workspace = () =>
  import('./pages/library/library-page.component').then(m => m.LibraryPageComponent);

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./shell/app-shell.component').then(m => m.AppShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'library' },
      {
        path: 'library',
        loadComponent: workspace,
        data: { section: 'library', reuseKey: 'workspace' },
        title: 'Media Library | Briefcase'
      },
      {
        path: 'queue',
        loadComponent: workspace,
        data: { section: 'queue', reuseKey: 'workspace' },
        title: 'Queue | Briefcase'
      },
      {
        path: 'collections',
        loadComponent: workspace,
        data: { section: 'tabs', reuseKey: 'workspace' },
        title: 'Collections | Briefcase'
      },
      {
        path: 'collections/:id',
        loadComponent: workspace,
        data: { section: 'tabs', reuseKey: 'workspace' },
        title: 'Collections | Briefcase'
      },
      // Temporary destinations (later phases fold/delete these)
      {
        path: 'manager',
        loadComponent: workspace,
        data: { section: 'manager', reuseKey: 'workspace' },
        title: 'Library Manager | Briefcase'
      },
      {
        path: 'saved',
        loadComponent: workspace,
        data: { section: 'saved', reuseKey: 'workspace' },
        title: 'Saved | Briefcase'
      },
      {
        path: 'archives',
        loadComponent: workspace,
        data: { section: 'archives', reuseKey: 'workspace' },
        title: 'Web Archives | Briefcase'
      },
      {
        path: 'settings',
        loadComponent: () => import('./pages/settings/settings-page.component').then(m => m.SettingsPageComponent),
        title: 'Settings | Briefcase'
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
    ]
  },
  {
    path: '**',
    redirectTo: ''
  }
];
