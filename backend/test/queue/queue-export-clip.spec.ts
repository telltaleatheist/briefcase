/**
 * An export reads the source video from where the library says it is NOW, not
 * from the path the editor sent. The editor captures the path when the video
 * opens, so renaming the file meanwhile (accepting a suggested title with the
 * video open, 2026-11-23) made the export fail with "Video file not found" on
 * the old name.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Task } from '../../src/common/interfaces/task.interface';
import { makeRig } from './queue-rig';

type ExportResult = { success: boolean; error?: string };

function runExport(rig: ReturnType<typeof makeRig>, job: Record<string, unknown>, videoPath: string): Promise<ExportResult> {
  const task = { type: 'export-clip', options: { videoPath, startTime: 1, endTime: 5 } } as Task;
  return (rig.qm as unknown as { executeExportClip(j: unknown, t: Task, id: string): Promise<ExportResult> })
    .executeExportClip({ id: 'job-1', ...job }, task, 'task-1');
}

describe('export-clip: the source path', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-export-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a video renamed since the editor opened exports from its new name', async () => {
    const renamed = path.join(dir, '2026-11-20 dr scott young - claims.mp4');
    fs.writeFileSync(renamed, '');
    const rig = makeRig();
    rig.db.getVideoById.mockImplementation(((id: string) => (id === 'v1' ? { id: 'v1', current_path: renamed } : null)) as never);

    const result = await runExport(rig, { videoId: 'v1' }, path.join(dir, '2026-11-20 A Global Financial Reset.mp4'));

    // It got past the file check (the stubbed rig then fails later, on the
    // export itself, which is not what this spec is about).
    expect(result.error ?? '').not.toMatch(/Video file not found/);
    expect(rig.db.getVideoById).toHaveBeenCalledWith('v1');
  });

  it('a video gone from the library too is reported at the path the library has', async () => {
    const rig = makeRig();
    rig.db.getVideoById.mockImplementation((() => ({ id: 'v1', current_path: path.join(dir, 'moved away.mp4') })) as never);
    const result = await runExport(rig, { videoId: 'v1' }, path.join(dir, 'old name.mp4'));
    expect(result).toEqual({ success: false, error: `Video file not found: ${path.join(dir, 'moved away.mp4')}` });
  });

  it('an export with no video id (a file outside the library) uses the path it was given', async () => {
    const rig = makeRig();
    const result = await runExport(rig, {}, path.join(dir, 'loose.mp4'));
    expect(result).toEqual({ success: false, error: `Video file not found: ${path.join(dir, 'loose.mp4')}` });
    expect(rig.db.getVideoById).not.toHaveBeenCalled();
  });
});
