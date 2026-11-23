import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Needs a better-sqlite3 built for this Node (see ranker-migration.spec.ts). */
let Database: any = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const suite = Database ? describe : describe.skip;

suite('editor rows: remove returns the rows, restore puts them back exactly', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function library() {
    const { DatabaseService } = await import('./database.service');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-editor-rows-'));
    const svc = new DatabaseService({ setLibraryPath: () => undefined } as any);
    svc.initializeDatabase(path.join(dir, 'library.db'));
    for (const id of ['v1', 'v2']) {
      svc.insertVideo({ id, filename: `${id}.mp4`, fileHash: `hash-${id}`, currentPath: path.join(dir, `${id}.mp4`) });
    }
    const db = (svc as any).db;
    db.prepare(
      `INSERT INTO analysis_sections (id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, source, verdict, nli_score, ranker)
       VALUES ('s1', 'v1', 10, 20, '00:00:10 - 00:00:20', 'Hate', 'a passage', 'hate', 'ai', 'flag', 0.93, 'snap')`,
    ).run();
    svc.insertCustomMarker({ id: 'm1', videoId: 'v1', startSeconds: 5, endSeconds: 6, title: 'mine', category: 'marker', markerSet: 'set-a' });
    svc.insertMuteSection({ id: 'mu1', videoId: 'v1', startSeconds: 30, endSeconds: 31 });
    svc.insertChapter({ id: 'c1', videoId: 'v1', sequence: 1, startSeconds: 0, endSeconds: 600, title: 'Story', level: 0 });
    svc.insertChapter({ id: 'c2', videoId: 'v1', sequence: 2, startSeconds: 0, endSeconds: 300, title: 'Part 1', level: 1, parentId: 'c1' });
    svc.insertChapter({ id: 'c3', videoId: 'v1', sequence: 3, startSeconds: 300, endSeconds: 600, title: 'Part 2', level: 1, parentId: 'c1' });
    svc.insertChapter({ id: 'c4', videoId: 'v1', sequence: 4, startSeconds: 600, endSeconds: 900, title: 'Other' });
    return { svc, db };
  }

  const dump = (db: any) => ({
    analysis_sections: db.prepare('SELECT * FROM analysis_sections ORDER BY id').all(),
    custom_markers: db.prepare('SELECT * FROM custom_markers ORDER BY id').all(),
    chapters: db.prepare('SELECT * FROM chapters ORDER BY id').all(),
    mute_sections: db.prepare('SELECT * FROM mute_sections ORDER BY id').all(),
  });

  it('a round trip of every kind leaves the library byte-for-byte as it was', async () => {
    const { svc, db } = await library();
    const before = dump(db);

    const removed = svc.removeEditorRows('v1', {
      analysisSections: ['s1'],
      customMarkers: ['m1'],
      chapters: ['c1'],
      muteSections: ['mu1'],
    });
    expect(removed.analysisSections?.map((r) => r.id)).toEqual(['s1']);
    expect(removed.customMarkers?.map((r) => r.id)).toEqual(['m1']);
    expect(removed.muteSections?.map((r) => r.id)).toEqual(['mu1']);
    // A chapter takes its sub-chapters with it.
    expect(removed.chapters?.map((r) => r.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(dump(db).chapters.map((r: any) => r.id)).toEqual(['c4']);
    expect(dump(db).analysis_sections).toEqual([]);

    // Over the wire (JSON), children listed before their parent still restore.
    const wire = JSON.parse(JSON.stringify({ ...removed, chapters: [...removed.chapters!].reverse() }));
    expect(svc.restoreEditorRows('v1', wire)).toBe(6);
    expect(dump(db)).toEqual(before);
  });

  it('skips unknown ids and ids that belong to another video', async () => {
    const { svc, db } = await library();
    const removed = svc.removeEditorRows('v2', { analysisSections: ['s1', 'nope'], chapters: ['c4'] });
    expect(removed).toEqual({});
    expect(dump(db).analysis_sections).toHaveLength(1);
    expect(dump(db).chapters).toHaveLength(4);
  });

  it('restore pins rows to the video in the URL and ignores columns the table does not have', async () => {
    const { svc, db } = await library();
    const removed = svc.removeEditorRows('v1', { customMarkers: ['m1'] });
    const row = { ...removed.customMarkers![0], video_id: 'v2', not_a_column: 'x' };
    svc.restoreEditorRows('v1', { customMarkers: [row] });
    expect(dump(db).custom_markers.map((r: any) => [r.id, r.video_id, r.marker_set])).toEqual([['m1', 'v1', 'set-a']]);
  });

  it('a row with no id is refused and nothing in that batch lands', async () => {
    const { svc, db } = await library();
    const removed = svc.removeEditorRows('v1', { muteSections: ['mu1'] });
    expect(() =>
      svc.restoreEditorRows('v1', { muteSections: [...removed.muteSections!, { start_seconds: 1 } as any] }),
    ).toThrow(/no id/);
    expect(dump(db).mute_sections).toEqual([]);
  });
});
