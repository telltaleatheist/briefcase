import { Component, EventEmitter, Input, Output, signal, effect, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-trim-opener-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (visible()) {
      <div class="modal-overlay" (click)="close()" (mousedown)="$event.stopPropagation()">
        <div class="modal-dialog" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3 class="modal-title">Set Trim Point</h3>
            <button class="modal-close" (click)="close()">&times;</button>
          </div>

          <div class="modal-body">
            @if (videoTitle) {
              <div class="video-name">{{ videoTitle }}</div>
            }
            <p class="modal-description">Everything before this timecode will be trimmed after download.</p>

            <div class="timecode-group">
              <div class="timecode-field">
                <label>HH</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  [(ngModel)]="hours"
                  (keydown)="onKeyDown($event)"
                  #hoursInput
                />
              </div>
              <span class="timecode-sep">:</span>
              <div class="timecode-field">
                <label>MM</label>
                <input
                  type="number"
                  min="0"
                  max="59"
                  [(ngModel)]="minutes"
                  (keydown)="onKeyDown($event)"
                />
              </div>
              <span class="timecode-sep">:</span>
              <div class="timecode-field">
                <label>SS</label>
                <input
                  type="number"
                  min="0"
                  max="59"
                  [(ngModel)]="seconds"
                  (keydown)="onKeyDown($event)"
                />
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary" (click)="close()">Cancel</button>
            @if (isEditing) {
              <button class="btn btn-outline" (click)="clearTrim()">Clear Trim</button>
            }
            <button class="btn btn-primary" (click)="save()" [disabled]="totalSeconds() === 0">Set Trim Point</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-dialog {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 24px;
      max-width: 380px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      border: 2px solid var(--border-color);
      animation: slideUp 0.3s ease-out;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .modal-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }

    .modal-close {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: transparent;
      border: none;
      font-size: 20px;
      color: var(--text-tertiary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .modal-close:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .modal-body {
      margin-bottom: 20px;
    }

    .video-name {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .modal-description {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 0 0 16px 0;
    }

    .timecode-group {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 4px;
    }

    .timecode-field {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;

      label {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      input {
        width: 64px;
        height: 48px;
        text-align: center;
        font-size: 24px;
        font-weight: 600;
        font-family: monospace;
        background: var(--bg-secondary);
        border: 2px solid var(--border-color);
        border-radius: 8px;
        color: var(--text-primary);
        outline: none;
        transition: border-color 0.15s;
        -moz-appearance: textfield;

        &::-webkit-inner-spin-button,
        &::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        &:focus {
          border-color: var(--primary-orange);
        }
      }
    }

    .timecode-sep {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-tertiary);
      padding-bottom: 8px;
    }

    .modal-footer {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      border: 2px solid transparent;
    }

    .btn-secondary {
      background: transparent;
      border-color: var(--border-color);
      color: var(--text-secondary);

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    }

    .btn-outline {
      background: transparent;
      border-color: var(--primary-orange);
      color: var(--primary-orange);

      &:hover {
        background: rgba(255, 107, 53, 0.1);
      }
    }

    .btn-primary {
      background: var(--primary-orange);
      border-color: var(--primary-orange);
      color: white;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }
  `]
})
export class TrimOpenerModalComponent {
  @Input() videoTitle = '';
  @Input() isEditing = false;

  @Input() set show(value: boolean) {
    this.visible.set(value);
  }

  @Input() set initialTime(seconds: number | undefined) {
    if (seconds != null && seconds > 0) {
      this.hours = Math.floor(seconds / 3600);
      this.minutes = Math.floor((seconds % 3600) / 60);
      this.seconds = Math.floor(seconds % 60);
    } else {
      this.hours = 0;
      this.minutes = 0;
      this.seconds = 0;
    }
  }

  @Output() saved = new EventEmitter<number>();
  @Output() cleared = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('hoursInput') hoursInput?: ElementRef<HTMLInputElement>;

  visible = signal(false);
  hours = 0;
  minutes = 0;
  seconds = 0;

  constructor() {
    effect(() => {
      if (this.visible()) {
        setTimeout(() => this.hoursInput?.nativeElement?.focus(), 50);
      }
    });
  }

  totalSeconds(): number {
    return (this.hours || 0) * 3600 + (this.minutes || 0) * 60 + (this.seconds || 0);
  }

  save(): void {
    const total = this.totalSeconds();
    if (total > 0) {
      this.saved.emit(total);
      this.visible.set(false);
    }
  }

  clearTrim(): void {
    this.cleared.emit();
    this.visible.set(false);
  }

  close(): void {
    this.closed.emit();
    this.visible.set(false);
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }
}
