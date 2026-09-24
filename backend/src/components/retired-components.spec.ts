import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KEPT_COMPONENT_IDS,
  RETIREMENT_ID,
  executeRetirement,
  planRetirement,
  retireOnce,
  retirementDone,
} from './retired-components';
import { BRIEFCASE_COMPONENTS } from './component-manager.service';

/** A pre-P7 install laid out the way the old component manager wrote it. */
function seedOldInstall(root: string) {
  const cfg = path.join(root, 'briefcase');
  const comps = path.join(cfg, 'components');
  const models = path.join(cfg, 'models');
  const whisperModels = path.join(models, 'whisper');
  const write = (p: string, bytes: number) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  };
  write(path.join(comps, 'ffmpeg-tools', 'ffmpeg'), 10);
  write(path.join(comps, 'ffmpeg-tools', 'ffprobe'), 10);
  write(path.join(comps, 'yt-dlp', 'yt-dlp_macos_dir', 'yt-dlp_macos'), 10);
  write(path.join(comps, 'whisper', 'whisper-cli-arm64'), 100);
  write(path.join(comps, 'whisper', 'libggml-arm64.dylib'), 50);
  write(path.join(comps, 'llama', 'llama-server-arm64'), 200);
  write(path.join(whisperModels, 'ggml-base.bin'), 300);
  write(path.join(whisperModels, 'ggml-tiny.bin'), 30); // unrecorded catalog file
  write(path.join(models, 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf'), 400);
  write(path.join(models, 'Qwen3.5-9B-BF16.gguf'), 1000); // hand-placed, no record
  write(path.join(cfg, 'nli', 'venv', 'bin', 'python'), 20);
  write(path.join(cfg, 'nli', 'hf', 'weights'), 70);
  write(path.join(cfg, 'nli', 'worker.py'), 5);
  // Not ours: must survive.
  write(path.join(models, 'my-own-notes.txt'), 7);
  write(path.join(whisperModels, 'ggml-custom-finetune.bin'), 9);
  write(path.join(cfg, 'app-config.json'), 2);
  write(path.join(cfg, 'libraries', 'lib1', 'library.db'), 11);

  const rec = (id: string, kind: string, dir: string, entry: string) => ({
    id, kind, dir, entry, sha256: '', bytes: 0, installedAt: '2026-06-18T00:00:00Z',
  });
  const installed = {
    components: {
      'ffmpeg-tools': rec('ffmpeg-tools', 'binary', path.join(comps, 'ffmpeg-tools'), 'ffmpeg'),
      'yt-dlp': rec('yt-dlp', 'binary', path.join(comps, 'yt-dlp'), 'yt-dlp_macos_dir/yt-dlp_macos'),
      whisper: rec('whisper', 'binary', path.join(comps, 'whisper'), 'whisper-cli-arm64'),
      llama: rec('llama', 'binary', path.join(comps, 'llama'), 'llama-server-arm64'),
      'whisper-model-base': rec('whisper-model-base', 'whisper-model', whisperModels, 'ggml-base.bin'),
      'cogito-14b': rec('cogito-14b', 'llama-model', models, 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf'),
    },
  };
  fs.writeFileSync(path.join(comps, 'installed.json'), JSON.stringify(installed, null, 2));
  return { cfg, comps, models, whisperModels };
}

const quiet = { log: () => undefined, warn: () => undefined };

describe('retired components (P7)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-retire-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps exactly the components this build uses', () => {
    expect([...KEPT_COMPONENT_IDS].sort()).toEqual([...BRIEFCASE_COMPONENTS].sort());
  });

  it('plans the retired files only, with sizes, from records and fixed paths', async () => {
    const { cfg, comps, models, whisperModels } = seedOldInstall(root);
    const plan = await planRetirement(cfg);
    const byPath = Object.fromEntries(plan.targets.map((t) => [t.path, t.bytes]));
    expect(byPath).toEqual({
      [path.join(comps, 'whisper')]: 150,
      [path.join(comps, 'llama')]: 200,
      [path.join(whisperModels, 'ggml-base.bin')]: 300,
      [path.join(whisperModels, 'ggml-tiny.bin')]: 30,
      [path.join(models, 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf')]: 400,
      [path.join(models, 'Qwen3.5-9B-BF16.gguf')]: 1000,
      [path.join(cfg, 'nli')]: 95,
    });
    expect(plan.totalBytes).toBe(2175);
    expect(plan.recordIds.sort()).toEqual(['cogito-14b', 'llama', 'whisper', 'whisper-model-base']);
    // Planning removes nothing.
    expect(fs.existsSync(path.join(models, 'Qwen3.5-9B-BF16.gguf'))).toBe(true);
  });

  it('removes them, keeps ffmpeg/yt-dlp and everything unrecognised, and records completion once', async () => {
    const { cfg, comps, models, whisperModels } = seedOldInstall(root);
    const logs: string[] = [];
    const result = await retireOnce(cfg, { log: (m) => logs.push(m), warn: (m) => logs.push(m) });
    expect(result?.errors).toEqual([]);
    expect(result?.bytesFreed).toBe(2175);

    for (const gone of [
      path.join(comps, 'whisper'),
      path.join(comps, 'llama'),
      path.join(whisperModels, 'ggml-base.bin'),
      path.join(whisperModels, 'ggml-tiny.bin'),
      path.join(models, 'Qwen3.5-9B-BF16.gguf'),
      path.join(cfg, 'nli'),
    ]) {
      expect(fs.existsSync(gone)).toBe(false);
    }
    for (const kept of [
      path.join(comps, 'ffmpeg-tools', 'ffmpeg'),
      path.join(comps, 'ffmpeg-tools', 'ffprobe'),
      path.join(comps, 'yt-dlp', 'yt-dlp_macos_dir', 'yt-dlp_macos'),
      path.join(models, 'my-own-notes.txt'),
      path.join(whisperModels, 'ggml-custom-finetune.bin'),
      path.join(cfg, 'app-config.json'),
      path.join(cfg, 'libraries', 'lib1', 'library.db'),
    ]) {
      expect(fs.existsSync(kept)).toBe(true);
    }

    const installed = JSON.parse(fs.readFileSync(path.join(comps, 'installed.json'), 'utf8'));
    expect(Object.keys(installed.components).sort()).toEqual(['ffmpeg-tools', 'yt-dlp']);
    expect(logs.some((l) => /2\.1 KB freed/.test(l))).toBe(true);

    expect(retirementDone(cfg)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(comps, 'retired.json'), 'utf8'));
    expect(marker.retirements[RETIREMENT_ID].bytesFreed).toBe(2175);

    // Runs once: a file that reappears is not touched again.
    fs.writeFileSync(path.join(models, 'Qwen3.5-9B-BF16.gguf'), 'x');
    expect(await retireOnce(cfg, quiet)).toBeNull();
    expect(fs.existsSync(path.join(models, 'Qwen3.5-9B-BF16.gguf'))).toBe(true);
  });

  it('prunes the old models dirs when they end up empty', async () => {
    const { cfg, models } = seedOldInstall(root);
    fs.rmSync(path.join(models, 'my-own-notes.txt'));
    fs.rmSync(path.join(models, 'whisper', 'ggml-custom-finetune.bin'));
    await retireOnce(cfg, quiet);
    expect(fs.existsSync(models)).toBe(false);
  });

  it('never follows a record or link outside the config dir', async () => {
    const { cfg, comps, models } = seedOldInstall(root);
    const elsewhere = path.join(root, 'external-volume');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'ggml-large-v3.bin'), 'precious');
    fs.writeFileSync(path.join(elsewhere, 'Qwen3.5-9B-BF16.gguf'), 'precious');
    const installedPath = path.join(comps, 'installed.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    installed.components['whisper-model-large-v3'] = {
      id: 'whisper-model-large-v3', kind: 'whisper-model', dir: elsewhere, entry: 'ggml-large-v3.bin',
    };
    installed.components.llama.dir = elsewhere;
    fs.writeFileSync(installedPath, JSON.stringify(installed));
    // The scorer file is a symlink to the external copy: only the link goes.
    fs.rmSync(path.join(models, 'Qwen3.5-9B-BF16.gguf'));
    fs.symlinkSync(path.join(elsewhere, 'Qwen3.5-9B-BF16.gguf'), path.join(models, 'Qwen3.5-9B-BF16.gguf'));

    const result = await retireOnce(cfg, quiet);
    expect(result?.errors).toEqual([]);
    expect(fs.readFileSync(path.join(elsewhere, 'ggml-large-v3.bin'), 'utf8')).toBe('precious');
    expect(fs.readFileSync(path.join(elsewhere, 'Qwen3.5-9B-BF16.gguf'), 'utf8')).toBe('precious');
    expect(fs.existsSync(path.join(models, 'Qwen3.5-9B-BF16.gguf'))).toBe(false);
    // The out-of-place whisper record is left, since its file was not touched.
    const after = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    expect(after.components['whisper-model-large-v3']).toBeDefined();
  });

  it('never touches a kept component, even if a record claims it is retired', async () => {
    const { cfg, comps } = seedOldInstall(root);
    const installedPath = path.join(comps, 'installed.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    installed.components['odd-model'] = {
      id: 'odd-model', kind: 'llama-model', dir: path.join(comps, 'ffmpeg-tools'), entry: 'ffmpeg',
    };
    fs.writeFileSync(installedPath, JSON.stringify(installed));
    await retireOnce(cfg, quiet);
    expect(fs.existsSync(path.join(comps, 'ffmpeg-tools', 'ffmpeg'))).toBe(true);
  });

  it('leaves an nli dir that does not look like the NLI env', async () => {
    const cfg = path.join(root, 'briefcase');
    fs.mkdirSync(path.join(cfg, 'nli'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'nli', 'notes.md'), 'mine');
    const plan = await planRetirement(cfg);
    expect(plan.targets).toEqual([]);
    await retireOnce(cfg, quiet);
    expect(fs.existsSync(path.join(cfg, 'nli', 'notes.md'))).toBe(true);
  });

  it('a fresh install (no config dir yet) records done with nothing removed', async () => {
    const cfg = path.join(root, 'briefcase');
    const result = await retireOnce(cfg, quiet);
    expect(result?.removed).toEqual([]);
    expect(retirementDone(cfg)).toBe(true);
  });

  it('a corrupt installed.json skips this launch without recording, and never throws', async () => {
    const { cfg, comps } = seedOldInstall(root);
    fs.writeFileSync(path.join(comps, 'installed.json'), '{not json');
    const warns: string[] = [];
    await expect(retireOnce(cfg, { log: () => undefined, warn: (m) => warns.push(m) })).resolves.toBeNull();
    expect(retirementDone(cfg)).toBe(false);
    expect(fs.existsSync(path.join(comps, 'whisper'))).toBe(true);
    expect(warns.join('\n')).toMatch(/skipped this launch/);
  });

  it('a failed removal is reported, not recorded, and retried next launch', async () => {
    const { cfg, comps } = seedOldInstall(root);
    const plan = await planRetirement(cfg);
    const unlink = jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const result = await executeRetirement(plan);
    unlink.mockRestore();
    expect(result.errors).toHaveLength(1);
    const failed = result.errors[0].path;
    // The first file target is the recorded whisper base model.
    expect(failed).toBe(path.join(cfg, 'models', 'whisper', 'ggml-base.bin'));
    expect(fs.existsSync(failed)).toBe(true);
    // Its record is kept while the file is still there; the others are dropped.
    const installed = JSON.parse(fs.readFileSync(path.join(comps, 'installed.json'), 'utf8'));
    expect(Object.keys(installed.components).sort()).toEqual(['ffmpeg-tools', 'whisper-model-base', 'yt-dlp']);
    // And the next launch finishes the job.
    const second = await retireOnce(cfg, quiet);
    expect(second?.errors).toEqual([]);
    expect(fs.existsSync(failed)).toBe(false);
    expect(retirementDone(cfg)).toBe(true);
  });
});
