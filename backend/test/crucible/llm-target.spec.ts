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
} from '../../src/crucible/llm/target';
import { AI_VIA_ENV, resolveAiVia, writeAiVia } from '../../src/crucible/llm/ai-via';
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

describe('aiVia: which road', () => {
  it('defaults to crucible exactly when a server is registered', () => {
    const dir = tempDir();
    expect(resolveAiVia({ env: {}, configDir: dir })).toMatchObject({ via: 'direct', source: 'default', registeredServers: 0 });
    fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify({ servers: [{ name: 'mac', url: 'http://127.0.0.1:7100', token: 't', added: 'x' }] }));
    expect(resolveAiVia({ env: {}, configDir: dir })).toMatchObject({ via: 'crucible', source: 'default', registeredServers: 1 });
  });

  it('a stored setting beats the default, and the env beats both', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ taskModels: { tags: 'ollama:x' } }));
    writeAiVia('crucible', { env: {}, configDir: dir });
    expect(resolveAiVia({ env: {}, configDir: dir })).toMatchObject({ via: 'crucible', source: 'setting' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'app-config.json'), 'utf8')).taskModels).toEqual({ tags: 'ollama:x' });
    expect(resolveAiVia({ env: { [AI_VIA_ENV]: 'direct' }, configDir: dir })).toMatchObject({ via: 'direct', source: 'env', stored: 'crucible' });
    expect(resolveAiVia({ env: { [AI_VIA_ENV]: 'sideways' }, configDir: dir })).toMatchObject({ via: 'crucible', ignored: `${AI_VIA_ENV}=sideways` });
    writeAiVia(null, { env: {}, configDir: dir });
    expect(resolveAiVia({ env: {}, configDir: dir })).toMatchObject({ via: 'direct', source: 'default' });
  });
});
