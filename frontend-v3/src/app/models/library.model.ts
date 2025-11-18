export interface Library {
  id: string;
  name: string;
  path: string;
  videoCount: number;
  createdDate: Date;
  lastModified: Date;
  size?: number; // bytes
  thumbnail?: string;
}

export interface NewLibrary {
  name: string;
  path: string;
}

export interface RelinkLibrary {
  path: string;
}

export type LibraryManagerMode = 'select' | 'create' | 'relink';
