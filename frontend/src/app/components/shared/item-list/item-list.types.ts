/**
 * Generic list item interface that can represent any type of item
 */
export interface ListItem {
  id: string;
  [key: string]: any; // Allow any additional properties
}

/**
 * Group of items (for accordion/collapsible sections)
 */
export interface ItemGroup<T extends ListItem = ListItem> {
  id: string;
  label: string;
  items: T[];
  collapsed?: boolean;
  metadata?: any; // Additional group-level data
}

/**
 * Configuration for item display
 */
export interface ItemDisplayConfig {
  // Primary field to display (e.g., 'title', 'filename')
  primaryField: string;
  // Secondary field to display (e.g., 'date', 'duration')
  secondaryField?: string;
  // Icon field (e.g., 'icon', 'mediaType')
  iconField?: string;
  // Status indicator field (e.g., 'status', 'hasTranscript')
  statusField?: string;
  // Badge field (e.g., 'extension', 'fileType')
  badgeField?: string;
  // Custom renderer functions
  renderPrimary?: (item: ListItem) => string;
  renderSecondary?: (item: ListItem) => string;
  renderIcon?: (item: ListItem) => string;
}

/**
 * Configuration for grouping items
 */
export interface GroupConfig<T extends ListItem = ListItem> {
  enabled: boolean;
  // Function to generate group key from item
  groupBy: (item: T) => string;
  // Function to generate group label from key
  groupLabel: (key: string) => string;
  // Sort groups (descending by default for dates)
  sortDescending?: boolean;
  // Allow group selection
  selectableGroups?: boolean;
}

/**
 * Keyboard shortcut configuration
 */
export interface KeyboardConfig {
  // Enable arrow key navigation
  enableArrowNavigation?: boolean;
  // Enable type-ahead search
  enableTypeAhead?: boolean;
  // Type-ahead field to search
  typeAheadField?: string;
  // Enable spacebar for preview/action
  enableSpaceAction?: boolean;
  // Enable delete key
  enableDelete?: boolean;
  // Enable select all (Cmd/Ctrl+A)
  enableSelectAll?: boolean;
  // Enable escape to deselect
  enableEscapeDeselect?: boolean;
}

/**
 * Selection mode
 */
export enum SelectionMode {
  None = 'none',
  Single = 'single',
  Multiple = 'multiple'
}

/**
 * Item status for visual indicators
 */
export interface ItemStatus {
  color: string; // Color of status dot (e.g., 'green', 'red', '#ff6600')
  tooltip?: string; // Tooltip text
}

/**
 * Context menu action
 */
export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean | ((items: ListItem[]) => boolean);
  divider?: boolean; // Show divider after this action
}

/**
 * Events emitted by the list component
 */
export interface ItemListEvents<T extends ListItem = ListItem> {
  itemClick: T;
  itemDoubleClick: T;
  itemsSelected: T[];
  itemsDeselected: T[];
  spaceAction: T | null; // Current highlighted/selected item
  deleteAction: T[];
  contextMenuAction: { action: string; items: T[] };
  groupToggle: { groupId: string; collapsed: boolean };
  groupSelect: { groupId: string; items: T[] };
}
