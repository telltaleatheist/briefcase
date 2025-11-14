import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environment/environment';
import { firstValueFrom } from 'rxjs';

interface TopicData {
  name: string;
  type: string;
  count: number;
  videoCount: number;
}

interface HealthData {
  totalVideos: number;
  videosWithTranscripts: number;
  videosWithAnalyses: number;
  videosNeedingTranscripts: number;
  videosNeedingAnalysis: number;
  completionRate: number;
  totalDurationSeconds: number;
  totalFileSizeBytes: number;
}

interface TrendData {
  period: string;
  videoCount: number;
  topTags: Array<{ name: string; type: string; count: number }>;
}

interface NetworkNode {
  id: string;
  name: string;
  type: string;
  connectionCount: number;
}

interface NetworkEdge {
  source: string;
  target: string;
  weight: number;
}

interface AIInsightsData {
  overview: string;
  keyFindings: string[];
  recommendations: string[];
  contentGaps: string[];
}

interface AIInsightsMetadata {
  generatedAt: string;
  videosAnalyzed: number;
  aiModel: string;
  generationTimeSeconds?: number;
}

interface OllamaModel {
  name: string;
  size: number;
}

type AIProvider = 'ollama' | 'claude' | 'openai';

@Component({
  selector: 'app-analytics-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatTabsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatCardModule,
    MatChipsModule,
    MatSelectModule,
    MatFormFieldModule,
  ],
  templateUrl: './analytics-dialog.component.html',
  styleUrls: ['./analytics-dialog.component.scss'],
})
export class AnalyticsDialogComponent implements OnInit {
  loading = false;
  error: string | null = null;

  // Math reference for template
  Math = Math;

  // Data
  topics: TopicData[] = [];
  health: HealthData | null = null;
  trends: TrendData[] = [];
  networkNodes: NetworkNode[] = [];
  networkEdges: NetworkEdge[] = [];

  // Topic grouping
  topicsByType: { topic: TopicData[]; person: TopicData[]; other: TopicData[] } = {
    topic: [],
    person: [],
    other: [],
  };

  // AI Insights
  aiInsights: AIInsightsData | null = null;
  aiInsightsMetadata: AIInsightsMetadata | null = null;
  generatingInsights = false;
  insightsError: string | null = null;

  // AI Model Selection
  selectedProvider: AIProvider = 'ollama';
  selectedModel: string = 'qwen2.5:7b';
  selectedModelFull: string = 'ollama:qwen2.5:7b';
  ollamaModels: OllamaModel[] = [];
  loadingModels = false;

  constructor(
    private dialogRef: MatDialogRef<AnalyticsDialogComponent>,
    private http: HttpClient
  ) {}

  async ngOnInit() {
    await Promise.all([
      this.loadAllAnalytics(),
      this.loadCachedInsights(),
      this.loadOllamaModels(),
    ]);
  }

  /**
   * Load all analytics data
   */
  async loadAllAnalytics() {
    this.loading = true;
    this.error = null;

    try {
      // Load all analytics in parallel
      const [healthResp, topicsResp, trendsResp, networkResp] = await Promise.all([
        this.http.get<any>(`${environment.apiBaseUrl}/library/analytics/health`).toPromise(),
        this.http.get<any>(`${environment.apiBaseUrl}/library/analytics/topics?limit=50`).toPromise(),
        this.http.get<any>(`${environment.apiBaseUrl}/library/analytics/trends?groupBy=month`).toPromise(),
        this.http.get<any>(`${environment.apiBaseUrl}/library/analytics/network?minConnections=2`).toPromise(),
      ]);

      // Process health data
      if (healthResp?.success && healthResp.health) {
        this.health = healthResp.health;
      }

      // Process topics data
      if (topicsResp?.success) {
        this.topics = topicsResp.topics || [];
        this.topicsByType = topicsResp.byType || { topic: [], person: [], other: [] };
      }

      // Process trends data
      if (trendsResp?.success) {
        this.trends = trendsResp.timeline || [];
      }

      // Process network data
      if (networkResp?.success && networkResp.network) {
        this.networkNodes = networkResp.network.nodes || [];
        this.networkEdges = networkResp.network.edges || [];
      }
    } catch (error: any) {
      console.error('Failed to load analytics:', error);
      this.error = error.message || 'Failed to load analytics data';
    } finally {
      this.loading = false;
    }
  }

  /**
   * Format bytes to human-readable size
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format duration in seconds to human-readable format
   */
  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Load cached AI insights if available
   */
  async loadCachedInsights() {
    try {
      const response = await this.http.get<any>(`${environment.apiBaseUrl}/library/analytics/insights`).toPromise();

      if (response?.success && response.hasInsights) {
        this.aiInsights = response.insights;
        this.aiInsightsMetadata = response.metadata;
      }
    } catch (error: any) {
      console.error('Failed to load cached insights:', error);
      // Silently fail - insights are optional
    }
  }

  /**
   * Load available Ollama models
   */
  async loadOllamaModels(): Promise<void> {
    this.loadingModels = true;
    try {
      const response = await firstValueFrom(
        this.http.get<{ success: boolean; connected: boolean; models: OllamaModel[] }>(
          `${environment.apiBaseUrl}/analysis/models`
        )
      );

      if (response.success && response.connected && response.models) {
        this.ollamaModels = response.models;
      } else {
        this.ollamaModels = [];
      }
    } catch (error) {
      console.error('Failed to load Ollama models:', error);
      this.ollamaModels = [];
    } finally {
      this.loadingModels = false;
    }
  }

  /**
   * Handle model selection change
   */
  onModelChange(): void {
    if (!this.selectedModelFull) return;

    // Parse provider:model format
    const [provider, ...modelParts] = this.selectedModelFull.split(':');
    const model = modelParts.join(':'); // Handle model names with colons

    this.selectedProvider = provider as AIProvider;
    this.selectedModel = model;
  }

  /**
   * Get display name for a model
   */
  getDisplayName(modelFull: string): string {
    if (!modelFull) return '';

    const displayNames: Record<string, string> = {
      'claude:claude-sonnet-4-20250514': 'Claude Sonnet 4.5 (Newest)',
      'claude:claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet (Recommended)',
      'claude:claude-3-5-haiku-20241022': 'Claude 3.5 Haiku (Faster)',
      'openai:gpt-4o': 'GPT-4o (Best)',
      'openai:gpt-4o-mini': 'GPT-4o Mini (Faster)',
      'openai:gpt-4-turbo': 'GPT-4 Turbo',
      'openai:gpt-3.5-turbo': 'GPT-3.5 Turbo (Faster, Cheaper)'
    };

    if (displayNames[modelFull]) {
      return displayNames[modelFull];
    }

    // For Ollama models, just return the model name
    if (modelFull.startsWith('ollama:')) {
      return modelFull.substring(7); // Remove "ollama:" prefix
    }

    return modelFull;
  }

  /**
   * Generate new AI insights
   */
  async generateInsights() {
    this.generatingInsights = true;
    this.insightsError = null;

    try {
      const response = await this.http.post<any>(
        `${environment.apiBaseUrl}/library/analytics/generate-insights`,
        {
          aiProvider: this.selectedProvider,
          aiModel: this.selectedModel,
        }
      ).toPromise();

      if (response?.success) {
        this.aiInsights = response.insights;
        this.aiInsightsMetadata = response.metadata;
      } else {
        throw new Error('Failed to generate insights');
      }
    } catch (error: any) {
      console.error('Failed to generate AI insights:', error);
      this.insightsError = error.message || 'Failed to generate AI insights';
    } finally {
      this.generatingInsights = false;
    }
  }

  /**
   * Format timestamp to readable date
   */
  formatDate(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toLocaleString();
  }

  /**
   * Close dialog
   */
  close() {
    this.dialogRef.close();
  }
}
