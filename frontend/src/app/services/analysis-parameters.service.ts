// clippy/frontend/src/app/services/analysis-parameters.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { BackendUrlService } from './backend-url.service';

export interface AnalysisCategory {
  name: string;
  description: string;
}

@Injectable({
  providedIn: 'root'
})
export class AnalysisParametersService {
  private http = inject(HttpClient);
  private backendUrlService = inject(BackendUrlService);

  /**
   * Get all analysis categories
   */
  getCategories(): Observable<AnalysisCategory[]> {
    return from(this.backendUrlService.getApiUrl('/analysis/categories')).pipe(
      switchMap(url => this.http.get<AnalysisCategory[]>(url))
    );
  }

  /**
   * Save analysis categories
   */
  saveCategories(categories: AnalysisCategory[]): Observable<void> {
    return from(this.backendUrlService.getApiUrl('/analysis/categories')).pipe(
      switchMap(url => this.http.post<void>(url, { categories }))
    );
  }

  /**
   * Reset categories to defaults
   */
  resetToDefaults(): Observable<AnalysisCategory[]> {
    return from(this.backendUrlService.getApiUrl('/analysis/categories/reset')).pipe(
      switchMap(url => this.http.post<AnalysisCategory[]>(url, {}))
    );
  }
}
