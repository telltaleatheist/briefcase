import { Component, EventEmitter, Input, Output, signal, effect, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../button/button.component';

@Component({
  selector: 'app-new-tab-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  template: `
    @if (visible()) {
      <div class="modal-overlay" (click)="onOverlayClick($event)">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3 class="modal-title">Create New Tab</h3>
            <button class="modal-close" (click)="close()">×</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Tab Name</label>
              <input
                #nameInput
                type="text"
                class="form-input"
                [(ngModel)]="tabName"
                [maxlength]="maxLength"
                (keydown.escape)="close()"
                (keydown.enter)="create()"
                placeholder="Enter tab name..."
                autocomplete="off"
              />
              <div class="form-meta">
                <span class="form-hint">Press Enter to create, Esc to cancel</span>
                <span class="char-count" [class.near-limit]="tabName.length > maxLength - 10">
                  {{ tabName.length }}/{{ maxLength }}
                </span>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <app-button variant="secondary" (click)="close()">
              Cancel
            </app-button>
            <app-button
              variant="gradient"
              icon="📑"
              (click)="create()"
              [disabled]="!tabName.trim()">
              Create Tab
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
      max-width: 500px;
      width: 90%;
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

    .form-input {
      width: 100%;
      padding: $spacing-md;
      background: var(--bg-input);
      border: 2px solid var(--border-color);
      border-radius: $radius-md;
      font-size: $font-size-base;
      color: var(--text-primary);
      transition: all $transition-fast;

      &:focus {
        outline: none;
        border-color: var(--primary-orange);
        box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.1);
      }

      &::placeholder {
        color: var(--text-tertiary);
      }
    }

    .form-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: $spacing-xs;
    }

    .form-hint {
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      font-style: italic;
    }

    .char-count {
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      font-family: 'Monaco', monospace;

      &.near-limit {
        color: var(--warning, #f59e0b);
        font-weight: $font-weight-semibold;
      }
    }

    .modal-footer {
      @include flex-center;
      justify-content: flex-end;
      gap: $spacing-md;
      padding: $spacing-lg $spacing-xl;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes scaleIn {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
  `]
})
export class NewTabDialogComponent {
  @Input() set show(value: boolean) {
    this.visible.set(value);
  }

  @Output() created = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('nameInput') nameInput?: ElementRef<HTMLInputElement>;

  visible = signal(false);
  tabName = '';

  // Max tab name length
  maxLength = 100;

  constructor() {
    effect(() => {
      // Auto-focus input when modal opens
      if (this.visible()) {
        setTimeout(() => {
          this.nameInput?.nativeElement.focus();
        }, 100);
      } else {
        // Reset form when closing
        this.tabName = '';
      }
    });
  }

  create() {
    if (this.tabName.trim()) {
      this.created.emit(this.tabName.trim());
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
