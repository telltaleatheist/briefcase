import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * MediaRelationshipService - Manages relationships between media items
 *
 * This service handles linking related media files together, such as:
 * - PDF + Audiobook (same book, different formats)
 * - EPUB + PDF (same content, different formats)
 * - Video + Transcript PDF (related content)
 *
 * Relationship types:
 * - 'audiobook': One item is the audiobook version of the other
 * - 'alternate_format': Different format of the same content
 * - 'related': General related content
 */
@Injectable()
export class MediaRelationshipService {
  private readonly logger = new Logger(MediaRelationshipService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Link two media items together
   * @param primaryMediaId - The primary media item ID
   * @param relatedMediaId - The related media item ID
   * @param relationshipType - Type of relationship ('audiobook', 'alternate_format', 'related')
   * @returns Relationship ID
   */
  linkMedia(
    primaryMediaId: string,
    relatedMediaId: string,
    relationshipType: string = 'related',
  ): string {
    // Verify both media items exist
    const primaryMedia = this.databaseService.getVideoById(primaryMediaId);
    const relatedMedia = this.databaseService.getVideoById(relatedMediaId);

    if (!primaryMedia) {
      throw new Error(`Primary media item not found: ${primaryMediaId}`);
    }

    if (!relatedMedia) {
      throw new Error(`Related media item not found: ${relatedMediaId}`);
    }

    // Create the relationship
    const relationshipId = uuidv4();

    try {
      this.databaseService.insertMediaRelationship({
        id: relationshipId,
        primaryMediaId,
        relatedMediaId,
        relationshipType,
      });

      this.logger.log(
        `Linked media: ${primaryMedia.filename} <-> ${relatedMedia.filename} (${relationshipType})`,
      );

      return relationshipId;
    } catch (error: any) {
      // Check if relationship already exists
      if (error.message && error.message.includes('UNIQUE constraint')) {
        throw new Error('These media items are already linked together');
      }
      throw error;
    }
  }

  /**
   * Get all media items related to a given media item
   * @param mediaId - Media item ID
   * @returns Array of related media items with relationship info
   */
  getRelatedMedia(mediaId: string): RelatedMediaItem[] {
    const relationships = this.databaseService.getRelatedMedia(mediaId);

    return relationships.map((rel: any) => ({
      relationshipId: rel.id,
      mediaId: rel.related_media_id || rel.primary_media_id,
      filename: rel.filename,
      currentPath: rel.current_path,
      mediaType: rel.media_type,
      fileExtension: rel.file_extension,
      relationshipType: rel.relationship_type,
      isPrimary: !!rel.related_media_id, // If related_media_id exists, we're the primary
    }));
  }

  /**
   * Unlink two media items
   * @param relationshipId - Relationship ID to delete
   */
  unlinkMedia(relationshipId: string): void {
    this.databaseService.deleteMediaRelationship(relationshipId);
    this.logger.log(`Unlinked media relationship: ${relationshipId}`);
  }

  /**
   * Unlink all relationships for a media item
   * @param mediaId - Media item ID
   */
  unlinkAllMedia(mediaId: string): void {
    this.databaseService.deleteAllMediaRelationships(mediaId);
    this.logger.log(`Unlinked all relationships for media: ${mediaId}`);
  }

  /**
   * Check if two media items are linked
   * @param mediaId1 - First media item ID
   * @param mediaId2 - Second media item ID
   * @returns True if linked, false otherwise
   */
  areLinked(mediaId1: string, mediaId2: string): boolean {
    const relationships1 = this.getRelatedMedia(mediaId1);
    return relationships1.some((rel) => rel.mediaId === mediaId2);
  }

  /**
   * Get suggested relationship type based on media types
   * @param mediaType1 - First media type
   * @param mediaType2 - Second media type
   * @returns Suggested relationship type
   */
  suggestRelationshipType(mediaType1: string, mediaType2: string): string {
    // If one is audio and the other is document, suggest audiobook
    if (
      (mediaType1 === 'audio' && mediaType2 === 'document') ||
      (mediaType1 === 'document' && mediaType2 === 'audio')
    ) {
      return 'audiobook';
    }

    // If both are documents or same type, suggest alternate_format
    if (mediaType1 === mediaType2) {
      return 'alternate_format';
    }

    // Default to related
    return 'related';
  }
}

export interface RelatedMediaItem {
  relationshipId: string;
  mediaId: string;
  filename: string;
  currentPath: string;
  mediaType: string;
  fileExtension: string;
  relationshipType: string;
  isPrimary: boolean;
}
