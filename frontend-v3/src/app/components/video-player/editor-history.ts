import { signal } from '@angular/core';

/**
 * One undoable change in the editor: a deleted section, a resized chapter, a
 * moved highlight. `undo` and `redo` each do the whole change, including
 * saving it, and throw if they can't.
 */
export interface HistoryStep {
  /** What the change was, for the "Undid …" note: "Delete marker". */
  label: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

/**
 * The editor's undo/redo stacks (Cmd+Z / Cmd+Shift+Z), one pair per video, so
 * undoing in one tab never reaches into another. Recording a new change
 * clears that video's redo stack, as everywhere else.
 *
 * Only one undo or redo runs at a time: a key held down queues nothing, it
 * just waits for the previous one to land. A step that fails is dropped
 * rather than put back, since the usual cause is that the thing it names is
 * gone (an analysis re-run replaced the sections), and retrying it would fail
 * the same way on every press.
 */
export class EditorHistory {
  static readonly LIMIT = 200;

  private readonly stacks = new Map<string, { done: HistoryStep[]; undone: HistoryStep[] }>();
  private running = false;

  /** Bumped on every change, so computed views of canUndo/canRedo update. */
  readonly revision = signal(0);

  record(key: string, step: HistoryStep): void {
    const stack = this.stack(key);
    stack.done.push(step);
    if (stack.done.length > EditorHistory.LIMIT) stack.done.shift();
    stack.undone = [];
    this.bump();
  }

  canUndo(key: string | null | undefined): boolean {
    this.revision();
    return !!key && (this.stacks.get(key)?.done.length ?? 0) > 0;
  }

  canRedo(key: string | null | undefined): boolean {
    this.revision();
    return !!key && (this.stacks.get(key)?.undone.length ?? 0) > 0;
  }

  /** Undo the latest change: the step undone, or null when there was nothing to undo (or one is still running). */
  undo(key: string): Promise<HistoryStep | null> {
    return this.move(key, 'undo');
  }

  /** Redo the latest undone change. */
  redo(key: string): Promise<HistoryStep | null> {
    return this.move(key, 'redo');
  }

  /** Forget a video's history, e.g. when an analysis run replaced what its steps name. */
  clear(key: string): void {
    if (this.stacks.delete(key)) this.bump();
  }

  private async move(key: string, direction: 'undo' | 'redo'): Promise<HistoryStep | null> {
    if (this.running) return null;
    const stack = this.stacks.get(key);
    const from = direction === 'undo' ? stack?.done : stack?.undone;
    const step = from?.pop();
    if (!stack || !step) return null;

    this.running = true;
    try {
      await step[direction]();
      (direction === 'undo' ? stack.undone : stack.done).push(step);
      return step;
    } finally {
      this.running = false;
      this.bump();
    }
  }

  private stack(key: string) {
    let stack = this.stacks.get(key);
    if (!stack) {
      stack = { done: [], undone: [] };
      this.stacks.set(key, stack);
    }
    return stack;
  }

  private bump(): void {
    this.revision.update((n) => n + 1);
  }
}

/** The editor rows the backend's editor-rows endpoints take and return (raw DB rows). */
export type EditorTable = 'analysisSections' | 'customMarkers' | 'chapters' | 'muteSections';
export type EditorRows = Partial<Record<EditorTable, Array<Record<string, unknown> & { id: string }>>>;
export type EditorRowIds = Partial<Record<EditorTable, string[]>>;

/** The ids in a set of rows, to remove exactly those rows again. */
export function idsOfRows(rows: EditorRows): EditorRowIds {
  const ids: EditorRowIds = {};
  for (const [table, list] of Object.entries(rows) as Array<[EditorTable, Array<{ id: string }> | undefined]>) {
    if (list?.length) ids[table] = list.map((row) => row.id);
  }
  return ids;
}
