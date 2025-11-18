import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

export interface AIAvailability {
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
  availableProviders: ('ollama' | 'claude' | 'openai')[];
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiSetupService {
  private readonly API_BASE = 'http://localhost:3001/api';

  // Reactive state
  availability = signal<AIAvailability>({
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
      // Check Ollama
      const ollamaResult = await this.checkOllama().toPromise();

      // Check API keys
      const keysResult = await this.checkAPIKeys().toPromise();

      const newAvailability: AIAvailability = {
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
    const providers: ('ollama' | 'claude' | 'openai')[] = [];

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
  private checkAPIKeys(): Observable<{ hasClaudeKey: boolean; hasOpenAIKey: boolean }> {
    return this.http.get<any>(`${this.API_BASE}/config/api-keys`).pipe(
      map(response => ({
        hasClaudeKey: !!response.claudeApiKey && response.claudeApiKey !== '' && response.claudeApiKey !== '***',
        hasOpenAIKey: !!response.openaiApiKey && response.openaiApiKey !== '' && response.openaiApiKey !== '***'
      })),
      catchError(error => {
        console.error('Error checking API keys:', error);
        return of({ hasClaudeKey: false, hasOpenAIKey: false });
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
