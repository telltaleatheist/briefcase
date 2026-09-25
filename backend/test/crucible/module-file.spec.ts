/**
 * The vendored module file is the generator's output, unedited
 * (a port of BookForge's test-crucible-module-file.js).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BRIEFCASE_MODULE, moduleForBackend } from '../../src/crucible/module-setup';

const FILE = path.join(__dirname, '../../src/crucible/module/briefcase.module.json');

/** Python's `json.dumps(body, sort_keys=True, separators=(",", ":"))`, for ASCII content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('briefcase.module.json', () => {
  const text = fs.readFileSync(FILE, 'utf-8');
  const doc = JSON.parse(text) as Record<string, unknown>;

  it('parses, names briefcase, and is what the module loader exports', () => {
    expect(doc['name']).toBe('briefcase');
    expect(BRIEFCASE_MODULE).toEqual(doc);
  });

  it('carries a version that is the hash of its own content (so it was not hand-edited)', () => {
    const { version, ...body } = doc;
    const [, hash] = String(version).split('+');
    expect(createHash('sha256').update(canonical(body)).digest('hex').slice(0, 12)).toBe(hash);
  });

  it('is written the way the generator writes it: two-space JSON, LF, one trailing newline', () => {
    expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    expect(text).not.toContain('\r');
  });

  it('asks for llm, asr and align, the analysis class, and Qwen3-ASR 0.6B (and its Mac port) with the aligner', () => {
    expect(BRIEFCASE_MODULE.job_types.map((j) => j.type)).toEqual(['llm', 'asr', 'align']);
    expect(BRIEFCASE_MODULE.needs).toEqual([{ class: 'analysis' }]);
    expect(BRIEFCASE_MODULE.subjects.map((s) => s.id)).toEqual(['qwen3-asr-0.6b', 'qwen3-asr-0.6b-mlx', 'qwen3-aligner']);
  });

  it('is filtered to one backend and stripped of `backends` before posting', () => {
    const mac = moduleForBackend('mlx-darwin');
    expect(mac.subjects).toEqual([
      { kind: 'model', id: 'qwen3-asr-0.6b' }, { kind: 'model', id: 'qwen3-asr-0.6b-mlx' }, { kind: 'model', id: 'qwen3-aligner' },
    ]);
    expect(mac.job_types).toEqual([{ type: 'llm' }, { type: 'asr' }, { type: 'align' }]);
    expect(JSON.stringify(mac)).not.toContain('backends');

    // The MLX port is Mac only.
    const pc = moduleForBackend('cuda-linux');
    expect(pc.subjects).toEqual([{ kind: 'model', id: 'qwen3-asr-0.6b' }, { kind: 'model', id: 'qwen3-aligner' }]);

    // Native Windows has no asr engine: the module asks it for text only.
    const windows = moduleForBackend('llama-windows');
    expect(windows.job_types).toEqual([{ type: 'llm' }]);
    expect(windows.subjects).toEqual([]);
    expect(windows.needs).toEqual([{ class: 'analysis' }]);
  });
});
