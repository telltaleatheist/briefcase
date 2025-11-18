import { Injectable } from '@angular/core';
import { DatabaseVideo } from './database-library.service';
import { VideoGroupingService } from './video-grouping.service';
import { VideoUrlService } from './video-url.service';
import { ItemStatus } from '../libs/cascade/src/lib/types/cascade.types';

/**
 * Service for formatting and displaying video information
 */
@Injectable({
  providedIn: 'root'
})
export class VideoDisplayService {
  constructor(
    private videoGroupingService: VideoGroupingService,
    private videoUrlService: VideoUrlService
  ) {}

  /**
   * Get clean display name from video filename
   * Removes extension and leading date patterns
   */
  getVideoDisplayName(video: DatabaseVideo): string {
    let name = video.filename;

    // Remove extension if present
    if (video.file_extension) {
      name = name.replace(new RegExp(video.file_extension + '$'), '');
    }

    // Remove leading date patterns from display:
    // - YYYY-MM-DD: "2025-11-02 - filename"
    // - YYYY-MM-TT: "2025-11-T1" or "2025-11-T2" or "2025-11-T3" (trimester format)
    // - YYYY-MM: "2025-11 filename"
    // - YYYY: "2025 filename"
    // Followed by optional separators: space, dash, underscore
    name = name.replace(/^\d{4}(-\d{2}(-(\d{2}|T[123]))?)?[\s_-]*/, '');

    return name;
  }

  /**
   * Format secondary text for video display (suggested title, upload date, download date)
   */
  formatVideoSecondaryText(video: DatabaseVideo): string {
    const parts: string[] = [];

    // Name suggestion with preview
    if (video.suggested_title) {
      // Show first 60 characters of suggested title
      const preview = video.suggested_title.length > 60
        ? video.suggested_title.substring(0, 60) + '...'
        : video.suggested_title;

      // Show preview of suggested title with instruction to right-click
      parts.push(`<span class="suggested-title">💡 Suggested: ${preview} <em>(right-click to edit)</em></span>`);
    }

    // Upload date (from filename) - when content was created/filmed
    if (video.upload_date) {
      const uploadDate = this.videoGroupingService.parseDateSafely(video.upload_date);
      parts.push(`Uploaded: ${uploadDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    }

    // Download date (when file was created/downloaded)
    if (video.download_date) {
      const downloadDate = this.videoGroupingService.parseDateSafely(video.download_date);
      parts.push(`Downloaded: ${downloadDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    }

    return parts.join(' • ');
  }

  /**
   * Format video duration for display (MM:SS or H:MM:SS)
   */
  formatVideoDuration(video: DatabaseVideo): string {
    if (!video.duration_seconds) {
      return '';
    }

    const hours = Math.floor(video.duration_seconds / 3600);
    const mins = Math.floor((video.duration_seconds % 3600) / 60);
    const secs = Math.floor(video.duration_seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Get media icon for a video based on its type
   */
  getMediaIcon(video: DatabaseVideo): string {
    const mediaType = this.videoUrlService.inferMediaType(video);
    switch (mediaType) {
      case 'video': return 'movie';
      case 'audio': return 'audiotrack';
      case 'document': return 'description';
      case 'image': return 'image';
      case 'webpage': return 'language';
      default: return 'description';
    }
  }

  /**
   * Get media type icon for a media type string
   */
  getMediaTypeIcon(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'videocam';
      case 'audio':
        return 'audiotrack';
      case 'document':
        return 'description';
      case 'image':
        return 'image';
      case 'webpage':
        return 'public';
      default:
        return 'video_library';
    }
  }

  /**
   * Get media type label for a media type string
   */
  getMediaTypeLabel(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'Video';
      case 'audio':
        return 'Audio';
      case 'document':
        return 'Document';
      case 'image':
        return 'Image';
      case 'webpage':
        return 'Web Page';
      default:
        return 'Media';
    }
  }

  /**
   * Format date string for display
   */
  formatDate(dateString: string | null): string {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  }

  /**
   * Format date for display in chip (handles trimester format)
   */
  formatDateChip(date: string): string {
    if (!date) return '';

    // Check if it's a trimester format
    if (date.match(/^\d{4}-\d{2}-T[123]$/)) {
      return date; // Display as-is for trimester format
    }

    // Standard date format
    return date;
  }

  /**
   * Format time remaining in seconds to human-readable string
   */
  formatTimeRemaining(seconds: number | undefined): string {
    if (!seconds) return 'Calculating...';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `~${hours}h ${minutes}m remaining`;
    } else if (minutes > 0) {
      return `~${minutes}m remaining`;
    } else {
      return `<1m remaining`;
    }
  }

  /**
   * Map video status to visual indicator
   * Returns color and tooltip based on transcript/analysis status
   */
  getVideoStatusMapper(video: DatabaseVideo, allVideos: DatabaseVideo[]): ItemStatus | null {
    // Look up the video from allVideos to get correct flags
    const sourceVideo = allVideos.find(v => v.id === video.id);
    if (!sourceVideo) {
      console.warn(`[getVideoStatusMapper] Video ${video.id} not found in allVideos`);
      return { color: '#999999', tooltip: 'Unknown status' }; // Gray
    }

    // Use flags from sourceVideo (which always has correct data)
    const has_transcript = sourceVideo.has_transcript;
    const has_analysis = sourceVideo.has_analysis;
    const duration_seconds = sourceVideo.duration_seconds || video.duration_seconds;

    // Non-video/audio files (documents, webpages, images) are always green
    const mediaType = this.videoUrlService.inferMediaType(sourceVideo);
    if (mediaType !== 'video' && mediaType !== 'audio') {
      return { color: '#198754', tooltip: 'Document/webpage/image' }; // Green
    }

    // Priority: missing both > has transcript only > has analysis (complete)
    if (!has_transcript && !has_analysis) {
      return { color: '#dc3545', tooltip: 'Missing transcript and analysis' }; // Red
    }
    if (!has_analysis) {
      // Has transcript but no analysis
      return { color: '#ff6600', tooltip: 'Missing analysis' }; // Orange
    }
    // If has_analysis is true, transcript must exist (can't analyze without transcript)
    // Long videos (>10 min) get blue marker
    if (duration_seconds && duration_seconds > 600) {
      return { color: '#0dcaf0', tooltip: 'Complete (>10 min)' }; // Blue
    }
    // Short videos (<10 min) get green marker
    return { color: '#198754', tooltip: 'Complete' }; // Green
  }
}
