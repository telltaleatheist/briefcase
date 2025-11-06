// frontend/src/app/services/library.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';

export interface VideoInfo {
  originalPath: string;
  currentPath: string;
  clipsWeekFolder?: string;
  filename: string;
  durationSeconds?: number;
  isLinked: boolean;
  lastVerified: string;
}

export interface AnalysisFiles {
  analysis: string;
  analysisMetadata: string;
  transcriptSrt: string;
  transcriptTxt: string;
}

export interface AnalysisMetadata {
  analysisModel: string;
  transcriptionModel: string;
  categories: string[];
}

export interface AnalysisQuote {
  timestamp: string;
  timestampSeconds: number;
  text: string;
  significance: string;
}

export interface AnalysisSection {
  timeRange: string;
  startSeconds: number;
  endSeconds?: number;
  category: string;
  description: string;
  quotes: AnalysisQuote[];
}

export interface ParsedAnalysisMetadata {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds?: number;
  sections: AnalysisSection[];
}

export interface LibraryAnalysis {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  video: VideoInfo;
  files: AnalysisFiles;
  metadata: AnalysisMetadata;
  clips: string[];
}

export interface LibraryClip {
  id: string;
  analysisId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
  createdAt: string;
  notes?: string;
}

export interface LibraryStats {
  totalAnalyses: number;
  activeAnalyses: number;
  archivedAnalyses: number;
  totalClips: number;
  lastUpdated: string;
  version: string;
}

@Injectable({
  providedIn: 'root'
})
export class LibraryService {
  private baseUrl = '/api/library';

  constructor(private http: HttpClient) {}

  /**
   * Get all analyses (optionally filtered by archived status)
   */
  async getAnalyses(archived?: boolean): Promise<LibraryAnalysis[]> {
    const params: Record<string, string> = {};
    if (archived !== undefined) {
      params['archived'] = archived.toString();
    }
    return firstValueFrom(
      this.http.get<LibraryAnalysis[]>(`${this.baseUrl}/analyses`, { params })
    );
  }

  /**
   * Get a single analysis by ID
   */
  async getAnalysis(id: string): Promise<LibraryAnalysis> {
    return firstValueFrom(
      this.http.get<LibraryAnalysis>(`${this.baseUrl}/analyses/${id}`)
    );
  }

  /**
   * Get parsed metadata for an analysis
   */
  async getAnalysisMetadata(id: string): Promise<ParsedAnalysisMetadata> {
    return firstValueFrom(
      this.http.get<ParsedAnalysisMetadata>(`${this.baseUrl}/analyses/${id}/metadata`)
    );
  }

  /**
   * Get transcript text for an analysis
   */
  async getAnalysisTranscript(id: string): Promise<{ exists: boolean; text: string | null }> {
    return firstValueFrom(
      this.http.get<{ exists: boolean; text: string | null }>(`${this.baseUrl}/analyses/${id}/transcript`)
    );
  }

  /**
   * Update an analysis (archive, relink, rename, etc.)
   */
  async updateAnalysis(id: string, update: {
    title?: string;
    archived?: boolean;
    videoCurrentPath?: string;
    videoIsLinked?: boolean;
    clipsWeekFolder?: string;
  }): Promise<LibraryAnalysis> {
    const response = await firstValueFrom(
      this.http.patch<{ success: boolean; analysis: LibraryAnalysis }>(
        `${this.baseUrl}/analyses/${id}`,
        update
      )
    );
    return response.analysis;
  }

  /**
   * Archive an analysis
   */
  async archiveAnalysis(id: string): Promise<LibraryAnalysis> {
    return this.updateAnalysis(id, { archived: true });
  }

  /**
   * Unarchive an analysis
   */
  async unarchiveAnalysis(id: string): Promise<LibraryAnalysis> {
    return this.updateAnalysis(id, { archived: false });
  }

  /**
   * Delete an analysis
   */
  async deleteAnalysis(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${this.baseUrl}/analyses/${id}`
      )
    );
  }

  /**
   * Get all clips for an analysis
   */
  async getClipsForAnalysis(analysisId: string): Promise<LibraryClip[]> {
    return firstValueFrom(
      this.http.get<LibraryClip[]>(`${this.baseUrl}/analyses/${analysisId}/clips`)
    );
  }

  /**
   * Get a single clip
   */
  async getClip(id: string): Promise<LibraryClip> {
    return firstValueFrom(
      this.http.get<LibraryClip>(`${this.baseUrl}/clips/${id}`)
    );
  }

  /**
   * Create a new clip
   */
  async createClip(request: {
    analysisId: string;
    name: string;
    startSeconds: number;
    endSeconds: number;
    outputPath: string;
    notes?: string;
  }): Promise<LibraryClip> {
    const response = await firstValueFrom(
      this.http.post<{ success: boolean; clip: LibraryClip }>(
        `${this.baseUrl}/clips`,
        request
      )
    );
    return response.clip;
  }

  /**
   * Delete a clip
   */
  async deleteClip(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${this.baseUrl}/clips/${id}`
      )
    );
  }

  /**
   * Extract a clip from an analysis video
   */
  async extractClip(
    analysisId: string,
    clipData: {
      startTime: number;
      endTime: number;
      title?: string;
      description?: string;
      category?: string;
      customDirectory?: string;
    }
  ): Promise<any> {
    return firstValueFrom(
      this.http.post<any>(
        `${this.baseUrl}/analyses/${analysisId}/extract-clip`,
        clipData
      )
    );
  }

  /**
   * Get library statistics
   */
  async getStats(): Promise<LibraryStats> {
    return firstValueFrom(
      this.http.get<LibraryStats>(`${this.baseUrl}/stats`)
    );
  }

  /**
   * Get library paths
   */
  async getPaths(): Promise<{
    libraryDir: string;
    libraryPath: string;
    analysesDir: string;
    transcriptsDir: string;
    clipsDir: string;
  }> {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/paths`)
    );
  }

  /**
   * Auto-relink video (searches clips collection)
   */
  async autoRelinkVideo(analysisId: string): Promise<{
    success: boolean;
    suggestedPath?: string;
    confidence?: 'high' | 'low';
    candidates?: Array<{
      filename: string;
      fullPath: string;
      score: number;
    }>;
    reason?: string;
  }> {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/analyses/${analysisId}/auto-relink`, {})
    );
  }

  /**
   * Manual relink video
   */
  async manualRelinkVideo(analysisId: string, videoPath: string): Promise<{
    success: boolean;
    suggestedPath?: string;
    confidence?: 'high' | 'low';
    reason?: string;
  }> {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/analyses/${analysisId}/manual-relink`, {
        videoPath
      })
    );
  }

  /**
   * Verify all videos
   */
  async verifyAllVideos(): Promise<{
    total: number;
    linked: number;
    broken: number;
    fixed: number;
  }> {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/verify-all`, {})
    );
  }

  /**
   * Search clips collection for a video
   */
  async searchClipsCollection(filename: string): Promise<{ results: string[] }> {
    return firstValueFrom(
      this.http.get<{ results: string[] }>(`${this.baseUrl}/search-clips`, {
        params: { filename }
      })
    );
  }
}
