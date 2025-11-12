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
  // Metadata field to display on the right side (e.g., 'duration', 'size')
  metadataField?: string;
  // Icon field (e.g., 'icon', 'mediaType')
  iconField?: string;
  // Status indicator field (e.g., 'status', 'hasTranscript')
  statusField?: string;
  // Badge field (e.g., 'extension', 'fileType')
  badgeField?: string;
  // Custom renderer functions
  renderPrimary?: (item: ListItem) => string;
  renderSecondary?: (item: ListItem) => string;
  renderMetadata?: (item: ListItem) => string;
  renderIcon?: (item: ListItem) => string;
}

/**
 * Item progress for visual progress bar indicator
 */
export interface ItemProgress {
  value: number; // Progress value 0-100
  color?: string; // Optional custom color (defaults to accent color)
  label?: string; // Optional label for accessibility
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

// ========================================
// Cascade-Specific Types (Hierarchical Items)
// ========================================

/**
 * Status of a child task/item
 */
export type CascadeChildStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

/**
 * Child item (ghost item) that belongs to a parent
 * Represents a sub-task, step, or related item
 */
export interface CascadeChild {
  /** Unique identifier for this child */
  id: string;

  /** ID of the parent item */
  parentId: string;

  /** Display label (e.g., "Transcribe", "Analyze", "Step 1") */
  label: string;

  /** Material icon name */
  icon?: string;

  /** Progress of this child task */
  progress?: ItemProgress;

  /** Current status of this child */
  status?: CascadeChildStatus;

  /** Additional metadata to display */
  metadata?: string;

  /** Custom data */
  data?: any;
}

/**
 * Extended ListItem that supports hierarchical children
 */
export interface CascadeItem extends ListItem {
  /** Child items (ghosts) for this parent */
  children?: CascadeChild[];

  /** Whether this item is currently expanded */
  expanded?: boolean;

  /** Master progress calculated from children */
  masterProgress?: number;
}

/**
 * Configuration for children/ghost items
 */
export interface ChildrenConfig<T extends CascadeItem = CascadeItem> {
  /** Enable child item support */
  enabled: boolean;

  /** Allow user to expand/collapse children */
  expandable: boolean;

  /** Start items expanded by default */
  defaultExpanded: boolean;

  /** Function to dynamically generate children for an item */
  generator?: (item: T) => CascadeChild[];

  /** Show master progress bar on parent (calculated from children) */
  showMasterProgress: boolean;

  /** Custom function to calculate master progress (defaults to average) */
  masterProgressCalculator?: (item: T) => number;

  /** Allow clicking on child items */
  clickable?: boolean;

  /** Show status icons on children */
  showStatus?: boolean;
}

/**
 * Complete configuration for Cascade list
 * Extends ItemDisplayConfig with children support
 */
export interface CascadeConfig<T extends CascadeItem = CascadeItem> extends ItemDisplayConfig {
  /** Configuration for hierarchical children */
  children?: ChildrenConfig<T>;
}

/**
 * Events specific to cascading children
 */
export interface CascadeEvents<T extends CascadeItem = CascadeItem> extends ItemListEvents<T> {
  /** Emitted when a parent item is expanded */
  childrenExpanded: { item: T };

  /** Emitted when a parent item is collapsed */
  childrenCollapsed: { item: T };

  /** Emitted when a child item is clicked */
  childClicked: { parent: T; child: CascadeChild };
}
