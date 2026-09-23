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
  CrucibleProbeAnswer,
  CrucibleServerRow,
  CrucibleServersView,
  RoutingView,
} from '@crucible-wire/settings-wire';

/** A refusal from /api/crucible, always with a sentence that carries the fix. */
export interface CrucibleRefusal {
  code: string;
  message: string;
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

  setRunning(name: string, running: boolean): Observable<RoutingView> {
    return this.refusal(this.http.post<RoutingView>(`${this.server(name)}/${running ? 'resume' : 'pause'}`, {}));
  }

  setOrder(order: string[]): Observable<RoutingView> {
    return this.refusal(this.http.put<RoutingView>(`${this.base}/routing`, { order }));
  }

  forgetRank(name: string): Observable<RoutingView> {
    return this.refusal(this.http.post<RoutingView>(`${this.base}/routing/forget`, { name }));
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
}
