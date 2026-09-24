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
  /** Tooltip, e.g. why a disabled item can't run. */
  title?: string;
  submenu?: ContextMenuAction[]; // For nested submenu items
  hasArrow?: boolean; // Show arrow indicator for submenu
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}
