export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedDate?: Date;
  children?: FileNode[];
  expanded?: boolean;
  selected?: boolean;
  path: string;
  icon?: string;
  extension?: string;
}

export interface ContextMenuAction {
  label: string;
  icon: string;
  action: string;
  divider?: boolean;
  disabled?: boolean;
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}
