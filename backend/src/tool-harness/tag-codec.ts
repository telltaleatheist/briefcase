/**
 * THE TOOL-CALL FORMAT: plain-text tags, shaped like Qwen's tool template
 * but deliberately NOT its <tool_call>/<tool_response>. Those are special
 * tokens in Qwen's vocabulary, and an engine that knows them (mlx-lm's server)
 * lifts the call out of the reply into a structured `tool_calls` field; a
 * door that doesn't relay that field (Crucible today) then returns an empty
 * reply. Ordinary tags pass through every engine and upstream as text, and
 * every model follows them from the prompt (the fallback for a model API
 * without native tools; native-codec.ts is the other format):
 *
 *   tools     a "# Tools" section in the system prompt, each tool's function
 *             definition (the OpenAI `tools` entry shape) as one JSON line
 *             inside <tools></tools>;
 *   a call    inline in the reply, any number of them:
 *               <tool_use>
 *               {"name": "<tool>", "arguments": {...}}
 *               </tool_use>
 *   results   the next user turn, one <tool_result>…</tool_result> per call.
 *
 * Calls are read leniently: a code fence or stray whitespace inside or around
 * the block, `arguments` as an object or as a JSON string, and a block left
 * open at the very end of the reply (cut off) are all read. A block that still
 * can't be read is a call with the reason, so the model can be told and call
 * again. The blocks (and fences left empty by them) are cut out of the prose.
 *
 * Claude also writes calls in its own format some of the time, in place of the
 * tags it was asked for (13 of 99 replies in the highlights test):
 *   <invoke name="add_marker"><parameter name="title">…</parameter>…</invoke>
 * optionally inside <function_calls>. Those are read as calls too, in reply
 * order with the tags; a parameter is a string unless its text is a JSON
 * object or array.
 *
 * A trace stored in the native format replays as tags: an assistant message's
 * structured calls become <tool_use> blocks after its text, and the `tool`
 * messages after it one <tool_result> user turn, so a thread that began on a
 * native model reads the same to a model that only has tags.
 */
import { parseLenientJson } from './lenient-json';
import type { ChatMessage, ParsedToolCall, Tool, ToolCallCodec } from './types';

const TOOL_CALL_BLOCK = /<tool_use>([\s\S]*?)(?:<\/tool_use>|$)|<invoke\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)(?:<\/invoke>|$)/gi;

const PARAMETER = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;

/** A tag the reply stopped partway into ("<", "<tool_u", "</tool"): never prose. */
const CUT_TAG = /<\/?(?:t(?:o(?:o(?:l(?:_(?:u(?:se?)?)?)?)?)?)?)?$/i;

/** The tag format: the codec, plus its text-level halves (parse a reply's text, render a results turn). */
export interface TagCodec extends ToolCallCodec {
  /** A reply's prose (the calls cut out) and the calls in it, in order. */
  parse(text: string): { prose: string; calls: ParsedToolCall[] };
  /** The user turn carrying one round's results, in call order; `note` is appended when given. */
  responses(contents: string[], note?: string): string;
}

export const tagCodec: TagCodec = {
  toolsPrompt(tools) {
    const lines = tools.map((tool) => JSON.stringify(functionDefinition(tool))).join('\n');
    return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${lines}
</tools>

For each function call, return a json object with function name and arguments within <tool_use></tool_use> XML tags:
<tool_use>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_use>`;
  },

  parse(text) {
    const calls: ParsedToolCall[] = [];
    for (const match of text.matchAll(TOOL_CALL_BLOCK)) calls.push(match[1] !== undefined ? readCall(match[1]) : readInvoke(match[2], match[3]));
    const prose = text
      .replace(TOOL_CALL_BLOCK, '')
      .trimEnd()
      .replace(CUT_TAG, '')
      .replace(/<\/?(?:tool_use|function_calls)>/gi, '')
      // A fence that only wrapped the tags is empty now.
      .replace(/```[a-z]*\s*```/gi, '')
      // Lines a cut-out call leaves holding only its indent.
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { prose, calls };
  },

  responses(contents, note) {
    const blocks = contents.map((content) => `<tool_result>\n${content}\n</tool_result>`).join('\n');
    return note ? `${blocks}\n${note}` : blocks;
  },

  read(reply) {
    return { ...tagCodec.parse(reply.text), message: { role: 'assistant', content: reply.text } };
  },

  results(_calls, contents, note) {
    return [{ role: 'user', content: tagCodec.responses(contents, note) }];
  },

  replay(trace) {
    const out: ChatMessage[] = [];
    for (let i = 0; i < trace.length; i++) {
      const message = trace[i];
      if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
        const blocks = message.toolCalls.map((call) => toolUseBlock(call.name, parseLenientJson(call.arguments) ?? call.arguments));
        out.push({ role: 'assistant', content: [message.content.trim(), ...blocks].filter(Boolean).join('\n') });
      } else if (message.role === 'tool') {
        const contents: string[] = [];
        for (; i < trace.length && trace[i].role === 'tool'; i++) contents.push(trace[i].content);
        i -= 1;
        out.push({ role: 'user', content: tagCodec.responses(contents) });
      } else {
        out.push({ role: message.role, content: message.content });
      }
    }
    return out;
  },
};

/** One call as a <tool_use> block. */
export function toolUseBlock(name: string, args: unknown): string {
  return `<tool_use>\n${JSON.stringify({ name, arguments: args })}\n</tool_use>`;
}

/** A tool as the OpenAI `tools` entry (what a native-tools transport sends). */
export function functionDefinition(tool: Pick<Tool<any, any>, 'name' | 'description' | 'parameters'>): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function readCall(body: string): ParsedToolCall {
  if (!body.replace(/```[a-z]*/gi, '').trim()) return { ok: false, reason: 'the block is empty' };
  const call = parseLenientJson(body);
  if (!isObject(call)) return { ok: false, reason: 'it is not a JSON object' };
  if (typeof call['name'] !== 'string' || call['name'].trim() === '') return { ok: false, reason: 'it names no tool ("name")' };
  const raw = call['arguments'] ?? {};
  const args = typeof raw === 'string' ? parseLenientJson(raw) : raw;
  if (!isObject(args)) return { ok: false, reason: '"arguments" is not a JSON object' };
  return { ok: true, name: call['name'].trim(), args };
}

function readInvoke(name: string, body: string): ParsedToolCall {
  if (!name.trim()) return { ok: false, reason: 'it names no tool ("name")' };
  const args: Record<string, unknown> = {};
  for (const [, key, raw] of body.matchAll(PARAMETER)) {
    const value = raw.trim();
    const json = /^[[{]/.test(value) ? parseLenientJson(value) : undefined;
    args[key] = json !== undefined && json !== null ? json : value;
  }
  return { ok: true, name: name.trim(), args };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
