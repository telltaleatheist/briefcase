// ============================================================================
// RIPPLECUT - Public API
// ============================================================================
// This file provides clean exports for integrating Ripplecut into other projects

export { RipplecutComponent } from './ripplecut.component';

export {
  // Core interfaces
  EditorTab,
  TimelineSection,
  TimelineChapter,
  CustomMarker,
  TimelineClip,
  TranscriptSegment,
  Selection,

  // Configuration
  RipplecutConfig,

  // Event payloads
  PlayheadChangeEvent,
  SelectionChangeEvent,
  ClipChangeEvent,
  MarkerChangeEvent,
  ExportRequestEvent
} from './ripplecut.models';
