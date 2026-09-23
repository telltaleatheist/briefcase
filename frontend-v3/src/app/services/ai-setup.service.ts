import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, of, Subject } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { getApiBase } from '../core/runtime-url';
import { CrucibleService } from './crucible.service';
import type { AiModelOption, AiModelsView, AiVia } from '@crucible-wire/ai-wire';

export interface AIAvailability {
  hasLocal: boolean;
  localReady: boolean;
  hasOllama: boolean;           // true if Ollama has models ready to use
  ollamaConnected: boolean;     // true if Ollama is running (even without models)
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
  ollamaModels: string[];
  isChecking: boolean;
  /**
   * True when one of the availability probes FAILED (network/backend error) —
   * distinct from "checked fine, nothing configured". A configured provider
   * must never be presented as unconfigured because a probe blipped
   * (fallback-audit discuss #13/#14).
   */
  checkFailed: boolean;
  lastChecked?: Date;
}

export interface GpuInfo {
  name: string;
  vramGB: number;
  driver?: string;
}

export interface SystemInfo {
  totalMemoryGB: number;
  freeMemoryGB: number;
  cpuCores: number;
  platform: string;
  recommendedModel: string;
  gpu: GpuInfo | null;
  useGpu: boolean;
  effectiveMemoryGB: number;
}

export interface LocalModelInfo {
  id: string;
  name: string;
  filename: string;
  sizeGB: number;
  minRAM: number;
  description: string;
  downloaded: boolean;
  isDefault: boolean;
  downloadedAt?: string;
  filePath?: string;
}

export interface AISetupStatus {
  isReady: boolean;
  needsSetup: boolean;
  /** True when readiness is UNKNOWN because the availability check failed. */
  checkFailed: boolean;
  availableProviders: ('local' | 'ollama' | 'claude' | 'openai')[];
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiSetupService {
  private readonly API_BASE = getApiBase();

  // Reactive state
  availability = signal<AIAvailability>({
    hasLocal: false,
    localReady: false,
    hasOllama: false,
    ollamaConnected: false,
    hasClaudeKey: false,
    hasOpenAIKey: false,
    ollamaModels: [],
    isChecking: false,
    checkFailed: false
  });

  /**
   * Which road AI takes: 'crucible' (every call through the connected
   * Crucible, keys on that server) or 'direct' (Briefcase's own providers).
   * Null until first asked. Under 'crucible' the Ollama/key UI is hidden:
   * Ollama is an upstream configured on the server.
   */
  readonly via = signal<AiVia | null>(null);
  /** The last Crucible model listing, for pickers and the AI pane. */
  readonly crucibleModels = signal<AiModelsView | null>(null);

  private readonly crucible = inject(CrucibleService);

  // Subject to notify when models change (downloaded, deleted, etc.)
  private modelsChangedSubject = new Subject<void>();
  public modelsChanged$ = this.modelsChangedSubject.asObservable();

  constructor(private http: HttpClient) {}

  /**
   * Notify subscribers that the model list has changed
   * Call this after downloading, deleting, or modifying models
   */
  notifyModelsChanged(): void {
    this.modelsChangedSubject.next();
  }

  /** Ask the backend which road AI takes. A failed ask keeps the last answer (or 'direct'). */
  async refreshVia(): Promise<AiVia> {
    try {
      const view = await firstValueFrom(this.crucible.aiVia());
      this.via.set(view.via);
      return view.via;
    } catch {
      const known = this.via() ?? 'direct';
      this.via.set(known);
      return known;
    }
  }

  /** The connected Crucible's models, read now. */
  async loadCrucibleModels(): Promise<AiModelsView> {
    const view = await firstValueFrom(this.crucible.aiModels());
    this.crucibleModels.set(view);
    return view;
  }

  /**
   * Picker options when AI runs through Crucible: the server's installed
   * catalog models and its configured upstreams' models, as `provider:model`
   * values (the stored format every picker already uses). Null on the direct
   * road, so the caller keeps its own direct-provider listing unchanged.
   */
  async modelOptionsIfCrucible(): Promise<AiModelOption[] | null> {
    if ((await this.refreshVia()) !== 'crucible') return null;
    const view = await this.loadCrucibleModels();
    return view.models
      .filter(m => m.provider !== 'local' || m.installed !== false)
      .map(m => ({ ...m, label: m.provider === 'local' ? `${m.label} (Crucible)` : m.label }));
  }

  /**
   * Check all AI providers and update availability status
   */
  async checkAIAvailability(): Promise<AIAvailability> {
    if ((await this.refreshVia()) === 'crucible') return this.checkCrucibleAvailability();
    this.availability.update(v => ({ ...v, isChecking: true }));

    // Distinguish "probe failed" from "probe says not configured" — a failed
    // probe must not flip a configured provider to unconfigured.
    let anyCheckFailed = false;

    try {
      // Check local AI status and API keys in parallel
      const [localResult, keysResult] = await Promise.all([
        this.checkLocalAI().toPromise().catch(error => {
          console.error('Local AI availability probe failed:', error);
          anyCheckFailed = true;
          return { available: false, ready: false };
        }),
        this.checkAPIKeys().toPromise().catch(error => {
          console.error('API-key availability probe failed:', error);
          anyCheckFailed = true;
          return { hasClaudeKey: false, hasOpenAIKey: false, lastUsedProvider: undefined };
        })
      ]);

      // Only check Ollama if:
      // 1. No provider is set yet (first run)
      // 2. Ollama is the selected provider
      // 3. No API keys are configured and local AI is not available
      const shouldCheckOllama =
        !keysResult?.lastUsedProvider ||
        keysResult.lastUsedProvider === 'ollama' ||
        (!keysResult.hasClaudeKey && !keysResult.hasOpenAIKey && !localResult?.available);

      let ollamaResult = { available: false, models: [] as string[] };
      if (shouldCheckOllama) {
        ollamaResult = await this.checkOllama().toPromise().catch(error => {
          console.error('Ollama availability probe failed:', error);
          anyCheckFailed = true;
          return { available: false, models: [] as string[] };
        }) || { available: false, models: [] };
      }

      const ollamaConnected = ollamaResult?.available || false;
      const ollamaModels = ollamaResult?.models || [];

      const newAvailability: AIAvailability = {
        hasLocal: localResult?.available || false,
        localReady: localResult?.ready || false,
        hasOllama: ollamaConnected && ollamaModels.length > 0,  // Only true if has models
        ollamaConnected,  // True if Ollama is running (even without models)
        ollamaModels,
        hasClaudeKey: keysResult?.hasClaudeKey || false,
        hasOpenAIKey: keysResult?.hasOpenAIKey || false,
        isChecking: false,
        checkFailed: anyCheckFailed,
        lastChecked: new Date()
      };

      this.availability.set(newAvailability);
      return newAvailability;
    } catch (error) {
      console.error('Error checking AI availability:', error);
      this.availability.update(v => ({
        ...v,
        isChecking: false,
        checkFailed: true,
        lastChecked: new Date()
      }));
      return this.availability();
    }
  }

  /**
   * Availability through Crucible, in the same shape the direct road reports,
   * so every existing reader (the shell's AI chip, "set up AI first" prompts)
   * keeps working: a provider is "ready" when the connected server has it.
   */
  private async checkCrucibleAvailability(): Promise<AIAvailability> {
    this.availability.update(v => ({ ...v, isChecking: true }));
    try {
      const view = await this.loadCrucibleModels();
      const ups = view.upstreams;
      const ollamaModels = view.models.filter(m => m.provider === 'ollama').map(m => m.value.slice('ollama:'.length));
      const hasLocal = view.models.some(m => m.provider === 'local' && m.installed !== false);
      const next: AIAvailability = {
        hasLocal,
        localReady: hasLocal,
        hasOllama: !!ups?.ollama.configured && ollamaModels.length > 0,
        ollamaConnected: !!ups?.ollama.configured,
        ollamaModels,
        hasClaudeKey: !!ups?.anthropic.configured,
        hasOpenAIKey: !!ups?.openai.configured,
        isChecking: false,
        // A registered server that is not answering is "unknown", not "not configured".
        checkFailed: view.server === null && view.via.registeredServers > 0,
        lastChecked: new Date(),
      };
      this.availability.set(next);
      return next;
    } catch (error) {
      console.error('Crucible AI availability probe failed:', error);
      this.availability.update(v => ({ ...v, isChecking: false, checkFailed: true, lastChecked: new Date() }));
      return this.availability();
    }
  }

  /**
   * Get setup status based on current availability
   */
  getSetupStatus(): AISetupStatus {
    const avail = this.availability();
    const providers: ('local' | 'ollama' | 'claude' | 'openai')[] = [];

    // Local AI is always first option if available (bundled, no setup required)
    if (avail.hasLocal) {
      providers.push('local');
    }
    if (avail.hasOllama && avail.ollamaModels.length > 0) {
      providers.push('ollama');
    }
    if (avail.hasClaudeKey) {
      providers.push('claude');
    }
    if (avail.hasOpenAIKey) {
      providers.push('openai');
    }

    const isReady = providers.length > 0;
    // Readiness is only "unknown" when nothing verified ready AND a probe
    // failed — a successful probe of any provider beats a failed one.
    const checkFailed = !isReady && avail.checkFailed;
    let message = '';

    if (checkFailed) {
      message = "Couldn't check AI providers";
    } else if (!isReady) {
      message = 'No AI providers configured';
    } else if (providers.includes('local')) {
      message = 'Local AI ready';
    } else if (providers.includes('ollama')) {
      message = `Ollama ready with ${avail.ollamaModels.length} model(s)`;
    } else {
      message = `Ready with ${providers.join(', ')}`;
    }

    return {
      isReady,
      needsSetup: !isReady && !checkFailed,
      checkFailed,
      availableProviders: providers,
      message
    };
  }

  /**
   * Check if Ollama is running and get available models
   */
  private checkOllama(): Observable<{ available: boolean; models: string[] }> {
    return this.http.get<any>(`${this.API_BASE}/analysis/models`).pipe(
      map(response => {
        const isAvailable = response.connected || response.success || false;
        const modelList = response.models || [];

        // Extract model names
        const modelNames = modelList.map((m: any) =>
          typeof m === 'string' ? m : (m.name || m.model || '')
        ).filter((name: string) => name !== '');

        return {
          available: isAvailable,
          models: modelNames
        };
      })
      // No catchError: a failed probe must propagate so the caller can mark
      // checkFailed instead of reporting "not configured" (fallback-audit).
    );
  }

  /**
   * Check which API keys are configured
   */
  private checkAPIKeys(): Observable<{ hasClaudeKey: boolean; hasOpenAIKey: boolean; lastUsedProvider?: string }> {
    return this.http.get<any>(`${this.API_BASE}/config/api-keys`).pipe(
      map(response => ({
        // Backend returns '***' when key is set (masked for security), so '***' means key EXISTS
        hasClaudeKey: !!response.claudeApiKey && response.claudeApiKey !== '',
        hasOpenAIKey: !!response.openaiApiKey && response.openaiApiKey !== '',
        lastUsedProvider: response.lastUsedProvider
      }))
      // No catchError: propagate so the caller marks checkFailed — a probe
      // blip must not present configured API keys as missing.
    );
  }

  /**
   * Check if bundled local AI (Cogito 8B) is available
   */
  private checkLocalAI(): Observable<{ available: boolean; ready: boolean }> {
    return this.http.get<any>(`${this.API_BASE}/config/local-ai-status`).pipe(
      map(response => ({
        available: response.available || false,
        ready: response.ready || false
      }))
      // No catchError: propagate so the caller marks checkFailed.
    );
  }

  /**
   * Save Claude API key
   */
  saveClaudeKey(apiKey: string): Observable<{ success: boolean }> {
    return this.http.post<any>(`${this.API_BASE}/config/api-keys`, {
      claudeApiKey: apiKey.trim()
    }).pipe(
      map(response => ({ success: response.success !== false })),
      catchError(error => {
        console.error('Error saving Claude key:', error);
        throw error;
      })
    );
  }

  /**
   * Save OpenAI API key
   */
  saveOpenAIKey(apiKey: string): Observable<{ success: boolean }> {
    return this.http.post<any>(`${this.API_BASE}/config/api-keys`, {
      openaiApiKey: apiKey.trim()
    }).pipe(
      map(response => ({ success: response.success !== false })),
      catchError(error => {
        console.error('Error saving OpenAI key:', error);
        throw error;
      })
    );
  }

  /**
   * Pull an Ollama model
   */
  pullModel(modelName: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/analysis/pull-model`, {
      modelName
    }).pipe(
      map(response => ({
        success: response.success || false,
        message: response.message || 'Model downloaded'
      })),
      catchError(error => {
        console.error('Error pulling model:', error);
        throw error;
      })
    );
  }

  // ==================== Local Model Management ====================

  /**
   * Get system information and recommended model
   */
  getSystemInfo(): Observable<SystemInfo> {
    return this.http.get<any>(`${this.API_BASE}/config/system-info`).pipe(
      map(response => ({
        totalMemoryGB: response.totalMemoryGB || 0,
        freeMemoryGB: response.freeMemoryGB || 0,
        cpuCores: response.cpuCores || 0,
        platform: response.platform || 'unknown',
        // No bundled-GGUF catalog ships anymore, so there is no local model to
        // fall back to — '' means "nothing to recommend".
        recommendedModel: response.recommendedModel || '',
        gpu: response.gpu || null,
        useGpu: response.useGpu || false,
        effectiveMemoryGB: response.effectiveMemoryGB || response.totalMemoryGB || 0
      })),
      catchError(error => {
        console.error('Error getting system info:', error);
        return of({
          totalMemoryGB: 0,
          freeMemoryGB: 0,
          cpuCores: 0,
          platform: 'unknown',
          recommendedModel: '',
          gpu: null,
          useGpu: false,
          effectiveMemoryGB: 0
        });
      })
    );
  }

  /**
   * Get list of available and downloaded local models
   */
  getLocalModels(): Observable<{ models: LocalModelInfo[]; recommendedModel: string; modelsDir: string }> {
    return this.http.get<any>(`${this.API_BASE}/config/local-models`).pipe(
      map(response => ({
        models: response.models || [],
        recommendedModel: response.recommendedModel || '',
        modelsDir: response.modelsDir || ''
      })),
      catchError(error => {
        console.error('Error getting local models:', error);
        return of({ models: [], recommendedModel: '', modelsDir: '' });
      })
    );
  }

  /**
   * Start downloading a local model
   * Progress is sent via WebSocket events
   */
  downloadLocalModel(modelId: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/download-model`, { modelId }).pipe(
      map(response => ({
        success: response.success || false,
        message: response.message || 'Download started'
      })),
      catchError(error => {
        console.error('Error starting model download:', error);
        throw error;
      })
    );
  }

  /**
   * Cancel an active model download
   */
  cancelModelDownload(): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/cancel-download`, {}).pipe(
      map(response => ({
        success: response.success || false,
        message: response.message || ''
      })),
      catchError(error => {
        console.error('Error cancelling download:', error);
        throw error;
      })
    );
  }

  /**
   * Delete a downloaded local model
   */
  deleteLocalModel(modelId: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.API_BASE}/config/local-model/${modelId}`).pipe(
      map(response => ({
        success: response.success || false,
        message: response.message || 'Model deleted'
      })),
      catchError(error => {
        console.error('Error deleting model:', error);
        throw error;
      })
    );
  }

  /**
   * Set a model as the default local model
   */
  setDefaultModel(modelId: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/set-default-model`, { modelId }).pipe(
      map(response => ({
        success: response.success || false,
        message: response.message || 'Default model set'
      })),
      catchError(error => {
        console.error('Error setting default model:', error);
        throw error;
      })
    );
  }
}
