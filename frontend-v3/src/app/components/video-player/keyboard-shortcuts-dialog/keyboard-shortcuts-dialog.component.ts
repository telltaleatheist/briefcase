import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

interface Shortcut {
  keys: string[];
  description: string;
}

@Component({
  selector: 'app-keyboard-shortcuts-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="dialog-overlay" (click)="onOverlayClick($event)">
      <div class="dialog-container" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <h2>Keyboard Shortcuts</h2>
          <button class="close-btn" (click)="close.emit()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="dialog-content">
          <div class="shortcut-groups">
            @for (group of shortcutGroups; track group.title) {
              <div class="shortcut-group">
                <h3>{{ group.title }}</h3>
                <div class="shortcuts-list">
                  @for (shortcut of group.shortcuts; track shortcut.description) {
                    <div class="shortcut-row">
                      <div class="keys">
                        @for (key of shortcut.keys; track key; let last = $last) {
                          <kbd>{{ key }}</kbd>
                          @if (!last) {
                            <span class="separator">+</span>
                          }
                        }
                      </div>
                      <div class="description">{{ shortcut.description }}</div>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        </div>

        <div class="dialog-footer">
          <span class="hint">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .dialog-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      backdrop-filter: blur(4px);
    }

    .dialog-container {
      background: #1e1e1e;
      border: 1px solid #3a3a3a;
      border-radius: 12px;
      max-width: 700px;
      width: 90%;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid #3a3a3a;
    }

    .dialog-header h2 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: #fff;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: #888;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .close-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }

    .dialog-content {
      padding: 24px;
      overflow-y: auto;
      flex: 1;
    }

    .shortcut-groups {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
    }

    .shortcut-group h3 {
      margin: 0 0 12px 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: #ff6b35;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .shortcuts-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .shortcut-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .shortcut-row:last-child {
      border-bottom: none;
    }

    .keys {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 28px;
      padding: 0 8px;
      background: linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%);
      border: 1px solid #4a4a4a;
      border-radius: 6px;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      color: #fff;
      box-shadow: 0 2px 0 #1a1a1a;
    }

    .separator {
      color: #666;
      font-size: 0.75rem;
    }

    .description {
      color: #aaa;
      font-size: 0.875rem;
      text-align: right;
    }

    .dialog-footer {
      padding: 16px 24px;
      border-top: 1px solid #3a3a3a;
      text-align: center;
    }

    .hint {
      color: #666;
      font-size: 0.8rem;
    }

    .hint kbd {
      min-width: 24px;
      height: 22px;
      padding: 0 6px;
      font-size: 0.7rem;
    }
  `]
})
export class KeyboardShortcutsDialogComponent {
  @Output() close = new EventEmitter<void>();

  shortcutGroups: ShortcutGroup[] = [
    {
      title: 'Playback',
      shortcuts: [
        { keys: ['Space'], description: 'Play / Pause' },
        { keys: ['K'], description: 'Pause' },
        { keys: ['L'], description: 'Play forward (tap for speed)' },
        { keys: ['J'], description: 'Play backward (tap for speed)' },
        { keys: ['\u2190'], description: 'Skip back 5 seconds' },
        { keys: ['\u2192'], description: 'Skip forward 5 seconds' },
      ]
    },
    {
      title: 'Tools',
      shortcuts: [
        { keys: ['A'], description: 'Cursor tool (seek)' },
        { keys: ['R'], description: 'Range/highlight tool' },
        { keys: ['M'], description: 'Add marker at playhead' },
        { keys: ['Shift', 'M'], description: 'Add marker for selection' },
      ]
    },
    {
      title: 'Selection',
      shortcuts: [
        { keys: ['I'], description: 'Set in point' },
        { keys: ['O'], description: 'Set out point' },
        { keys: ['X'], description: 'Ripple cut selection' },
        { keys: ['Esc'], description: 'Clear selection / Close dialog' },
      ]
    },
    {
      title: 'View',
      shortcuts: [
        { keys: ['F'], description: 'Toggle fullscreen' },
        { keys: ['Ctrl', '+'], description: 'Zoom in timeline' },
        { keys: ['Ctrl', '-'], description: 'Zoom out timeline' },
        { keys: ['Ctrl', '0'], description: 'Reset zoom' },
      ]
    },
    {
      title: 'Export',
      shortcuts: [
        { keys: ['Ctrl', 'E'], description: 'Open export dialog' },
      ]
    },
    {
      title: 'Help',
      shortcuts: [
        { keys: ['?'], description: 'Show keyboard shortcuts' },
      ]
    }
  ];

  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close.emit();
    }
  }
}
