import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

export interface AIAvailability {
  hasLocal: boolean;
  localReady: boolean;
  hasOllama: boolean;
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
  ollamaModels: string[];
  isChecking: boolean;
  lastChecked?: Date;
}

export interface AISetupStatus {
  isReady: boolean;
  needsSetup: boolean;
  availableProviders: ('local' | 'ollama' | 'claude' | 'openai')[];
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiSetupService {
  private readonly API_BASE = 'http://localhost:3000/api';

  // Reactive state
  availability = signal<AIAvailability>({
    hasLocal: false,
    localReady: false,
    hasOllama: false,
    hasClaudeKey: false,
    hasOpenAIKey: false,
    ollamaModels: [],
    isChecking: false
  });

  constructor(private http: HttpClient) {}

  /**
   * Check all AI providers and update availability status
   */
  async checkAIAvailability(): Promise<AIAvailability> {
    this.availability.update(v => ({ ...v, isChecking: true }));

    try {
      // Check local AI status and API keys in parallel
      const [localResult, keysResult] = await Promise.all([
        this.checkLocalAI().toPromise().catch(() => ({ available: false, ready: false })),
        this.checkAPIKeys().toPromise()
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
        ollamaResult = await this.checkOllama().toPromise() || { available: false, models: [] };
      }

      const newAvailability: AIAvailability = {
        hasLocal: localResult?.available || false,
        localReady: localResult?.ready || false,
        hasOllama: ollamaResult?.available || false,
        ollamaModels: ollamaResult?.models || [],
        hasClaudeKey: keysResult?.hasClaudeKey || false,
        hasOpenAIKey: keysResult?.hasOpenAIKey || false,
        isChecking: false,
        lastChecked: new Date()
      };

      this.availability.set(newAvailability);
      return newAvailability;
    } catch (error) {
      console.error('Error checking AI availability:', error);
      this.availability.update(v => ({
        ...v,
        isChecking: false,
        lastChecked: new Date()
      }));
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
    let message = '';

    if (!isReady) {
      message = 'No AI providers configured';
    } else if (providers.includes('local')) {
      message = 'Local AI ready (Cogito 8B)';
    } else if (providers.includes('ollama')) {
      message = `Ollama ready with ${avail.ollamaModels.length} model(s)`;
    } else {
      message = `Ready with ${providers.join(', ')}`;
    }

    return {
      isReady,
      needsSetup: !isReady,
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
      }),
      catchError(error => {
        console.error('Error checking Ollama:', error);
        return of({ available: false, models: [] });
      })
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
      })),
      catchError(error => {
        console.error('Error checking API keys:', error);
        return of({ hasClaudeKey: false, hasOpenAIKey: false, lastUsedProvider: undefined });
      })
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
      })),
      catchError(error => {
        console.error('Error checking local AI:', error);
        return of({ available: false, ready: false });
      })
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
}
