import { describe, expect, it } from '@jest/globals';
import { functionDefinition, tagCodec } from './tag-codec';
import { parseLenientJson } from './lenient-json';

/** Reading tool-call tags out of a reply, leniently, and writing tools and results. */

const tag = (call: unknown) => `<tool_use>\n${typeof call === 'string' ? call : JSON.stringify(call)}\n</tool_use>`;

describe('tagCodec.parse', () => {
  it('no tags: all prose, no calls', () => {
    expect(tagCodec.parse('Just an answer.')).toEqual({ prose: 'Just an answer.', calls: [] });
  });

  it('tags plus prose: the blocks are cut out, the prose kept around them', () => {
    const parsed = tagCodec.parse(`Before.\n\n${tag({ name: 'mark', arguments: { a: 1 } })}\n\nAfter.`);
    expect(parsed).toEqual({ prose: 'Before.\n\nAfter.', calls: [{ ok: true, name: 'mark', args: { a: 1 } }] });
  });

  it('multiple tags, in order, back to back', () => {
    const parsed = tagCodec.parse(`${tag({ name: 'a', arguments: {} })}${tag({ name: 'b', arguments: { x: 'y' } })}`);
    expect(parsed.prose).toBe('');
    expect(parsed.calls).toEqual([{ ok: true, name: 'a', args: {} }, { ok: true, name: 'b', args: { x: 'y' } }]);
  });

  it('arguments as a JSON string', () => {
    expect(tagCodec.parse(tag({ name: 'a', arguments: JSON.stringify({ x: 1 }) })).calls).toEqual([{ ok: true, name: 'a', args: { x: 1 } }]);
  });

  it('a code fence inside the block, a fence around it, stray whitespace, a trailing comma', () => {
    const inside = tagCodec.parse('Here:\n<tool_use>\n```json\n   {"name": "a", "arguments": {"x": 1,}}  \n```\n</tool_use>');
    expect(inside).toEqual({ prose: 'Here:', calls: [{ ok: true, name: 'a', args: { x: 1 } }] });
    const around = tagCodec.parse(`Found it.\n\`\`\`\n${tag({ name: 'a', arguments: {} })}\n\`\`\``);
    expect(around).toEqual({ prose: 'Found it.', calls: [{ ok: true, name: 'a', args: {} }] });
  });

  it('a block cut off at the end of the reply is still read', () => {
    expect(tagCodec.parse(`Placing. <tool_use>${JSON.stringify({ name: 'a', arguments: {} })}`)).toEqual({ prose: 'Placing.', calls: [{ ok: true, name: 'a', args: {} }] });
  });

  it('a malformed tag is a call with its reason, never guessed', () => {
    expect(tagCodec.parse('Sure. <tool_use>{"name": "a", "arguments": {"x": </tool_use>').calls).toEqual([{ ok: false, reason: 'it is not a JSON object' }]);
    expect(tagCodec.parse(tag({ arguments: {} })).calls).toEqual([{ ok: false, reason: 'it names no tool ("name")' }]);
    expect(tagCodec.parse(tag({ name: 'a', arguments: '[1, 2]' })).calls).toEqual([{ ok: false, reason: '"arguments" is not a JSON object' }]);
    expect(tagCodec.parse('<tool_use>\n</tool_use>').calls).toEqual([{ ok: false, reason: 'the block is empty' }]);
  });

  it('a call with no arguments has empty ones', () => {
    expect(tagCodec.parse(tag({ name: 'a' })).calls).toEqual([{ ok: true, name: 'a', args: {} }]);
  });
});

describe('tagCodec: tools and results', () => {
  const tool = { name: 'mark', description: 'Mark it.', parameters: { type: 'object', properties: {} } };

  it('the tools section has each tool as a function definition on one line', () => {
    const prompt = tagCodec.toolsPrompt([{ ...tool, execute: async () => ({ content: '' }) }]);
    expect(prompt).toContain(`<tools>\n${JSON.stringify(functionDefinition(tool))}\n</tools>`);
    expect(prompt).toContain('<tool_use>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_use>');
    expect(functionDefinition(tool)).toEqual({ type: 'function', function: tool });
  });

  it('one <tool_result> per result, in order, and the note after them', () => {
    expect(tagCodec.responses(['one', 'two'])).toBe('<tool_result>\none\n</tool_result>\n<tool_result>\ntwo\n</tool_result>');
    expect(tagCodec.responses(['one'], 'Stop now.')).toBe('<tool_result>\none\n</tool_result>\nStop now.');
  });
});

describe('parseLenientJson', () => {
  it('reads an object out of prose and fences; null when there is none', () => {
    expect(parseLenientJson('sure: {"a": [1, 2,],} ok')).toEqual({ a: [1, 2] });
    expect(parseLenientJson('{"a": "}"}')).toEqual({ a: '}' });
    expect(parseLenientJson('no json here')).toBeNull();
    expect(parseLenientJson('{"a": ')).toBeNull();
  });
});
