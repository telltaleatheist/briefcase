import { EditorHistory, HistoryStep, idsOfRows } from './editor-history';

describe('EditorHistory', () => {
  /** A step over a shared log, so a test can read the order things ran in. */
  function step(label: string, log: string[], fail?: 'undo' | 'redo'): HistoryStep {
    return {
      label,
      undo: async () => {
        if (fail === 'undo') throw new Error('gone');
        log.push(`undo ${label}`);
      },
      redo: async () => {
        if (fail === 'redo') throw new Error('gone');
        log.push(`redo ${label}`);
      },
    };
  }

  it('undoes newest first, and redo replays in the original order', async () => {
    const h = new EditorHistory();
    const log: string[] = [];
    h.record('v1', step('a', log));
    h.record('v1', step('b', log));

    expect((await h.undo('v1'))?.label).toBe('b');
    expect((await h.undo('v1'))?.label).toBe('a');
    expect(await h.undo('v1')).toBeNull();
    expect((await h.redo('v1'))?.label).toBe('a');
    expect((await h.redo('v1'))?.label).toBe('b');
    expect(await h.redo('v1')).toBeNull();
    expect(log).toEqual(['undo b', 'undo a', 'redo a', 'redo b']);
  });

  it('a new change after an undo clears the redo stack', async () => {
    const h = new EditorHistory();
    const log: string[] = [];
    h.record('v1', step('a', log));
    await h.undo('v1');
    expect(h.canRedo('v1')).toBeTrue();
    h.record('v1', step('b', log));
    expect(h.canRedo('v1')).toBeFalse();
    expect(h.canUndo('v1')).toBeTrue();
  });

  it('keeps one history per video', async () => {
    const h = new EditorHistory();
    const log: string[] = [];
    h.record('v1', step('a', log));
    h.record('v2', step('b', log));
    expect((await h.undo('v1'))?.label).toBe('a');
    expect(h.canUndo('v1')).toBeFalse();
    expect(h.canUndo('v2')).toBeTrue();
    h.clear('v2');
    expect(h.canUndo('v2')).toBeFalse();
  });

  it('a step that fails is dropped, not retried on the next press', async () => {
    const h = new EditorHistory();
    const log: string[] = [];
    h.record('v1', step('a', log));
    h.record('v1', step('b', log, 'undo'));

    await expectAsync(h.undo('v1')).toBeRejectedWithError('gone');
    expect(h.canRedo('v1')).toBeFalse();
    expect((await h.undo('v1'))?.label).toBe('a');
  });

  it('runs one undo at a time', async () => {
    const h = new EditorHistory();
    let release!: () => void;
    const slow: HistoryStep = { label: 'slow', undo: () => new Promise<void>((r) => (release = r)), redo: () => {} };
    h.record('v1', { label: 'first', undo: () => {}, redo: () => {} });
    h.record('v1', slow);

    const pending = h.undo('v1');
    expect(await h.undo('v1')).toBeNull();
    release();
    expect((await pending)?.label).toBe('slow');
    expect(h.canUndo('v1')).toBeTrue();
  });

  it('caps the history', () => {
    const h = new EditorHistory();
    for (let i = 0; i < EditorHistory.LIMIT + 5; i++) h.record('v1', step(`s${i}`, []));
    const done = (h as any).stacks.get('v1').done as HistoryStep[];
    expect(done.length).toBe(EditorHistory.LIMIT);
    expect(done[0].label).toBe('s5'); // the oldest fall off
  });
});

describe('idsOfRows', () => {
  it('lists the ids per table, leaving out empty tables', () => {
    expect(idsOfRows({ chapters: [{ id: 'c1' }, { id: 'c2' }], customMarkers: [], muteSections: [{ id: 'm' }] })).toEqual({
      chapters: ['c1', 'c2'],
      muteSections: ['m'],
    });
  });
});
