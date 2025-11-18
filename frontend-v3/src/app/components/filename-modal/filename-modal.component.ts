import { Component, EventEmitter, Input, Output, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../button/button.component';

@Component({
  selector: 'app-filename-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  template: `
    @if (visible()) {
      <div class="modal-overlay" (click)="onOverlayClick($event)">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3 class="modal-title">Edit Filename</h3>
            <button class="modal-close" (click)="close()">×</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Original Name</label>
              <div class="original-name">{{ originalName() }}</div>
            </div>

            <div class="form-group">
              <label class="form-label">Suggested Filename</label>
              <input
                type="text"
                class="form-input"
                [(ngModel)]="editedFilename"
                (keydown.enter)="save()"
                (keydown.escape)="close()"
                #filenameInput
              />
              <div class="form-hint">
                Press Enter to save, Esc to cancel
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <app-button variant="secondary" (click)="close()">
              Cancel
            </app-button>
            <app-button variant="gradient" icon="💾" (click)="save()">
              Save Filename
            </app-button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: var(--bg-overlay);
      backdrop-filter: blur(8px);
      z-index: $z-modal;
      @include flex-center;
      animation: fadeIn 0.2s ease-out;
    }

    .modal-dialog {
      background: var(--bg-card);
      border-radius: $radius-xl;
      box-shadow: $shadow-2xl;
      max-width: 600px;
      width: 90%;
      max-height: 90vh;
      overflow: hidden;
      animation: scaleIn 0.3s ease-out;
    }

    .modal-header {
      @include flex-between;
      padding: $spacing-lg $spacing-xl;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .modal-title {
      font-size: $font-size-xl;
      font-weight: $font-weight-bold;
      color: var(--text-primary);
      margin: 0;
    }

    .modal-close {
      width: 32px;
      height: 32px;
      border-radius: $radius-full;
      background: transparent;
      border: none;
      font-size: $font-size-2xl;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all $transition-fast;
      @include flex-center;

      &:hover {
        background: var(--bg-tertiary);
        color: var(--error);
        transform: rotate(90deg);
      }
    }

    .modal-body {
      padding: $spacing-xl;
    }

    .form-group {
      margin-bottom: $spacing-lg;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .form-label {
      display: block;
      font-size: $font-size-sm;
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
      margin-bottom: $spacing-sm;
    }

    .original-name {
      padding: $spacing-md;
      background: var(--bg-secondary);
      border-radius: $radius-md;
      font-size: $font-size-sm;
      color: var(--text-secondary);
      font-family: 'Monaco', monospace;
      word-break: break-all;
    }

    .form-input {
      width: 100%;
      padding: $spacing-md;
      background: var(--bg-input);
      border: 2px solid var(--border-color);
      border-radius: $radius-md;
      font-size: $font-size-base;
      color: var(--text-primary);
      font-family: 'Monaco', monospace;
      transition: all $transition-fast;

      &:focus {
        outline: none;
        border-color: var(--primary-orange);
        box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.1);
      }
    }

    .form-hint {
      margin-top: $spacing-xs;
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      font-style: italic;
    }

    .modal-footer {
      @include flex-center;
      justify-content: flex-end;
      gap: $spacing-md;
      padding: $spacing-lg $spacing-xl;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }
  `]
})
export class FilenameModalComponent {
  @Input() set show(value: boolean) {
    this.visible.set(value);
  }
  @Input() set filename(value: string) {
    this.suggestedFilename.set(value);
    this.editedFilename = value;
  }
  @Input() set original(value: string) {
    this.originalName.set(value);
  }

  @Output() saved = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  visible = signal(false);
  suggestedFilename = signal('');
  originalName = signal('');
  editedFilename = '';

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.editedFilename = this.suggestedFilename();
      }
    });
  }

  save() {
    if (this.editedFilename.trim()) {
      this.saved.emit(this.editedFilename.trim());
      this.close();
    }
  }

  close() {
    this.visible.set(false);
    this.closed.emit();
  }

  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }
}
