import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { BackendUrlService } from './backend-url.service';
import { VideoItem } from '../models/video.model';

export interface UnimportedVideo {
  filename: string;
  fullPath: string;
  uploadDate?: string;
  hash?: string;
  matches?: Array<{
    id: string;
    filename: string;
    current_path: string;
    similarity: number;
  }>;
  isDuplicate?: boolean;
  duplicateOf?: {
    id: string;
    filename: string;
    current_path: string;
  };
}

export interface MissingFile {
  id: string;
  filename: string;
  current_path: string;
  upload_date: string | null;
  download_date: string | null;
  file_hash: string;
  is_linked: number;
  potentialMatches?: Array<{
    path: string;
    directory: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
}

export interface DuplicateEntry {
  file_hash: string;
  count: number;
  videos: Array<{
    id: string;
    filename: string;
    current_path: string;
    upload_date: string | null;
  }>;
}

export interface ScanResponse<T> {
  success: boolean;
  data?: T;
  videos?: T; // Backend sometimes uses 'videos' instead of 'data'
  duplicates?: T; // Backend uses 'duplicates' for duplicate scan
  error?: string;
  count?: number;
}

@Injectable({
  providedIn: 'root'
})
export class VideoManagerService {
  private http = inject(HttpClient);
  private backendUrlService = inject(BackendUrlService);
  private baseUrlPromise: Promise<string>;

  constructor() {
    this.baseUrlPromise = this.backendUrlService.getApiUrl('/database');
  }

  /**
   * Scan for files on disk that are not in the database
   */
  scanOrphanedFiles(): Observable<ScanResponse<UnimportedVideo[]>> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.get<ScanResponse<UnimportedVideo[]>>(`${baseUrl}/unimported`))
    );
  }

  /**
   * Scan for database entries where the file is missing from disk
   */
  scanOrphanedEntries(): Observable<ScanResponse<MissingFile[]>> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.get<ScanResponse<MissingFile[]>>(`${baseUrl}/missing-files`))
    );
  }

  /**
   * Scan for duplicate database entries (same file hash)
   */
  scanDuplicates(): Observable<ScanResponse<DuplicateEntry[]>> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.get<ScanResponse<DuplicateEntry[]>>(`${baseUrl}/duplicate-entries`))
    );
  }

  /**
   * Delete unimported files from disk
   */
  deleteUnimportedFiles(filePaths: string[]): Observable<any> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.post(`${baseUrl}/delete-unimported-files`, { filePaths }))
    );
  }

  /**
   * Delete orphaned database entries
   */
  deleteOrphanedEntries(videoIds: string[]): Observable<any> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.post(`${baseUrl}/prune-selected`, { videoIds }))
    );
  }

  /**
   * Import selected unimported files into database
   */
  importFiles(filePaths: string[]): Observable<any> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.post(`${baseUrl}/import`, { filePaths }))
    );
  }

  /**
   * Attempt to relink orphaned database entries
   */
  relinkOrphanedEntries(videoIds: string[], options?: {
    searchFolder?: string;
    autoScan?: boolean;
  }): Observable<any> {
    return from(this.baseUrlPromise).pipe(
      switchMap(baseUrl => this.http.post(`${baseUrl}/relink`, {
        videoIds,
        ...options
      }))
    );
  }
}