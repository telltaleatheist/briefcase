import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';
import { getApiBase } from '../core/runtime-url';
import type {
  ConnectCodeReading,
  CopiedConnectCode,
  CruciblePairingDecision,
  CruciblePairingPrompt,
} from '@crucible-wire/connect-wire';
import type {
  CrucibleEnginePresence,
  CrucibleEngineStartOutcome,
  CrucibleInstallStatus,
  CrucibleReleaseCheck,
  CrucibleSetupView,
} from '@crucible-wire/install-wire';
import type { CrucibleCoordinationMap } from '@crucible-wire/coordinate-wire';
import type { CrucibleInstallDoorStatus } from '@crucible-wire/install-door-wire';
import type {
  CrucibleProbeAnswer,
  CrucibleServerRow,
  CrucibleServersView,
  CrucibleSettingsView,
  RoutingView,
  UpstreamName,
  UpstreamTestAnswer,
} from '@crucible-wire/settings-wire';
import type { AiModelsView, AiTaskModels, KeyCopyOutcome, LegacyKeysView } from '@crucible-wire/ai-wire';
import type { TranscriptionSettingWire, TranscriptionView } from '@crucible-wire/transcription-wire';

/** A refusal from /api/crucible, always with a sentence that carries the fix. */
export interface CrucibleRefusal {
  code: string;
  message: string;
  /** Install refusals only: the exact line to run, when there is one. */
  command?: string | null;
  /** Install refusals only: verbatim evidence (a stderr tail). */
  detail?: string | null;
}

/**
 * The renderer's side of Settings › Crucible Servers. Everything goes through
 * the backend's /api/crucible routes; no response carries a token, and nothing
 * here ever sends one except a connect code the user pasted.
 */
@Injectable({ providedIn: 'root' })
export class CrucibleService {
  private readonly http = inject(HttpClient);
  private readonly base = `${getApiBase()}/crucible`;

  private refusal<T>(source: Observable<T>): Observable<T> {
    return source.pipe(catchError((error: HttpErrorResponse) => {
      const body = error.error as Partial<CrucibleRefusal> | null;
      const refusal: CrucibleRefusal = {
        code: typeof body?.code === 'string' ? body.code : `http_${error.status}`,
        message: typeof body?.message === 'string' ? body.message : 'Briefcase could not reach its own backend. Try again.',
        command: typeof body?.command === 'string' ? body.command : null,
        detail: typeof body?.detail === 'string' ? body.detail : null,
      };
      return throwError(() => refusal);
    }));
  }

  private server(name: string): string {
    return `${this.base}/servers/${encodeURIComponent(name)}`;
  }

  list(): Observable<CrucibleServersView> {
    return this.refusal(this.http.get<CrucibleServersView>(`${this.base}/servers`));
  }

  /** At most 10 s old. */
  probe(name: string): Observable<CrucibleProbeAnswer> {
    return this.refusal(this.http.get<CrucibleProbeAnswer>(`${this.server(name)}/probe`));
  }

  /** Taken now. */
  test(name: string): Observable<CrucibleProbeAnswer> {
    return this.refusal(this.http.post<CrucibleProbeAnswer>(`${this.server(name)}/test`, {}));
  }

  remove(name: string): Observable<{ removed: CrucibleServerRow }> {
    return this.refusal(this.http.delete<{ removed: CrucibleServerRow }>(this.server(name)));
  }

  /** Switch servers: all work not yet started goes to this one. */
  select(name: string): Observable<RoutingView> {
    return this.refusal(this.http.post<RoutingView>(`${this.server(name)}/select`, {}));
  }

  addByConnectCode(connectCode: string, name?: string): Observable<{ server: CrucibleServerRow }> {
    return this.refusal(this.http.post<{ server: CrucibleServerRow }>(`${this.base}/servers`, { connectCode, ...(name ? { name } : {}) }));
  }

  addDiscovered(): Observable<{ server: CrucibleServerRow }> {
    return this.refusal(this.http.post<{ server: CrucibleServerRow }>(`${this.base}/servers`, { discovered: true }));
  }

  readConnectCode(connectCode: string): Observable<ConnectCodeReading> {
    return this.refusal(this.http.post<ConnectCodeReading>(`${this.base}/connect-code/parse`, { connectCode }));
  }

  copyConnectCode(name: string): Observable<CopiedConnectCode> {
    return this.refusal(this.http.post<CopiedConnectCode>(`${this.server(name)}/connect-code/copy`, {}));
  }

  copyThisComputersConnectCode(): Observable<CopiedConnectCode> {
    return this.refusal(this.http.post<CopiedConnectCode>(`${this.base}/connect-code/copy`, {}));
  }

  startPairing(address: string, name?: string): Observable<CruciblePairingPrompt> {
    return this.refusal(this.http.post<CruciblePairingPrompt>(`${this.base}/pair/start`, { address, ...(name ? { name } : {}) }));
  }

  pollPairing(requestId: string): Observable<CruciblePairingDecision> {
    return this.refusal(this.http.post<CruciblePairingDecision>(`${this.base}/pair/poll`, { requestId }));
  }

  cancelPairing(requestId: string): Observable<{ cancelled: true }> {
    return this.refusal(this.http.post<{ cancelled: true }>(`${this.base}/pair/cancel`, { requestId }));
  }

  // ── install and first run (P2) ───────────────────────────────────────

  /** The setup face and everything it draws. */
  setup(): Observable<CrucibleSetupView> {
    return this.refusal(this.http.get<CrucibleSetupView>(`${this.base}/setup`));
  }

  installStatus(): Observable<CrucibleInstallStatus> {
    return this.refusal(this.http.get<CrucibleInstallStatus>(`${this.base}/install`));
  }

  /** Start the one install. Answers once the never-older gate has chosen a release; progress follows on the socket. */
  startInstall(): Observable<{ started: true; release: string }> {
    return this.refusal(this.http.post<{ started: true; release: string }>(`${this.base}/install`, {}));
  }

  /** Is there a newer Crucible for this computer? Installs nothing. */
  checkRelease(): Observable<CrucibleReleaseCheck> {
    return this.refusal(this.http.get<CrucibleReleaseCheck>(`${this.base}/install/release`));
  }

  installDoor(): Observable<CrucibleInstallDoorStatus> {
    return this.refusal(this.http.get<CrucibleInstallDoorStatus>(`${this.base}/install/door`));
  }

  retryInstallDoor(): Observable<{ retrying: true }> {
    return this.refusal(this.http.post<{ retrying: true }>(`${this.base}/install/door/retry`, {}));
  }

  localPresence(): Observable<CrucibleEnginePresence> {
    return this.refusal(this.http.get<CrucibleEnginePresence>(`${this.base}/local/presence`));
  }

  startLocal(): Observable<CrucibleEngineStartOutcome> {
    return this.refusal(this.http.post<CrucibleEngineStartOutcome>(`${this.base}/local/start`, {}));
  }

  coordination(): Observable<CrucibleCoordinationMap> {
    return this.refusal(this.http.get<CrucibleCoordinationMap>(`${this.base}/coordination`));
  }

  coordinate(name: string): Observable<{ coordinating: string }> {
    return this.refusal(this.http.post<{ coordinating: string }>(`${this.server(name)}/coordinate`, {}));
  }

  /** The setup wizard opened: hold coordination until it finishes. */
  holdFirstRun(): Observable<{ held: true }> {
    return this.refusal(this.http.post<{ held: true }>(`${this.base}/first-run/hold`, {}));
  }

  /** The setup wizard finished or was skipped: release the hold. Models download in the background. */
  finishFirstRun(): Observable<{ released: boolean; coordinating: string[] }> {
    return this.refusal(this.http.post<{ released: boolean; coordinating: string[] }>(`${this.base}/first-run/finish`, {}));
  }

  // ── one server's own settings: upstream keys and the Ollama URL (P3) ──

  /** The server's settings. Keys come back as `keyHint` only. */
  settings(name: string): Observable<CrucibleSettingsView> {
    return this.refusal(this.http.get<CrucibleSettingsView>(`${this.server(name)}/settings`));
  }

  /** Write to THAT server's settings. A key crosses once, on its way in. */
  putSettings(name: string, patch: { upstreams?: Partial<Record<UpstreamName, { key?: string; url?: string } | null>> }): Observable<CrucibleSettingsView> {
    return this.refusal(this.http.put<CrucibleSettingsView>(`${this.server(name)}/settings`, patch));
  }

  /** Test an upstream through the server: a pasted key or URL before saving, or the stored one. */
  testUpstream(name: string, upstream: UpstreamName, probe: { key?: string; url?: string } = {}): Observable<UpstreamTestAnswer> {
    return this.refusal(this.http.post<UpstreamTestAnswer>(`${this.server(name)}/settings/upstreams/${upstream}/test`, probe));
  }

  // ── AI through Crucible (P3) ─────────────────────────────────────────

  /**
   * THE one source of analysis-model options (the connected server's own
   * models that can serve the analysis class, and its configured upstreams'),
   * with each stored `values` choice resolved against them. Pickers read it
   * through AiModelOptionsService.
   */
  aiModels(server?: string, values: readonly string[] = []): Observable<AiModelsView> {
    const params: Record<string, string> = {};
    if (server) params['server'] = server;
    if (values.length > 0) params['values'] = values.join(',');
    return this.refusal(this.http.get<AiModelsView>(`${this.base}/ai/models`, { params }));
  }

  /** Forget cached model lists after a settings save. */
  refreshAiModels(server?: string): Observable<{ refreshed: true }> {
    return this.refusal(this.http.post<{ refreshed: true }>(`${this.base}/ai/models/refresh`, { server }));
  }

  legacyKeys(): Observable<LegacyKeysView> {
    return this.refusal(this.http.get<LegacyKeysView>(`${this.base}/ai/keys/legacy`));
  }

  /** The one-time copy of Briefcase's own keys onto a server the user named. */
  copyLegacyKeys(server: string): Observable<KeyCopyOutcome> {
    return this.refusal(this.http.post<KeyCopyOutcome>(`${this.base}/ai/keys/copy`, { server }));
  }

  taskModels(): Observable<AiTaskModels> {
    return this.refusal(this.http.get<AiTaskModels>(`${this.base}/ai/task-models`));
  }

  /** Set (`provider:model`) or clear (null) per-task models. */
  setTaskModels(changes: Partial<Record<keyof AiTaskModels, string | null>>): Observable<AiTaskModels> {
    return this.refusal(this.http.put<AiTaskModels>(`${this.base}/ai/task-models`, changes));
  }

    // ── transcription (P5) ─────────────────────────────────────────────────

  /** Where transcription runs, each server's asr models, and where a transcription queued now would go. */
  transcription(): Observable<TranscriptionView> {
    return this.refusal(this.http.get<TranscriptionView>(`${this.base}/transcription`));
  }

  saveTranscription(setting: TranscriptionSettingWire): Observable<TranscriptionView> {
    return this.refusal(this.http.put<TranscriptionView>(`${this.base}/transcription`, setting));
  }
}
