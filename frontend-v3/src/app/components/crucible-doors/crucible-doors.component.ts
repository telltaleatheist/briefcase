import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, timer } from 'rxjs';
import type { CruciblePairingPrompt } from '@crucible-wire/connect-wire';
import type { CrucibleCoordinationState } from '@crucible-wire/coordinate-wire';
import type {
  CrucibleEnginePresence,
  CrucibleInstallProgress,
  CrucibleReleaseCheck,
  CrucibleSetupView,
} from '@crucible-wire/install-wire';
import { CrucibleService, type CrucibleRefusal } from '../../services/crucible.service';
import { ElectronService } from '../../services/electron.service';
import { WebsocketService } from '../../services/websocket.service';
import { CrucibleInstallProgressComponent } from '../crucible-install-progress/crucible-install-progress.component';
import { coordinationBusy, coordinationLine, unmetLine } from './crucible-words';

type ConnectMode = 'pair' | 'code';

/**
 * THE CRUCIBLE DOORS, modelled on BookForge's crucible-doors.component.
 *
 * `mode = 'probing'` is the setup wizard's engine step. It reads
 * `GET /crucible/setup` on entry and shows exactly ONE face, chosen by the
 * backend from what is on this computer:
 *
 *  - connected: a server is registered. Nothing to press; what Briefcase needs
 *    is prepared when setup finishes, and the state is drawn here.
 *  - adopt: a Crucible is on this computer (BookForge or Foundry installed it)
 *    and Briefcase has not added it. One button. If it is not running, Start.
 *  - install: nothing here, and this computer can hold one. One sentence about
 *    the machine, Install Crucible, and its progress.
 *  - connect-only: nothing here, and it cannot (an Intel Mac, Linux without
 *    NVIDIA). Says why in one sentence, and offers a Crucible on another computer.
 *
 * Every face also lets the user connect a different server. Skipping is the
 * wizard's own Next: AI is optional, and the rest of Briefcase works without it.
 *
 * `mode = 'settings'` is the local-machine door in Settings › Crucible
 * Servers: install here, start it, update it, and each server's coordination.
 * Adding a server by address or code is the pane's own form there.
 *
 * House style: card toggles (the whole card clicks, orange border when
 * chosen), no emoji.
 */
@Component({
  selector: 'app-crucible-doors',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, CrucibleInstallProgressComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './crucible-doors.component.html',
  styleUrls: ['./crucible-doors.component.scss'],
})
export class CrucibleDoorsComponent implements OnInit {
  @Input() mode: 'probing' | 'settings' = 'probing';
  /** Something changed that the host may want to re-read (a server added, an install finished). */
  @Output() changed = new EventEmitter<void>();

  private readonly crucible = inject(CrucibleService);
  private readonly websocket = inject(WebsocketService);
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = signal<CrucibleSetupView | null>(null);
  readonly error = signal<string | null>(null);
  readonly events = signal<CrucibleInstallProgress[]>([]);
  readonly installing = signal(false);
  readonly refusal = signal<CrucibleRefusal | null>(null);
  readonly busy = signal<'adopt' | 'start' | 'install' | 'release' | null>(null);
  readonly presence = signal<CrucibleEnginePresence | null>(null);
  readonly adoptError = signal<string | null>(null);
  readonly release = signal<CrucibleReleaseCheck | null>(null);
  readonly coordination = signal<Record<string, CrucibleCoordinationState>>({});

  /** The "use a different server" form: open by default only on the connect-only face. */
  readonly connectOpen = signal(false);
  readonly connectMode = signal<ConnectMode>('pair');
  address = '';
  connectCode = '';
  readonly pairing = signal<CruciblePairingPrompt | null>(null);
  readonly connectError = signal<string | null>(null);
  readonly connectBusy = signal(false);
  readonly connectedNote = signal<string | null>(null);
  private pollTimer: Subscription | null = null;

  readonly face = computed(() => this.view()?.face ?? null);
  readonly plan = computed(() => this.view()?.plan ?? null);
  readonly discovered = computed(() => {
    const d = this.view()?.discovered;
    return d?.present === true ? d : null;
  });
  readonly coordinationRows = computed(() => {
    const names = this.view()?.servers ?? [];
    const all = this.coordination();
    return names.map((name) => ({ name, state: all[name] ?? null }));
  });
  readonly held = computed(() => this.view()?.coordinationHeld === true);
  readonly interrupted = computed(() => this.view()?.install.interrupted === true && !this.installing());

  ngOnInit(): void {
    this.reload();
    this.crucible.coordination().subscribe({
      next: (map) => this.coordination.set({ ...map }),
      error: () => undefined,
    });
    const offProgress = this.websocket.onCrucibleInstallProgress((event) => {
      this.events.update((all) => [...all, event].slice(-400));
      if (event.kind === 'done' || event.kind === 'failed') {
        this.installing.set(false);
        if (event.kind === 'failed') this.refusal.set(event.refusal);
        this.reload();
        this.changed.emit();
      }
    });
    const offCoordination = this.websocket.onCrucibleCoordination((state) => {
      this.coordination.update((all) => ({ ...all, [state.server]: state }));
    });
    const offServers = this.websocket.onCrucibleServersChanged(() => this.reload());
    this.destroyRef.onDestroy(() => {
      offProgress();
      offCoordination();
      offServers();
      this.stopPolling();
      const pending = this.pairing();
      if (pending !== null) this.crucible.cancelPairing(pending.requestId).subscribe({ error: () => undefined });
    });
  }

  reload(): void {
    this.crucible.setup().subscribe({
      next: (view) => {
        this.error.set(null);
        this.view.set(view);
        this.installing.set(view.install.running);
        if (view.install.running || this.events().length === 0) this.events.set([...view.install.events]);
        if (view.face === 'connect-only') this.connectOpen.set(true);
        // Settings: a Crucible here that is not in the list may just be stopped.
        if (this.mode === 'settings' && view.discovered.present && view.discovered.registeredAs === null) {
          this.crucible.localPresence().subscribe({ next: (p) => this.presence.set(p), error: () => undefined });
        }
      },
      error: (refusal: CrucibleRefusal) => this.error.set(refusal.message),
    });
  }

  line(state: CrucibleCoordinationState): string {
    return coordinationLine(state);
  }

  moving(state: CrucibleCoordinationState): boolean {
    return coordinationBusy(state);
  }

  unmet(state: CrucibleCoordinationState): string | null {
    return state.phase === 'stocked' || state.phase === 'preparing' || state.phase === 'waiting' ? unmetLine(state.unmet) : null;
  }

  openReadme(): void {
    const url = this.plan()?.readme;
    if (!url) return;
    if (this.electron.isElectron) this.electron.openExternal(url);
    else window.open(url, '_blank');
  }

  // ── install ──────────────────────────────────────────────────────────

  install(): void {
    if (this.busy() !== null || this.installing()) return;
    this.busy.set('install');
    this.refusal.set(null);
    this.events.set([]);
    this.crucible.startInstall().subscribe({
      next: () => {
        this.busy.set(null);
        this.installing.set(true);
      },
      error: (refusal: CrucibleRefusal) => {
        this.busy.set(null);
        this.refusal.set(refusal);
        this.reload();
      },
    });
  }

  checkForUpdate(): void {
    this.busy.set('release');
    this.crucible.checkRelease().subscribe({
      next: (check) => {
        this.busy.set(null);
        this.release.set(check);
      },
      error: (refusal: CrucibleRefusal) => {
        this.busy.set(null);
        this.release.set({ action: 'unknown', refusal: { code: refusal.code, message: refusal.message, command: null, detail: null } });
      },
    });
  }

  // ── adopt and start ──────────────────────────────────────────────────

  adopt(): void {
    if (this.busy() !== null) return;
    this.busy.set('adopt');
    this.adoptError.set(null);
    this.crucible.addDiscovered().subscribe({
      next: () => {
        this.busy.set(null);
        this.reload();
        this.changed.emit();
      },
      error: (refusal: CrucibleRefusal) => {
        this.busy.set(null);
        this.adoptError.set(refusal.message);
        // It may just be stopped: ask its own control, and offer Start if that is the repair.
        this.crucible.localPresence().subscribe({ next: (p) => this.presence.set(p), error: () => undefined });
      },
    });
  }

  startEngine(): void {
    if (this.busy() !== null) return;
    this.busy.set('start');
    this.crucible.startLocal().subscribe({
      next: (outcome) => {
        this.busy.set(null);
        if (!outcome.started) {
          this.adoptError.set(outcome.detail || 'Crucible did not start.');
          return;
        }
        this.presence.set(null);
        this.adoptError.set(null);
        if (outcome.connectedAs === null && this.face() === 'adopt') this.adopt();
        else {
          this.reload();
          this.changed.emit();
        }
      },
      error: (refusal: CrucibleRefusal) => {
        this.busy.set(null);
        this.adoptError.set(refusal.message);
      },
    });
  }

  // ── connect a different server ───────────────────────────────────────

  toggleConnect(): void {
    this.connectOpen.set(!this.connectOpen());
  }

  setConnectMode(mode: ConnectMode): void {
    this.connectMode.set(mode);
    this.connectError.set(null);
  }

  pair(): void {
    const address = this.address.trim();
    if (address === '' || this.connectBusy()) return;
    this.connectBusy.set(true);
    this.connectError.set(null);
    this.crucible.startPairing(address).subscribe({
      next: (prompt) => {
        this.connectBusy.set(false);
        this.pairing.set(prompt);
        this.schedulePoll(prompt, prompt.approvalRequired ? prompt.interval * 1000 : 0);
      },
      error: (refusal: CrucibleRefusal) => {
        this.connectBusy.set(false);
        this.connectError.set(refusal.message);
      },
    });
  }

  cancelPairing(): void {
    const pending = this.pairing();
    this.stopPolling();
    this.pairing.set(null);
    if (pending !== null) this.crucible.cancelPairing(pending.requestId).subscribe({ error: () => undefined });
  }

  addCode(): void {
    const code = this.connectCode.trim();
    if (code === '' || this.connectBusy()) return;
    this.connectBusy.set(true);
    this.connectError.set(null);
    this.crucible.addByConnectCode(code).subscribe({
      next: (added) => {
        this.connectBusy.set(false);
        this.connectCode = '';
        this.connected(added.server.name);
      },
      error: (refusal: CrucibleRefusal) => {
        this.connectBusy.set(false);
        this.connectError.set(refusal.message);
      },
    });
  }

  private schedulePoll(prompt: CruciblePairingPrompt, delayMs: number): void {
    this.stopPolling();
    this.pollTimer = timer(delayMs).subscribe(() => {
      this.crucible.pollPairing(prompt.requestId).subscribe({
        next: (decision) => {
          if (this.pairing()?.requestId !== prompt.requestId) return;
          if (decision.status === 'pending') {
            this.schedulePoll(prompt, Math.max(1, prompt.interval) * 1000);
            return;
          }
          this.pairing.set(null);
          if (decision.status === 'approved') {
            this.address = '';
            this.connected(decision.name);
          } else if (decision.status === 'denied') {
            this.connectError.set('That computer said no. Ask whoever is there to approve Briefcase, then try again.');
          } else {
            this.connectError.set('The code expired before it was approved. Start again.');
          }
        },
        error: (refusal: CrucibleRefusal) => {
          this.pairing.set(null);
          this.connectError.set(refusal.message);
        },
      });
    });
  }

  private connected(name: string): void {
    this.connectedNote.set(`Connected ${name}.`);
    this.connectOpen.set(false);
    this.reload();
    this.changed.emit();
  }

  private stopPolling(): void {
    this.pollTimer?.unsubscribe();
    this.pollTimer = null;
  }
}
