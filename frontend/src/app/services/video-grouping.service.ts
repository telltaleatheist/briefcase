import { Injectable } from '@angular/core';
import { DatabaseVideo } from './database-library.service';

export interface VideoGroup {
  week: string;
  videos: DatabaseVideo[];
}

/**
 * Service for grouping videos by date/week and handling date utilities
 */
@Injectable({
  providedIn: 'root'
})
export class VideoGroupingService {
  /**
   * Group videos by week using download date
   */
  groupVideosByWeek(videos: DatabaseVideo[]): VideoGroup[] {
    const groups = new Map<string, DatabaseVideo[]>();

    for (const video of videos) {
      const downloadDate = this.parseDateSafely(video.download_date || video.added_at);
      const week = this.getWeekIdentifier(downloadDate);

      if (!groups.has(week)) {
        groups.set(week, []);
      }

      // If this is a child video, insert a ghost parent reference first
      if (video.parent_id) {
        const parent = videos.find(v => v.id === video.parent_id);
        if (parent) {
          const ghostParent = {
            ...parent,
            isGhostParent: true,
            ghostChildId: video.id
          } as any;
          groups.get(week)!.push(ghostParent);
        }
      }

      groups.get(week)!.push(video);
    }

    // Convert to array and sort by week name (descending - newest first)
    return Array.from(groups.entries())
      .map(([week, videos]) => ({ week, videos }))
      .sort((a, b) => b.week.localeCompare(a.week));
  }

  /**
   * Get week identifier for a date (Sunday of that week in yyyy-mm-dd format)
   */
  getWeekIdentifier(date: Date): string {
    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);

    // Get the Sunday of this week (start of week)
    const day = tempDate.getDay();
    const diff = tempDate.getDate() - day;
    tempDate.setDate(diff);

    // Format as yyyy-mm-dd
    const year = tempDate.getFullYear();
    const month = String(tempDate.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(tempDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${dayOfMonth}`;
  }

  /**
   * Format week label for display
   */
  formatWeekLabel(weekStart: string | Date): string {
    const date = typeof weekStart === 'string' ? this.parseDateSafely(weekStart) : weekStart;
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    return `Week of ${date.toLocaleDateString('en-US', options)}`;
  }

  /**
   * Parse date string safely, handling YYYY-MM-DD format without timezone shifting
   */
  parseDateSafely(dateString: string): Date {
    // If it's a date-only string (YYYY-MM-DD), parse as local date to avoid timezone shifting
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(year, month - 1, day);
    }
    // Otherwise parse normally (full timestamp)
    return new Date(dateString);
  }
}
