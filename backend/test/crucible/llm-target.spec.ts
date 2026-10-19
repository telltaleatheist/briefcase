/**
 * THE PROVIDER MAPPING AND THE BODY RULES (migration plan §6.1), pinned as pure
 * functions: what every Briefcase `provider:model` means to Crucible, and what
 * may cross the wire with it. Above all: no sampling parameter, ever, to
 * anthropic/ or openai/.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildChatBody,
  CLOUD_FORBIDDEN_KEYS,
  crucibleTargetOf,
  responseFormatFor,
  storedChoice,
} from '../../src/crucible/llm/target';
import { tempDir } from './helpers';

const SCHEMA = { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'] };

describe('crucibleTargetOf: Briefcase provider:model → Crucible model', () => {
  it.each([
    ['claude', 'claude-sonnet-5', 'anthropic/claude-sonnet-5', 'upstream', 'anthropic'],
    ['openai', 'gpt-5.1', 'openai/gpt-5.1', 'upstream', 'openai'],
    ['ollama', 'qwen3.5:4b', 'ollama/qwen3.5:4b', 'upstream', 'ollama'],
    ['local', 'qwen3.5-9b', 'qwen3.5-9b', 'local', null],
    ['crucible', 'qwen3.5-9b', 'qwen3.5-9b', 'local', null],
    [undefined, 'qwen3.5-9b', 'qwen3.5-9b', 'local', null],
    [undefined, 'claude:claude-haiku-5', 'anthropic/claude-haiku-5', 'upstream', 'anthropic'],
    [undefined, 'ollama:qwen3.8:27b', 'ollama/qwen3.8:27b', 'upstream', 'ollama'],
    [undefined, 'local:qwen3.5-4b', 'qwen3.5-4b', 'local', null],
    ['claude', 'anthropic/claude-x', 'anthropic/claude-x', 'upstream', 'anthropic'],
    ['ollama', 'openai/gpt-x', 'openai/gpt-x', 'upstream', 'openai'],
  ])('%s + %s → %s', (provider, model, crucible, route, upstream) => {
    const target = crucibleTargetOf(provider, model);
    expect(target).toMatchObject({ model: crucible, route, upstream });
  });

  it('a size ceiling: local:max-27b (any spelling) is a ceiling target, never a catalog id', () => {
    for (const [provider, model] of [['local', 'max-27b'], [undefined, 'local:max-27b'], [undefined, 'max-27b'], ['crucible', 'max-27b']] as const) {
      expect(crucibleTargetOf(provider, model)).toEqual({ model: 'max-27b', route: 'local', upstream: null, bareModel: 'max-27b', ceilingB: 27 });
    }
    expect(crucibleTargetOf('local', 'max-9.5b')).toMatchObject({ ceilingB: 9.5 });
    // A model id a server names is that one model: only a STORED choice reads as the ceiling.
    expect(crucibleTargetOf('local', 'qwen3.8-27b-4bit')).toEqual({ model: 'qwen3.8-27b-4bit', route: 'local', upstream: null, bareModel: 'qwen3.8-27b-4bit' });
    expect(crucibleTargetOf('local', 'max-0b').ceilingB).toBeUndefined();
  });

  it('storedChoice: a stored qwen3.8 27B quantisation is the 27B ceiling; everything else is kept as stored', () => {
    for (const [provider, model] of [
      ['local', 'qwen3.8-27b-8bit'], ['local', 'qwen3.8-27b-4bit'], ['local', 'qwen3.8-27b-4bit-vl'], ['local', 'qwen3.8-27b'],
      ['', 'local:qwen3.8-27b-8bit'], ['crucible', 'qwen3.8-27b-4bit'], ['local', 'local:qwen3.8-27b-4bit'], ['local', 'max-27b'],
    ]) {
      expect(storedChoice({ provider, model })).toEqual({ provider: 'local', model: 'max-27b' });
    }
    for (const choice of [
      { provider: 'local', model: 'qwen3.5-9b' },
      { provider: 'ollama', model: 'qwen3.8:27b' },
      { provider: 'claude', model: 'claude-sonnet-5' },
      { provider: 'ollama', model: 'local:qwen3.8-27b-8bit' },
      { provider: 'local', model: 'qwen3.8-27b-8bit-extra' },
    ]) {
      expect(storedChoice(choice)).toBe(choice);
    }
    // Other fields of a config ride along.
    expect(storedChoice({ provider: 'local', model: 'qwen3.8-27b-8bit', apiKey: 'k' })).toEqual({ provider: 'local', model: 'max-27b', apiKey: 'k' });
  });

  it('refuses an empty model and an unknown provider by name', () => {
    expect(() => crucibleTargetOf('claude', '')).toThrow(/No model/);
    expect(() => crucibleTargetOf('gemini', 'x')).toThrow(/not an AI provider/);
  });
});

describe('buildChatBody: what crosses, per target', () => {
  const everything = {
    messages: [{ role: 'user' as const, content: 'hi' }],
    temperature: 0.15,
    maxTokens: 900,
    format: SCHEMA as Record<string, unknown>,
  };

  it.each(['anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'openai/o4-mini'])(
    'NO sampling, NO max_tokens and NO response_format to %s, whatever the caller asked',
    (model) => {
      for (const format of ['json', SCHEMA] as const) {
        const body = buildChatBody(crucibleTargetOf(undefined, model), { ...everything, format: format as never });
        for (const key of CLOUD_FORBIDDEN_KEYS) expect(body).not.toHaveProperty(key);
        expect(body).not.toHaveProperty('response_format');
        expect(body).toEqual({ model, messages: [{ role: 'user', content: 'hi' }], stream: false });
      }
    },
  );

  it('ollama/ keeps its pinned temperature, gets response_format, and no max_tokens or thinking', () => {
    const body = buildChatBody(crucibleTargetOf('ollama', 'qwen3.5:4b'), { ...everything, format: 'json' });
    expect(body['temperature']).toBe(0.15);
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('a local model gets temperature, max_tokens only when asked, and the schema as json_schema', () => {
    const target = crucibleTargetOf('local', 'qwen3.5-9b');
    const body = buildChatBody(target, { ...everything, schemaName: 'flags' });
    expect(body).toMatchObject({ temperature: 0.15, max_tokens: 900, response_format: { type: 'json_schema', json_schema: { name: 'flags', schema: SCHEMA } } });
    expect(body).not.toHaveProperty('chat_template_kwargs');
    const bare = buildChatBody(target, { messages: everything.messages });
    expect(bare).toEqual({ model: 'qwen3.5-9b', messages: everything.messages, stream: false });
  });

  it('response_format: json → json_object, schema → json_schema, none for cloud or when not asked', () => {
    const local = crucibleTargetOf('local', 'm');
    expect(responseFormatFor(local, 'json')).toEqual({ type: 'json_object' });
    expect(responseFormatFor(local, SCHEMA, 'tags')).toEqual({ type: 'json_schema', json_schema: { name: 'tags', schema: SCHEMA } });
    expect(responseFormatFor(local, undefined)).toBeNull();
    expect(responseFormatFor(crucibleTargetOf('claude', 'c'), 'json')).toBeNull();
    expect(responseFormatFor(crucibleTargetOf('openai', 'g'), SCHEMA)).toBeNull();
  });
});
