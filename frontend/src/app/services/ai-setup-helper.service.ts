import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, of, from } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { BackendUrlService } from './backend-url.service';

export interface AIAvailability {
  hasOllama: boolean;
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
  ollamaModels: string[];
  ollamaEndpoint: string;
  isChecking: boolean;
  lastChecked?: Date;
}

export interface AISetupStatus {
  isReady: boolean;
  needsSetup: boolean;
  availableProviders: ('ollama' | 'claude' | 'openai')[];
  recommendedAction?: 'install-ollama' | 'add-api-key' | 'ready';
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AiSetupHelperService {
  private availabilitySubject = new BehaviorSubject<AIAvailability>({
    hasOllama: false,
    hasClaudeKey: false,
    hasOpenAIKey: false,
    ollamaModels: [],
    ollamaEndpoint: 'http://localhost:11434',
    isChecking: false
  });

  public availability$ = this.availabilitySubject.asObservable();

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  /**
   * Check all AI providers and update availability status
   */
  async checkAIAvailability(): Promise<AIAvailability> {
    this.availabilitySubject.next({
      ...this.availabilitySubject.value,
      isChecking: true
    });

    try {
      // Check Ollama availability
      const ollamaCheck = await this.checkOllama().toPromise();

      // Check API keys
      const apiKeysCheck = await this.checkAPIKeys().toPromise();

      const availability: AIAvailability = {
        hasOllama: ollamaCheck?.available || false,
        ollamaModels: ollamaCheck?.models || [],
        ollamaEndpoint: ollamaCheck?.endpoint || 'http://localhost:11434',
        hasClaudeKey: apiKeysCheck?.hasClaudeKey || false,
        hasOpenAIKey: apiKeysCheck?.hasOpenAIKey || false,
        isChecking: false,
        lastChecked: new Date()
      };

      this.availabilitySubject.next(availability);
      return availability;
    } catch (error) {
      console.error('Error checking AI availability:', error);
      this.availabilitySubject.next({
        ...this.availabilitySubject.value,
        isChecking: false,
        lastChecked: new Date()
      });
      return this.availabilitySubject.value;
    }
  }

  /**
   * Get current setup status and recommendations
   */
  getSetupStatus(): Observable<AISetupStatus> {
    return this.availability$.pipe(
      map(availability => {
        const availableProviders: ('ollama' | 'claude' | 'openai')[] = [];

        if (availability.hasOllama && availability.ollamaModels.length > 0) {
          availableProviders.push('ollama');
        }
        if (availability.hasClaudeKey) {
          availableProviders.push('claude');
        }
        if (availability.hasOpenAIKey) {
          availableProviders.push('openai');
        }

        const isReady = availableProviders.length > 0;
        const needsSetup = !isReady;

        let recommendedAction: 'install-ollama' | 'add-api-key' | 'ready' = 'ready';
        let message = '';

        if (!isReady) {
          recommendedAction = 'install-ollama';
          message = 'No AI providers configured. Install Ollama for free local AI, or add an API key for Claude/ChatGPT.';
        } else if (availableProviders.includes('ollama')) {
          recommendedAction = 'ready';
          message = `Ready with Ollama (${availability.ollamaModels.length} models available)`;
        } else {
          recommendedAction = 'ready';
          message = `Ready with API key (${availableProviders.join(', ')})`;
        }

        return {
          isReady,
          needsSetup,
          availableProviders,
          recommendedAction,
          message
        };
      })
    );
  }

  /**
   * Check if Ollama is installed and running
   */
  private checkOllama(): Observable<{ available: boolean; models: string[]; endpoint: string }> {
    return from(this.backendUrlService.getApiUrl('/analysis/models')).pipe(
      switchMap(url => this.http.get<any>(url)),
      map(response => {
        // Backend returns { connected: true/false, models: [...] }
        const isAvailable = response.connected || response.success || false;
        const modelList = response.models || [];

        // Extract model names from the response
        // Models can be either strings or objects with 'name' property
        const modelNames = modelList.map((m: any) =>
          typeof m === 'string' ? m : (m.name || m.model || '')
        ).filter((name: string) => name !== '');

        return {
          available: isAvailable,
          models: modelNames,
          endpoint: 'http://localhost:11434'
        };
      }),
      catchError(error => {
        console.error('Error checking Ollama:', error);
        return of({ available: false, models: [], endpoint: 'http://localhost:11434' });
      })
    );
  }

  /**
   * Check which API keys are configured
   */
  private checkAPIKeys(): Observable<{ hasClaudeKey: boolean; hasOpenAIKey: boolean }> {
    return from(this.backendUrlService.getApiUrl('/config/api-keys')).pipe(
      switchMap(url => this.http.get<any>(url)),
      map(response => ({
        hasClaudeKey: !!response.claudeApiKey && response.claudeApiKey !== '',
        hasOpenAIKey: !!response.openaiApiKey && response.openaiApiKey !== ''
      })),
      catchError(error => {
        console.error('Error checking API keys:', error);
        return of({ hasClaudeKey: false, hasOpenAIKey: false });
      })
    );
  }

  /**
   * Get installation instructions for Ollama
   */
  getOllamaInstallInstructions(): { platform: string; steps: string[] } {
    const platform = this.detectPlatform();

    const instructions = {
      mac: {
        platform: 'macOS',
        steps: [
          '1. Download Ollama from https://ollama.com/download',
          '2. Open the downloaded .dmg file',
          '3. Drag Ollama to your Applications folder',
          '4. Open Ollama from Applications',
          '5. Open Terminal and run: ollama pull qwen2.5:7b',
          '6. Wait for the model to download (about 4 GB)',
          '7. Come back here and we\'ll detect it automatically!'
        ]
      },
      windows: {
        platform: 'Windows',
        steps: [
          '1. Download Ollama from https://ollama.com/download',
          '2. Run the installer (.exe file)',
          '3. Follow the installation wizard',
          '4. Open Command Prompt or PowerShell',
          '5. Run: ollama pull qwen2.5:7b',
          '6. Wait for the model to download (about 4 GB)',
          '7. Come back here and we\'ll detect it automatically!'
        ]
      },
      linux: {
        platform: 'Linux',
        steps: [
          '1. Open Terminal',
          '2. Run: curl -fsSL https://ollama.com/install.sh | sh',
          '3. Wait for installation to complete',
          '4. Run: ollama pull qwen2.5:7b',
          '5. Wait for the model to download (about 4 GB)',
          '6. Come back here and we\'ll detect it automatically!'
        ]
      }
    };

    return instructions[platform] || instructions.mac;
  }

  /**
   * Get recommended models for first-time setup
   */
  getRecommendedModels() {
    return [
      {
        name: 'qwen2.5:7b',
        size: '4 GB',
        description: 'Balanced performance and speed - great for most users',
        ramRequirement: 'Needs 8 GB RAM minimum',
        recommended: true,
        pullCommand: 'ollama pull qwen2.5:7b'
      },
      {
        name: 'llama3.2:3b',
        size: '2 GB',
        description: 'Lightweight and fast - good for quick analysis',
        ramRequirement: 'Needs 4 GB RAM minimum',
        recommended: false,
        pullCommand: 'ollama pull llama3.2:3b'
      },
      {
        name: 'qwen2.5:14b',
        size: '9 GB',
        description: 'Higher quality - requires more RAM',
        ramRequirement: 'Needs 16 GB RAM minimum',
        recommended: false,
        pullCommand: 'ollama pull qwen2.5:14b'
      }
    ];
  }

  private detectPlatform(): 'mac' | 'windows' | 'linux' {
    const userAgent = window.navigator.userAgent.toLowerCase();

    if (userAgent.indexOf('mac') !== -1) {
      return 'mac';
    } else if (userAgent.indexOf('win') !== -1) {
      return 'windows';
    } else {
      return 'linux';
    }
  }
}
