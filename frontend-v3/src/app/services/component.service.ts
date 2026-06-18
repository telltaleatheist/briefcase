import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

export type ComponentKind = 'binary' | 'whisper-model' | 'llama-model';

export interface ComponentStatus {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  supported: boolean;
  installed: boolean;
  sizeBytes: number;
  installedAt?: string;
}

/**
 * Frontend access to the download-on-demand component system
 * (ComponentManagerService). Mirrors AiSetupService's HTTP style; download
 * progress arrives via WebsocketService 'component.download.*' events.
 */
@Injectable({ providedIn: 'root' })
export class ComponentService {
  private readonly API_BASE = 'http://localhost:3000/api';

  /** Last-known component list, kept reactive for the settings/wizard UI. */
  readonly components = signal<ComponentStatus[]>([]);

  constructor(private http: HttpClient) {}

  listComponents(): Observable<ComponentStatus[]> {
    return this.http.get<any>(`${this.API_BASE}/config/components`).pipe(
      map((res) => {
        const components: ComponentStatus[] = res.components || [];
        this.components.set(components);
        return components;
      }),
      catchError((error) => {
        console.error('Error listing components:', error);
        return of([] as ComponentStatus[]);
      }),
    );
  }

  /** True if any required, supported component is not yet installed. */
  hasMissingRequired(components: ComponentStatus[]): boolean {
    return components.some((c) => c.required && c.supported && !c.installed);
  }

  installComponent(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/install-component`, { id }).pipe(
      map((res) => ({ success: res.success || false, message: res.message || 'Install started' })),
      catchError((error) => {
        console.error('Error installing component:', error);
        throw error;
      }),
    );
  }

  cancelComponent(): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/cancel-component`, {}).pipe(
      map((res) => ({ success: res.success || false, message: res.message || '' })),
      catchError((error) => {
        console.error('Error cancelling component:', error);
        throw error;
      }),
    );
  }

  removeComponent(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.API_BASE}/config/component/${id}`).pipe(
      map((res) => ({ success: res.success || false, message: res.message || 'Removed' })),
      catchError((error) => {
        console.error('Error removing component:', error);
        throw error;
      }),
    );
  }
}
