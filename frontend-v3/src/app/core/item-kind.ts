import { VideoItem } from '../models/video.model';

/** Library item kinds — the same taxonomy as the library type filter. */
export type ItemKind = 'video' | 'doc' | 'web';

/**
 * Classify a library item by its media type.
 *
 * Single source of truth shared by the library type filter and the
 * inspector's type-aware rendering.
 */
export function classifyItemKind(item: VideoItem): ItemKind {
  const mediaType = item.mediaType?.toLowerCase() || '';
  const isWeb =
    mediaType === 'webpage' || mediaType === 'text/html' || !!item.tags?.includes('webpage');
  if (isWeb) return 'web';

  const isDoc =
    mediaType.startsWith('image/') ||
    mediaType === 'application/pdf' ||
    mediaType.startsWith('text/');
  return isDoc ? 'doc' : 'video';
}
