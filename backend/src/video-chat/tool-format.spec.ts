import { describe, expect, it } from '@jest/globals';
import { claudeCodec, nativeCodec, tagCodec } from '../tool-harness';
import { codecFor, toolFormatFor } from './tool-format';

/** Each model gets the tool-call format it was trained on, decided in one place. */
describe('toolFormatFor', () => {
  it('claude-cli: the Claude format, whatever any Crucible takes', () => {
    expect(toolFormatFor({ claudeCli: true, nativeTools: false })).toBe('claude');
    expect(toolFormatFor({ claudeCli: true, nativeTools: true })).toBe('claude');
  });

  it('a Crucible that takes native tools (2.0.30+): native', () => {
    expect(toolFormatFor({ claudeCli: false, nativeTools: true })).toBe('native');
  });

  it('otherwise: tags', () => {
    expect(toolFormatFor({ claudeCli: false, nativeTools: false })).toBe('tags');
  });

  it('each format has its codec', () => {
    expect(codecFor('claude')).toBe(claudeCodec);
    expect(codecFor('native')).toBe(nativeCodec);
    expect(codecFor('tags')).toBe(tagCodec);
  });
});
