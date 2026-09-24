import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription, timer } from 'rxjs';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import { WebsocketService } from '../../../services/websocket.service';
import { UiButtonComponent } from '../../../ui';
import { CrucibleDoorsComponent } from '../../../components/crucible-doors/crucible-doors.component';
import { serverFactsLine } from '../../../components/crucible-doors/crucible-words';
import type { ConnectCodeReading, CruciblePairingPrompt } from '@crucible-wire/connect-wire';
import type {
  CapabilityFact,
  CrucibleProbeAnswer,
  CrucibleServerRow,
  CrucibleServersView,
  RankedServerRow,
  ServerFacts,
  ServerReach,
} from '@crucible-wire/settings-wire';

type AddMode = 'pair' | 'code';

/** The words a reach chip shows. One place, so every row says the same thing. */
const REACH_WORDS: Record<ServerReach, string> = {
  ready: 'Ready',
  busy: 'Busy',
  unreachable: 'Unreachable',
  bad_token: 'Bad token',
  not_crucible: 'Not a Crucible',
  version_mismatch: 'Other version',
  refused: 'Refused',
};

const CAPABILITY_WORDS: Record<CapabilityFact['capability'], string> = {
  analysis: 'Chat',
  asr: 'Transcription',
};

/**
 * Settings › Crucible Servers.
 *
 * Modelled on BookForge's crucible-servers-panel: ONE list, one kind of row,
 * whether the Crucible runs on this computer or across the network. The list's
 * order is the rank (drag to change it), and each row is a Running/Paused card
 * toggle: the whole card toggles, with an orange border while it is Running.
 * A paused server is given no new work.
 *
 * A server is added by pairing with its address (the server shows a short code,
 * and with open pairing approves at once) or by pasting a connect code. The
 * Crucible on this computer is offered as a one-click add when it is not in the
 * list yet. Nothing on this page ever holds a token: rows show a masked one,
 * and "Copy connect code" is done by the backend, straight to the clipboard.
 */
@Component({
  selector: 'app-crucible-pane',
  standalone: true,
  imports: [FormsModule, UiButtonComponent, CrucibleDoorsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss', './crucible-pane.component.scss'],
  templateUrl: './crucible-pane.component.html',
})
export class CruciblePaneComponent {
  private readonly crucible = inject(CrucibleService);
  private readonly websocket = inject(WebsocketService);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = signal<CrucibleServersView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly probes = signal<Record<string, CrucibleProbeAnswer>>({});
  readonly testing = signal<Record<string, boolean>>({});
  readonly rowError = signal<Record<string, string>>({});
  readonly note = signal<string | null>(null);
  readonly confirmRemove = signal<string | null>(null);
  readonly switching = signal<string | null>(null);

  /** The rank the list shows: the server's, or the one a drag in progress is proposing. */
  private readonly dragOrder = signal<string[] | null>(null);
  readonly dragName = signal<string | null>(null);

  readonly rows = computed<Array<RankedServerRow & { server: CrucibleServerRow | undefined }>>(() => {
    const view = this.view();
    if (view === null) return [];
    const byName = new Map(view.servers.map((s) => [s.name, s]));
    const ranked = view.routing.ranked;
    const order = this.dragOrder();
    const rows = order === null ? ranked : order.flatMap((name) => ranked.filter((r) => r.name === name));
    return rows.map((row) => ({ ...row, server: byName.get(row.name) }));
  });
  readonly unknown = computed(() => this.view()?.routing.unknown ?? []);
  readonly offer = computed(() => {
    const discovered = this.view()?.discovered;
    return discovered?.present === true && discovered.registeredAs === null ? discovered : null;
  });
  readonly thisComputer = computed(() => {
    const discovered = this.view()?.discovered;
    return discovered?.present === true ? discovered : null;
  });

  // ── adding a server ──────────────────────────────────────────────────
  readonly addMode = signal<AddMode>('pair');
  pairAddress = '';
  pairName = '';
  readonly pairing = signal<CruciblePairingPrompt | null>(null);
  readonly pairError = signal<string | null>(null);
  readonly pairBusy = signal(false);
  private pollTimer: Subscription | null = null;
  private flashTimer: Subscription | null = null;

  connectCode = '';
  codeName = '';
  readonly codePreview = signal<ConnectCodeReading | null>(null);
  readonly codeError = signal<string | null>(null);
  readonly codeBusy = signal(false);
  readonly addedNote = signal<string | null>(null);

  constructor() {
    this.reload();
    const off = this.websocket.onCrucibleServersChanged(() => this.reload(false));
    this.destroyRef.onDestroy(() => {
      off();
      this.stopPolling();
      this.flashTimer?.unsubscribe();
      const pending = this.pairing();
      if (pending !== null) this.crucible.cancelPairing(pending.requestId).subscribe({ error: () => undefined });
    });
  }

  reachWord(reach: ServerReach): string {
    return REACH_WORDS[reach];
  }

  capabilityWord(fact: CapabilityFact): string {
    return CAPABILITY_WORDS[fact.capability];
  }

  factsLine(facts: ServerFacts): string {
    return serverFactsLine(facts);
  }

  /** Read the list, then probe each row (a probe is at most 10 s old unless Test asks again). */
  reload(probeAll = true): void {
    this.crucible.list().subscribe({
      next: (view) => {
        this.loadError.set(null);
        this.view.set(view);
        if (probeAll) for (const server of view.servers) this.probe(server.name);
        else for (const server of view.servers) if (!this.probes()[server.name]) this.probe(server.name);
      },
      error: (refusal: CrucibleRefusal) => this.loadError.set(refusal.message),
    });
  }

  private probe(name: string): void {
    this.crucible.probe(name).subscribe({
      next: (answer) => this.probes.update((all) => ({ ...all, [name]: answer })),
      error: (refusal: CrucibleRefusal) => this.setRowError(name, refusal.message),
    });
  }

  test(name: string, event?: Event): void {
    event?.stopPropagation();
    this.testing.update((all) => ({ ...all, [name]: true }));
    this.setRowError(name, null);
    this.crucible.test(name).subscribe({
      next: (answer) => {
        this.probes.update((all) => ({ ...all, [name]: answer }));
        this.testing.update((all) => ({ ...all, [name]: false }));
      },
      error: (refusal: CrucibleRefusal) => {
        this.setRowError(name, refusal.message);
        this.testing.update((all) => ({ ...all, [name]: false }));
      },
    });
  }

  toggleRunning(row: RankedServerRow): void {
    if (this.switching() !== null || this.dragName() !== null) return;
    this.switching.set(row.name);
    this.crucible.setRunning(row.name, !row.enabled).subscribe({
      next: (routing) => {
        this.view.update((view) => (view === null ? view : { ...view, routing }));
        this.switching.set(null);
      },
      error: (refusal: CrucibleRefusal) => {
        this.setRowError(row.name, refusal.message);
        this.switching.set(null);
      },
    });
  }

  askRemove(name: string, event: Event): void {
    event.stopPropagation();
    this.confirmRemove.set(name);
  }

  cancelRemove(event: Event): void {
    event.stopPropagation();
    this.confirmRemove.set(null);
  }

  remove(name: string, event: Event): void {
    event.stopPropagation();
    this.confirmRemove.set(null);
    this.crucible.remove(name).subscribe({
      next: () => {
        this.probes.update((all) => {
          const rest = { ...all };
          delete rest[name];
          return rest;
        });
        this.reload(false);
      },
      error: (refusal: CrucibleRefusal) => this.setRowError(name, refusal.message),
    });
  }

  copyCode(name: string, event: Event): void {
    event.stopPropagation();
    this.crucible.copyConnectCode(name).subscribe({
      next: (answer) => this.flash(`Copied ${answer.copied} to the clipboard.`),
      error: (refusal: CrucibleRefusal) => this.setRowError(name, refusal.message),
    });
  }

  copyThisComputersCode(): void {
    this.crucible.copyThisComputersConnectCode().subscribe({
      next: (answer) => this.flash(`Copied ${answer.copied} to the clipboard. Paste it into Briefcase on the other computer.`),
      error: (refusal: CrucibleRefusal) => this.flash(refusal.message),
    });
  }

  forgetRank(name: string): void {
    this.crucible.forgetRank(name).subscribe({
      next: (routing) => this.view.update((view) => (view === null ? view : { ...view, routing })),
      error: (refusal: CrucibleRefusal) => this.flash(refusal.message),
    });
  }

  addThisComputer(): void {
    this.crucible.addDiscovered().subscribe({
      next: (added) => {
        this.addedNote.set(`Connected ${added.server.name}.`);
        this.reload();
      },
      error: (refusal: CrucibleRefusal) => this.flash(refusal.message),
    });
  }

  // ── drag to rank ─────────────────────────────────────────────────────

  onDragStart(name: string, event: DragEvent): void {
    this.dragName.set(name);
    this.dragOrder.set(this.rows().map((row) => row.name));
    event.dataTransfer?.setData('text/plain', name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent, over: string): void {
    const dragging = this.dragName();
    const order = this.dragOrder();
    if (dragging === null || order === null) return;
    event.preventDefault();
    if (dragging === over) return;
    const next = order.filter((name) => name !== dragging);
    next.splice(next.indexOf(over) + (order.indexOf(dragging) < order.indexOf(over) ? 1 : 0), 0, dragging);
    this.dragOrder.set(next);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const order = this.dragOrder();
    const before = this.view()?.routing.ranked.map((row) => row.name) ?? [];
    this.dragName.set(null);
    if (order === null || order.join('\n') === before.join('\n')) {
      this.dragOrder.set(null);
      return;
    }
    this.crucible.setOrder(order).subscribe({
      next: (routing) => {
        this.view.update((view) => (view === null ? view : { ...view, routing }));
        this.dragOrder.set(null);
      },
      error: (refusal: CrucibleRefusal) => {
        this.dragOrder.set(null);
        this.flash(refusal.message);
      },
    });
  }

  onDragEnd(): void {
    // A drop already cleared these; a drag abandoned outside the list restores the rank.
    if (this.dragName() !== null) {
      this.dragName.set(null);
      this.dragOrder.set(null);
    }
  }

  // ── add: pairing by address ───────────────────────────────────────────

  setAddMode(mode: AddMode): void {
    this.addMode.set(mode);
    this.addedNote.set(null);
  }

  startPairing(): void {
    const address = this.pairAddress.trim();
    if (address === '') return;
    this.pairError.set(null);
    this.addedNote.set(null);
    this.pairBusy.set(true);
    this.crucible.startPairing(address, this.pairName.trim() || undefined).subscribe({
      next: (prompt) => {
        this.pairBusy.set(false);
        this.pairing.set(prompt);
        this.schedulePoll(prompt, prompt.approvalRequired ? prompt.interval * 1000 : 0);
      },
      error: (refusal: CrucibleRefusal) => {
        this.pairBusy.set(false);
        this.pairError.set(refusal.message);
      },
    });
  }

  private schedulePoll(prompt: CruciblePairingPrompt, delayMs: number): void {
    this.stopPolling();
    this.pollTimer = timer(delayMs).subscribe(() => this.poll(prompt));
  }

  private poll(prompt: CruciblePairingPrompt): void {
    this.crucible.pollPairing(prompt.requestId).subscribe({
      next: (decision) => {
        if (this.pairing()?.requestId !== prompt.requestId) return;
        if (decision.status === 'pending') {
          this.schedulePoll(prompt, Math.max(1, prompt.interval) * 1000);
          return;
        }
        this.pairing.set(null);
        if (decision.status === 'approved') {
          this.pairAddress = '';
          this.pairName = '';
          this.addedNote.set(`Connected ${decision.name}.`);
          this.reload();
        } else if (decision.status === 'denied') {
          this.pairError.set('That computer said no. Ask whoever is there to approve Briefcase, then try again.');
        } else {
          this.pairError.set('The code expired before it was approved. Start again.');
        }
      },
      error: (refusal: CrucibleRefusal) => {
        this.pairing.set(null);
        this.pairError.set(refusal.message);
      },
    });
  }

  cancelPairing(): void {
    const pending = this.pairing();
    this.stopPolling();
    this.pairing.set(null);
    if (pending !== null) this.crucible.cancelPairing(pending.requestId).subscribe({ error: () => undefined });
  }

  private stopPolling(): void {
    this.pollTimer?.unsubscribe();
    this.pollTimer = null;
  }

  // ── add: connect code ─────────────────────────────────────────────────

  onCodeChanged(): void {
    this.codeError.set(null);
    this.addedNote.set(null);
    const code = this.connectCode.trim();
    if (code === '') {
      this.codePreview.set(null);
      return;
    }
    this.crucible.readConnectCode(code).subscribe({
      next: (reading) => this.codePreview.set(reading),
      error: (refusal: CrucibleRefusal) => this.codeError.set(refusal.message),
    });
  }

  addByCode(): void {
    const code = this.connectCode.trim();
    if (code === '') return;
    this.codeBusy.set(true);
    this.codeError.set(null);
    this.crucible.addByConnectCode(code, this.codeName.trim() || undefined).subscribe({
      next: (added) => {
        this.codeBusy.set(false);
        this.connectCode = '';
        this.codeName = '';
        this.codePreview.set(null);
        this.addedNote.set(`Connected ${added.server.name}.`);
        this.reload();
      },
      error: (refusal: CrucibleRefusal) => {
        this.codeBusy.set(false);
        this.codeError.set(refusal.message);
      },
    });
  }

  private setRowError(name: string, message: string | null): void {
    this.rowError.update((all) => {
      const rest = { ...all };
      delete rest[name];
      return message === null ? rest : { ...rest, [name]: message };
    });
  }

  private flash(message: string): void {
    this.note.set(message);
    this.flashTimer?.unsubscribe();
    this.flashTimer = timer(6000).subscribe(() => this.note.set(null));
  }
}
