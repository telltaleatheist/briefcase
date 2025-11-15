import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface RelinkStatus {
  relinkingInProgress: boolean;
  activeLibrary: {
    id: string;
    name: string;
    clipsFolderPath: string;
  } | null;
}

export interface RelinkResult {
  success: boolean;
  stats: {
    totalFiles: number;
    filesScanned: number;
    matched: number;
    updated: number;
    notFound: number;
    copied: number;
    errors: string[];
  };
  backupPath?: string;
}

@Injectable({
  providedIn: 'root'
})
export class RelinkingService {
  private readonly API_BASE = 'http://localhost:3000/api/database/relink';

  constructor(private http: HttpClient) {}

  /**
   * Get current relinking status
   */
  getStatus(): Observable<RelinkStatus> {
    return this.http.get<RelinkStatus>(`${this.API_BASE}/status`);
  }

  /**
   * Run preview (dry run)
   */
  preview(targetPath: string, copyMissingFiles: boolean = false): Observable<any> {
    return this.http.post(`${this.API_BASE}/preview`, { targetPath, copyMissingFiles });
  }

  /**
   * Run actual relinking
   */
  relink(targetPath: string, updateLibraryPath: boolean = true, copyMissingFiles: boolean = false): Observable<any> {
    return this.http.post(`${this.API_BASE}/run`, { targetPath, updateLibraryPath, copyMissingFiles });
  }

  /**
   * Get relinking instructions
   */
  getInstructions(): Observable<any> {
    return this.http.get(`${this.API_BASE}/instructions`);
  }
}
