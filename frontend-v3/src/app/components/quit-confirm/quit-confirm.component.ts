import { Component, NgZone, OnDestroy, OnInit, inject, signal } from '@angular/core';

/**
 * Chrome-style "press ⌘Q again to quit" toast.
 *
 * The Electron main process intercepts the first quit request, cancels it,
 * and emits 'quit-confirm-show'/'quit-confirm-hide' (forwarded by the preload
 * script as window CustomEvents). A second quit press within 5s actually
 * quits; otherwise the toast disappears and the next press starts over.
 */
@Component({
  selector: 'app-quit-confirm',
  standalone: true,
  template: `
    @if (visible()) {
      <div class="quit-confirm-toast" role="status" aria-live="polite">
        {{ label() }}
      </div>
    }
  `,
  styles: [`
    .quit-confirm-toast {
      position: fixed;
      left: 50%;
      bottom: 48px;
      transform: translateX(-50%);
      z-index: 100000;
      padding: 12px 22px;
      border-radius: 999px;
      background: rgba(20, 20, 20, 0.92);
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: 0.2px;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: quit-confirm-in 0.18s ease-out;
    }

    @keyframes quit-confirm-in {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
  `]
})
export class QuitConfirmComponent implements OnInit, OnDestroy {
  private zone = inject(NgZone);

  visible = signal(false);
  label = signal('Press ⌘Q again to quit');

  private safetyTimer?: any;

  private readonly showHandler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    this.zone.run(() => {
      if (detail?.label) {
        this.label.set(detail.label);
      }
      this.visible.set(true);

      // Safety net in case the main process 'hide' event is missed.
      clearTimeout(this.safetyTimer);
      this.safetyTimer = setTimeout(() => this.zone.run(() => this.visible.set(false)), 5500);
    });
  };

  private readonly hideHandler = () => {
    this.zone.run(() => {
      clearTimeout(this.safetyTimer);
      this.visible.set(false);
    });
  };

  ngOnInit(): void {
    window.addEventListener('electron-quit-confirm-show', this.showHandler);
    window.addEventListener('electron-quit-confirm-hide', this.hideHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('electron-quit-confirm-show', this.showHandler);
    window.removeEventListener('electron-quit-confirm-hide', this.hideHandler);
    clearTimeout(this.safetyTimer);
  }
}
