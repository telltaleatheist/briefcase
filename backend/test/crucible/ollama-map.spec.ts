/**
 * AN OLLAMA CHOICE, RUN ON CRUCIBLE'S OWN MODEL (ollama-map.ts): the mapping
 * table, pinned as a pure function against the Mac's real `GET /v1/models`
 * (Crucible 1.0.23, read 2026-09-23) and the 1.0.24 shapes (vision aliases
 * with `weights_of`, a cuda host that serves both 27B quantisations wide).
 */
import {
  CRUCIBLE_ANALYSIS_CONTEXT,
  crucibleModelForOllama,
  isPageReader,
  parseOllamaTag,
  precisionBitsOf,
  type MappableModel,
} from '../../src/crucible/llm/ollama-map';

function row(id: string, family: string, paramsB: number, context: number, extra: Partial<MappableModel> = {}): MappableModel {
  return {
    id, family, paramsB, modalities: ['text'], backendSupported: true, installed: true,
    contextDefault: context, maxModelLen: context, ...extra,
  };
}

/** The Mac Studio's /v1/models, as served. */
const MAC: MappableModel[] = [
  row('dots-ocr', 'dots', 3, 32768, { modalities: ['text', 'image'] }),
  row('qwen3.5-9b', 'qwen3.5', 9, 16384),
  row('qwen3.8-27b-4bit', 'qwen3.8', 27, 98304),
  row('qwen3.8-27b-8bit', 'qwen3.8', 27, 12288),
];
/** The Mac's capability record: `pages` selected dots-ocr. */
const MAC_PAGES = ['dots-ocr'];

/** A cuda host on 1.0.24: every tier, the vision aliases, both 27B quantisations served wide. */
const CUDA: MappableModel[] = [
  row('qwen3.8-27b-8bit', 'qwen3.8', 27, 65536),
  row('qwen3.8-27b-8bit-vl', 'qwen3.8', 27, 65536, { modalities: ['text', 'image'], weightsOf: 'qwen3.8-27b-8bit' }),
  row('qwen3.8-27b-4bit', 'qwen3.8', 27, 131072),
  row('qwen3.8-27b-4bit-vl', 'qwen3.8', 27, 131072, { modalities: ['text', 'image'], weightsOf: 'qwen3.8-27b-4bit' }),
  row('qwen3.5-9b', 'qwen3.5', 9, 32768),
  row('qwen3.5-9b-vl', 'qwen3.5', 9, 32768, { modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' }),
  // Tiers that do text AND image on cuda: bases, not page readers.
  row('qwen3.5-4b', 'qwen3.5', 4, 32768, { modalities: ['text', 'image'] }),
  row('qwen3.5-0.8b', 'qwen3.5', 0.8, 32768, { modalities: ['text', 'image'] }),
  row('dots-ocr', 'dots', 3, 32768, { modalities: ['text', 'image'] }),
];

describe('parseOllamaTag', () => {
  it.each([
    ['qwen3.8:27b', { family: 'qwen3.8', sizeB: 27 }],
    ['qwen3.5:9b', { family: 'qwen3.5', sizeB: 9 }],
    ['qwen3.5:0.8b', { family: 'qwen3.5', sizeB: 0.8 }],
    ['qwen3.5:4b-q8_0', { family: 'qwen3.5', sizeB: 4 }],
    ['ollama:qwen3.8:27b', { family: 'qwen3.8', sizeB: 27 }],
    ['library/Qwen3.5:9B', { family: 'qwen3.5', sizeB: 9 }],
  ])('%s → %j', (tag, parsed) => {
    expect(parseOllamaTag(tag)).toEqual(parsed);
  });

  it.each(['qwen3.8', 'qwen3.8:latest', 'llama3:instruct', '', ':27b'])('%j names no size: null', (tag) => {
    expect(parseOllamaTag(tag)).toBeNull();
  });
});

describe('crucibleModelForOllama: the Mac\'s real catalog', () => {
  it.each([
    // 27B: the 8-bit is served at 12K, under the 32K analysis window; the 4-bit at 98K.
    ['qwen3.8:27b', 'qwen3.8-27b-4bit'],
    ['qwen3.5:9b', 'qwen3.5-9b'],
    // Misses: sizes and families the Mac has no model for.
    ['qwen3.5:4b', null],
    ['qwen3.5:0.8b', null],
    ['qwen3:14b', null],
    ['llama3.1:8b', null],
    ['gemma3:27b', null],
    ['qwen3.8:latest', null],
  ])('%s → %s', (tag, expected) => {
    expect(crucibleModelForOllama(tag, MAC, { pageReaders: MAC_PAGES })).toBe(expected);
    // The same answer when the server gave no class record (modality fallback).
    expect(crucibleModelForOllama(tag, MAC)).toBe(expected);
  });

  it('a 9B served under the analysis window is still taken: it is the only 9B, and Ollama through Crucible would be 4K', () => {
    expect(crucibleModelForOllama('qwen3.5:9b', MAC)).toBe('qwen3.5-9b');
  });
});

describe('crucibleModelForOllama: choosing among quantisations', () => {
  it('context that fits first: 4-bit at 98K over 8-bit at 12K', () => {
    expect(crucibleModelForOllama('qwen3.8:27b', MAC)).toBe('qwen3.8-27b-4bit');
  });

  it('when both fit, the higher precision wins (cuda: 8-bit at 64K over 4-bit at 128K)', () => {
    expect(crucibleModelForOllama('qwen3.8:27b', CUDA)).toBe('qwen3.8-27b-8bit');
  });

  it('when neither fits, the larger context wins, then the higher precision', () => {
    const narrow = [row('qwen3.8-27b-8bit', 'qwen3.8', 27, 12288), row('qwen3.8-27b-4bit', 'qwen3.8', 27, 24576)];
    expect(crucibleModelForOllama('qwen3.8:27b', narrow)).toBe('qwen3.8-27b-4bit');
    const same = [row('qwen3.8-27b-4bit', 'qwen3.8', 27, 12288), row('qwen3.8-27b-8bit', 'qwen3.8', 27, 12288)];
    expect(crucibleModelForOllama('qwen3.8:27b', same)).toBe('qwen3.8-27b-8bit');
  });

  it('the fit threshold is the analysis window, and a caller can ask for another', () => {
    expect(CRUCIBLE_ANALYSIS_CONTEXT).toBe(32768);
    expect(crucibleModelForOllama('qwen3.8:27b', MAC, { minContext: 8192 })).toBe('qwen3.8-27b-8bit');
  });

  it('context is what is served now: max_model_len under the manifest\'s default counts', () => {
    const shrunk = [row('qwen3.8-27b-8bit', 'qwen3.8', 27, 65536), { ...row('qwen3.8-27b-4bit', 'qwen3.8', 27, 98304) }];
    shrunk[0] = { ...shrunk[0], maxModelLen: 8192 };
    expect(crucibleModelForOllama('qwen3.8:27b', shrunk)).toBe('qwen3.8-27b-4bit');
  });

  it('precision is read from the id; an unquantised id counts as 16-bit', () => {
    expect([precisionBitsOf('qwen3.8-27b-4bit'), precisionBitsOf('qwen3.8-27b-8bit-vl'), precisionBitsOf('qwen3.5-9b')]).toEqual([4, 8, 16]);
  });

  it('a model not installed, or not served on this backend, is not a candidate', () => {
    const rows = [row('qwen3.8-27b-4bit', 'qwen3.8', 27, 98304, { installed: false }), row('qwen3.8-27b-8bit', 'qwen3.8', 27, 12288)];
    expect(crucibleModelForOllama('qwen3.8:27b', rows)).toBe('qwen3.8-27b-8bit');
    expect(crucibleModelForOllama('qwen3.8:27b', [row('qwen3.8-27b-4bit', 'qwen3.8', 27, 98304, { backendSupported: false })])).toBeNull();
  });
});

describe('crucibleModelForOllama: never a page reader, never a -vl alias beside its base', () => {
  it('the base, never its -vl alias (a base<->alias switch is a ~20 s reload)', () => {
    expect(crucibleModelForOllama('qwen3.5:9b', CUDA)).toBe('qwen3.5-9b');
    expect(crucibleModelForOllama('qwen3.8:27b', CUDA)).not.toMatch(/-vl$/);
  });

  it('an alias only when no base of that model is installed', () => {
    const onlyAlias = CUDA.map((m) => (m.id === 'qwen3.5-9b' ? { ...m, installed: false } : m));
    expect(crucibleModelForOllama('qwen3.5:9b', onlyAlias)).toBe('qwen3.5-9b-vl');
  });

  it('a -vl alias is known by weights_of or by its suffix', () => {
    const suffixOnly = [row('qwen3.5-9b-vl', 'qwen3.5', 9, 65536, { modalities: ['text', 'image'] }), row('qwen3.5-9b', 'qwen3.5', 9, 16384)];
    expect(crucibleModelForOllama('qwen3.5:9b', suffixOnly)).toBe('qwen3.5-9b');
  });

  it('by capability class, a text+image base (the cuda 4B and 0.8B tiers) is NOT a page reader', () => {
    const pages = ['dots-ocr'];
    expect(crucibleModelForOllama('qwen3.5:4b', CUDA, { pageReaders: pages })).toBe('qwen3.5-4b');
    expect(crucibleModelForOllama('qwen3.5:0.8b', CUDA, { pageReaders: pages })).toBe('qwen3.5-0.8b');
  });

  it('the pages class\'s model is never a candidate, whatever its family', () => {
    const reader = row('qwen3.5-4b', 'qwen3.5', 4, 32768, { modalities: ['text', 'image'] });
    expect(crucibleModelForOllama('qwen3.5:4b', [reader], { pageReaders: ['qwen3.5-4b'] })).toBeNull();
    expect(isPageReader(reader, new Set(['qwen3.5-4b']))).toBe(true);
    // Per-row classes, when a server reports them, decide first.
    expect(isPageReader({ ...reader, classes: ['pages'] }, null)).toBe(true);
    expect(isPageReader({ ...reader, classes: ['analysis', 'decide'] }, new Set(['qwen3.5-4b']))).toBe(false);
  });

  it('with no class record at all, an image model that is not an alias counts as a page reader', () => {
    expect(isPageReader(MAC[0], null)).toBe(true);
    expect(isPageReader(CUDA[1], null)).toBe(false);
  });
});
