import { Component, EventEmitter, Output, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

interface Shortcut {
  keys: string[];
  description: string;
}

interface SearchSyntax {
  example: string;
  description: string;
}

@Component({
  selector: 'app-library-shortcuts-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="dialog-overlay" (click)="onOverlayClick($event)">
      <div class="dialog-container" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <h2>Keyboard Shortcuts & Search Help</h2>
          <button class="close-btn" (click)="close.emit()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="dialog-content">
          <!-- Search Syntax Section -->
          <div class="section search-section">
            <h3 class="section-title">Search Syntax</h3>
            <div class="search-examples">
              @for (item of searchSyntax; track item.example) {
                <div class="search-row">
                  <code class="search-example">{{ item.example }}</code>
                  <span class="search-desc">{{ item.description }}</span>
                </div>
              }
            </div>
            <div class="search-notes">
              <p><strong>Note:</strong> Search is case-insensitive. Only uppercase <code>OR</code> is treated as an operator.</p>
            </div>
          </div>

          <!-- Keyboard Shortcuts Section -->
          <div class="section shortcuts-section">
            <h3 class="section-title">Keyboard Shortcuts</h3>
            <div class="shortcut-groups">
              @for (group of shortcutGroups; track group.title) {
                <div class="shortcut-group">
                  <h4>{{ group.title }}</h4>
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
      max-width: 800px;
      width: 90%;
      max-height: 85vh;
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
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    .section-title {
      margin: 0 0 16px 0;
      font-size: 1rem;
      font-weight: 600;
      color: #ff6b35;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 107, 53, 0.3);
    }

    /* Search Syntax Styles */
    .search-examples {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .search-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 6px;
    }

    .search-example {
      flex-shrink: 0;
      min-width: 200px;
      padding: 6px 10px;
      background: #2a2a2a;
      border: 1px solid #3a3a3a;
      border-radius: 4px;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      font-size: 0.85rem;
      color: #4fc3f7;
    }

    .search-desc {
      color: #aaa;
      font-size: 0.875rem;
    }

    .search-notes {
      margin-top: 16px;
      padding: 12px 16px;
      background: rgba(255, 193, 7, 0.1);
      border: 1px solid rgba(255, 193, 7, 0.2);
      border-radius: 6px;
    }

    .search-notes p {
      margin: 0;
      color: #ccc;
      font-size: 0.85rem;
    }

    .search-notes code {
      padding: 2px 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      color: #4fc3f7;
    }

    .search-notes strong {
      color: #ffc107;
    }

    /* Keyboard Shortcuts Styles */
    .shortcut-groups {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 24px;
    }

    .shortcut-group h4 {
      margin: 0 0 12px 0;
      font-size: 0.8rem;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .shortcuts-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .shortcut-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
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
      min-width: 26px;
      height: 26px;
      padding: 0 8px;
      background: linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%);
      border: 1px solid #4a4a4a;
      border-radius: 5px;
      font-family: inherit;
      font-size: 0.75rem;
      font-weight: 500;
      color: #fff;
      box-shadow: 0 2px 0 #1a1a1a;
    }

    .separator {
      color: #666;
      font-size: 0.7rem;
    }

    .description {
      color: #aaa;
      font-size: 0.8rem;
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
      min-width: 22px;
      height: 20px;
      padding: 0 6px;
      font-size: 0.65rem;
    }
  `]
})
export class LibraryShortcutsDialogComponent {
  @Output() close = new EventEmitter<void>();

  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      this.close.emit();
    }
  }

  searchSyntax: SearchSyntax[] = [
    { example: 'word1 word2', description: 'All words must match (AND)' },
    { example: '"exact phrase"', description: 'Match exact phrase in quotes' },
    { example: 'word1 OR word2', description: 'Match either word (uppercase OR)' },
    { example: '-exclude', description: 'Exclude results containing this word' },
    { example: 'test*', description: 'Wildcard: matches testing, tests, etc.' },
    { example: 'congress -senate', description: 'Combine: has "congress" but not "senate"' },
  ];

  shortcutGroups: ShortcutGroup[] = [
    {
      title: 'Navigation',
      shortcuts: [
        { keys: ['?'], description: 'Show this help' },
        { keys: ['/'], description: 'Focus search box' },
        { keys: ['Esc'], description: 'Close dialogs / Clear selection' },
      ]
    },
    {
      title: 'Selection',
      shortcuts: [
        { keys: ['Ctrl', 'A'], description: 'Select all visible' },
        { keys: ['Click'], description: 'Select single item' },
        { keys: ['Ctrl', 'Click'], description: 'Toggle item selection' },
        { keys: ['Shift', 'Click'], description: 'Select range' },
      ]
    },
    {
      title: 'Actions',
      shortcuts: [
        { keys: ['Enter'], description: 'Open selected in editor' },
        { keys: ['Space'], description: 'Preview selected' },
        { keys: ['Delete'], description: 'Delete selected' },
      ]
    },
  ];

  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close.emit();
    }
  }
}
