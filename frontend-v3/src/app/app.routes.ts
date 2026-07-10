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
        loadComponent: () => import('./pages/settings/settings-layout.component').then(m => m.SettingsLayoutComponent),
        title: 'Settings | Briefcase',
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'general' },
          {
            path: 'general',
            loadComponent: () => import('./pages/settings/panes/general-pane.component').then(m => m.GeneralPaneComponent),
            title: 'General Settings | Briefcase'
          },
          {
            path: 'libraries',
            loadComponent: () => import('./pages/settings/panes/libraries-pane.component').then(m => m.LibrariesPaneComponent),
            title: 'Libraries | Briefcase'
          },
          {
            path: 'downloads',
            loadComponent: () => import('./pages/settings/panes/downloads-pane.component').then(m => m.DownloadsPaneComponent),
            title: 'Download Settings | Briefcase'
          },
          {
            path: 'transcription',
            loadComponent: () => import('./pages/settings/panes/transcription-pane.component').then(m => m.TranscriptionPaneComponent),
            title: 'Transcription Settings | Briefcase'
          },
          {
            path: 'ai',
            loadComponent: () => import('./pages/settings/panes/ai-pane.component').then(m => m.AiPaneComponent),
            title: 'AI Settings | Briefcase'
          },
          {
            path: 'components',
            loadComponent: () => import('./pages/settings/panes/components-pane.component').then(m => m.ComponentsPaneComponent),
            title: 'Components | Briefcase'
          },
        ]
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
