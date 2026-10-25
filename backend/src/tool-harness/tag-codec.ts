/**
 * THE TOOL-CALL FORMAT: plain-text tags, shaped like Qwen's tool template
 * but deliberately NOT its <tool_call>/<tool_response>. Those are special
 * tokens in Qwen's vocabulary, and an engine that knows them (mlx-lm's server)
 * lifts the call out of the reply into a structured `tool_calls` field; a
 * door that doesn't relay that field (Crucible today) then returns an empty
 * reply. Ordinary tags pass through every engine and upstream as text, and
 * every model follows them from the prompt:
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
 */
import { parseLenientJson } from './lenient-json';
import type { ParsedToolCall, Tool, ToolCallCodec } from './types';

const TOOL_CALL_BLOCK = /<tool_use>([\s\S]*?)(?:<\/tool_use>|$)/gi;

export const tagCodec: ToolCallCodec = {
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
    for (const match of text.matchAll(TOOL_CALL_BLOCK)) calls.push(readCall(match[1]));
    const prose = text
      .replace(TOOL_CALL_BLOCK, '')
      .replace(/<\/?tool_use>/gi, '')
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
};

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
