// clippy/frontend/src/app/models/saved-link.model.ts

export interface SavedLink {
  id: string;
  url: string;
  title?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  date_added: string;
  date_completed?: string;
  download_path?: string;
  thumbnail_path?: string;
  video_id?: string;
  error_message?: string;
  metadata?: any;
}

export interface SavedLinkCreateRequest {
  url: string;
  title?: string;
}
