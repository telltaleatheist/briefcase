import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface MigrationOptions {
  computerName: string;
  nasRoot: string;
  clipsFolder: string;
  downloadsFolder?: string;
  librariesFolder?: string;
  moveClipsTo?: string;
  dryRun?: boolean;
}

export interface MigrationProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export interface MigrationResult {
  success: boolean;
  stats: {
    totalVideos: number;
    pathsConverted: number;
    pathsSkipped: number;
    filesMoved: number;
    errors: string[];
  };
  backupPath?: string;
}

export interface MigrationStatus {
  isConfigured: boolean;
  isSharedMode: boolean;
  migrationInProgress: boolean;
  config: any;
}

export interface PathMappingConfig {
  computerName: string;
  nasRoot: string;
  clipsFolder: string;
  downloadsFolder?: string;
  librariesFolder?: string;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseMigrationService {
  private readonly API_BASE = 'http://localhost:3000/api/database/migration';

  constructor(private http: HttpClient) {}

  /**
   * Get current migration status
   */
  getStatus(): Observable<MigrationStatus> {
    return this.http.get<MigrationStatus>(`${this.API_BASE}/status`);
  }

  /**
   * Run migration preview (dry run)
   */
  previewMigration(options: MigrationOptions): Observable<any> {
    return this.http.post(`${this.API_BASE}/preview`, options);
  }

  /**
   * Run actual migration
   */
  runMigration(options: MigrationOptions): Observable<any> {
    return this.http.post(`${this.API_BASE}/migrate`, options);
  }

  /**
   * Configure path mapping (for additional computers)
   */
  configurePaths(config: PathMappingConfig): Observable<any> {
    return this.http.post(`${this.API_BASE}/configure`, config);
  }

  /**
   * Restore from backup
   */
  restoreFromBackup(backupPath: string): Observable<any> {
    return this.http.post(`${this.API_BASE}/restore`, { backupPath });
  }

  /**
   * Test path translation
   */
  testPath(path: string, direction: 'toRelative' | 'toAbsolute'): Observable<any> {
    return this.http.post(`${this.API_BASE}/test-path`, { path, direction });
  }

  /**
   * Get migration instructions
   */
  getInstructions(): Observable<any> {
    return this.http.get(`${this.API_BASE}/instructions`);
  }
}
