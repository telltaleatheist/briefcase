import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Library } from '../../../models/library.model';
import { LibraryService } from '../../../services/library.service';
import { ElectronService } from '../../../services/electron.service';
import { NotificationService } from '../../../services/notification.service';
import { ManagerTabComponent } from '../../../components/manager-tab/manager-tab.component';
import { UiButtonComponent } from '../../../ui';

/**
 * Settings → Libraries: everything about libraries in one place.
 *
 * Absorbs the library-manager modal (switch / create / open / edit / delete)
 * and the old Manager tab (maintenance scans). Switching here simply updates
 * LibraryService.currentLibrary — the workspace reloads on next visit because
 * leaving /settings destroys it (reuse strategy only spans workspace routes).
 */
@Component({
  selector: 'app-libraries-pane',
  standalone: true,
  imports: [FormsModule, ManagerTabComponent, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss', './libraries-pane.component.scss'],
  templateUrl: './libraries-pane.component.html'
})
export class LibrariesPaneComponent {
  private libraryService = inject(LibraryService);
  private electronService = inject(ElectronService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  libraries = signal<Library[]>([]);
  busy = signal(false);

  /** Inline edit state. */
  editingId = signal<string | null>(null);
  editName = signal('');
  editPath = signal('');

  /** Create / open form state. */
  createOpen = signal(false);
  newName = signal('');
  newPath = signal('');
  openPath = signal('');

  currentLibrary = computed(() => this.libraryService.currentLibrary());
  isElectron = this.electronService.isElectron;

  /** No-op: the workspace fully reloads when the user navigates back to it. */
  readonly noopRefresh = (): void => undefined;

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.libraryService.getLibraries()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          if (response.success) this.libraries.set(response.data);
        },
        error: () => this.notifications.error('Libraries', 'Failed to load libraries.'),
      });
  }

  isCurrent(library: Library): boolean {
    return this.currentLibrary()?.id === library.id;
  }

  switchTo(library: Library): void {
    if (this.isCurrent(library) || this.busy()) return;
    this.busy.set(true);
    this.libraryService.switchLibrary(library.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.busy.set(false);
          if (response.success) {
            this.notifications.success('Library switched', `Now using “${library.name}”.`);
          }
        },
        error: () => {
          this.busy.set(false);
          this.notifications.error('Switch failed', 'Failed to switch library. Please try again.');
        },
      });
  }

  // ── Edit ────────────────────────────────────────────────────────────────

  startEdit(library: Library): void {
    this.editingId.set(library.id);
    this.editName.set(library.name);
    this.editPath.set(library.path ?? '');
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  editValid(): boolean {
    return this.editName().trim() !== '' && this.editPath().trim() !== '';
  }

  saveEdit(): void {
    const id = this.editingId();
    if (!id || !this.editValid()) return;
    this.libraryService.updateLibrary(id, this.editName().trim(), this.editPath().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          if (response.success) {
            this.editingId.set(null);
            this.reload();
            this.libraryService.refreshLibraries();
          }
        },
        error: () => this.notifications.error('Update failed', 'Failed to update library.'),
      });
  }

  async browseEditPath(): Promise<void> {
    const selected = await this.electronService.selectDirectory();
    if (selected) this.editPath.set(selected);
  }

  // ── Delete ──────────────────────────────────────────────────────────────

  remove(library: Library): void {
    if (this.isCurrent(library)) {
      this.notifications.info('Not removed', 'Switch to another library before removing the active one.');
      return;
    }
    if (!confirm(`Remove “${library.name}” from Briefcase?\n\nThe library folder and its files stay on disk — this only removes it from the list.`)) {
      return;
    }
    this.libraryService.deleteLibrary(library.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          if (response.success) {
            this.reload();
            this.notifications.success('Removed', `“${library.name}” removed.`);
          }
        },
        error: () => this.notifications.error('Remove failed', 'Failed to remove library.'),
      });
  }

  // ── Create / open ───────────────────────────────────────────────────────

  toggleCreate(): void {
    this.createOpen.update(v => !v);
  }

  createValid(): boolean {
    return this.newName().trim() !== '' && this.newPath().trim() !== '';
  }

  create(): void {
    if (!this.createValid() || this.busy()) return;
    this.busy.set(true);
    this.libraryService.createLibrary({ name: this.newName().trim(), path: this.newPath().trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.busy.set(false);
          if (response.success) {
            this.newName.set('');
            this.newPath.set('');
            this.createOpen.set(false);
            this.reload();
            this.notifications.success('Library created', 'The new library is now active.');
          }
        },
        error: () => {
          this.busy.set(false);
          this.notifications.error('Create failed', 'Failed to create library.');
        },
      });
  }

  openExisting(): void {
    const path = this.openPath().trim();
    if (!path || this.busy()) return;
    this.busy.set(true);
    this.libraryService.openLibrary(path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.busy.set(false);
          if (response.success) {
            this.openPath.set('');
            this.reload();
            this.notifications.success('Library opened', 'The opened library is now active.');
          }
        },
        error: error => {
          this.busy.set(false);
          const message = error.error?.error
            ?? 'Failed to open library. Make sure the folder contains a library database.';
          this.notifications.error('Open failed', message);
        },
      });
  }

  async browseNewPath(): Promise<void> {
    const selected = await this.electronService.selectDirectory();
    if (selected) this.newPath.set(selected);
  }

  async browseOpenPath(): Promise<void> {
    const selected = await this.electronService.selectDirectory();
    if (selected) this.openPath.set(selected);
  }
}
