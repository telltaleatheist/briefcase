import { Injectable } from '@angular/core';
import { DatabaseVideo } from './database-library.service';

/**
 * Service for handling video URL generation and media type inference
 */
@Injectable({
  providedIn: 'root'
})
export class VideoUrlService {
  /**
   * Get thumbnail URL for a video
   */
  getVideoThumbnailUrl(video: DatabaseVideo, backendUrl: string): string {
    return `${backendUrl}/api/database/videos/${video.id}/thumbnail`;
  }

  /**
   * Get streaming URL for a video
   * Handles proper encoding of Unicode paths and selects appropriate endpoint based on media type
   */
  getVideoStreamUrl(video: DatabaseVideo, backendUrl: string): string {
    // Properly encode Unicode path to base64
    // Convert string -> UTF-8 bytes -> base64
    const utf8Bytes = new TextEncoder().encode(video.current_path);
    const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
    const encodedPath = btoa(binaryString);

    const mediaType = this.inferMediaType(video);

    // Use dedicated image endpoint for images, video endpoint for everything else
    const endpoint = mediaType === 'image'
      ? '/api/library/images/custom'
      : '/api/library/videos/custom';

    const url = `${backendUrl}${endpoint}?path=${encodeURIComponent(encodedPath)}`;
    console.log(`[VideoUrlService] Media type: ${mediaType}, Path: ${video.current_path}`);
    console.log(`[VideoUrlService] Generated URL: ${url}`);
    return url;
  }

  /**
   * Infer media type from video metadata or file extension
   */
  inferMediaType(video: DatabaseVideo): string {
    if (video.media_type) {
      return video.media_type;
    }

    // Fallback: infer from file extension
    const ext = (video.file_extension || video.filename.substring(video.filename.lastIndexOf('.'))).toLowerCase();

    // Video extensions
    if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.flv', '.ogg'].includes(ext)) {
      return 'video';
    }

    // Audio extensions
    if (['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.oga'].includes(ext)) {
      return 'audio';
    }

    // Image extensions
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      return 'image';
    }

    // Document extensions
    if (['.pdf', '.txt', '.md'].includes(ext)) {
      return 'document';
    }

    // Web archive extensions
    if (['.html', '.htm', '.mhtml'].includes(ext)) {
      return 'webpage';
    }

    return 'video'; // default
  }
}
