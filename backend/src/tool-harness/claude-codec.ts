/**
 * THE CLAUDE TOOL-CALL FORMAT: for a Claude model reached as plain text (the
 * Claude Code CLI, `claude -p`, where no tool definitions can be sent). The
 * tools are described, and calls are made, in the XML shape Claude was
 * trained on, so it follows it without drifting into a format it was only
 * told about (with the tag format's <tool_use>, Sonnet wrote its own
 * <invoke> blocks instead in 13 of 99 replies):
 *
 *   tools     a section in the system prompt: the calling instructions and
 *             each tool as one JSON line (description, name, parameters)
 *             inside <functions><function>…</function></functions>;
 *   a call    inline in the reply, any number of them in one block:
 *               <function_calls>
 *               <invoke name="<tool>">
 *               <parameter name="<arg>">value</parameter>
 *               </invoke>
 *               </function_calls>
 *   results   the next user turn, one block for the round:
 *               <function_results>
 *               <result>
 *               <tool_name><tool></tool_name>
 *               <stdout>
 *               …
 *               </stdout>
 *               </result>
 *               </function_results>
 *             a call that could not be read is answered with <error>…</error>.
 *
 * Read as leniently as the tag format (it shares the tag codec's reader): a
 * block cut off at the very end of the reply still counts, a <tool_use> block
 * is still read as a call, and a parameter is a string unless its text is a
 * JSON object or array. A tag the reply stopped partway into is never prose.
 *
 * A trace stored in another format replays in this one: a native trace's
 * structured calls become <invoke> blocks after its text and its `tool`
 * messages one <function_results> turn (names from the calls they answer);
 * a tag-format reply's <tool_use> blocks become <invoke> blocks and its
 * <tool_result> turn a <function_results> one. A block that could not be
 * read (and its result) is dropped, as native replay drops it.
 */
import { isObject, tagCodec } from './tag-codec';
import { parseLenientJson } from './lenient-json';
import type { ChatMessage, NativeToolCall, ParsedToolCall, Tool, ToolCallCodec } from './types';

/** The tags of this format, for recognising one the reply stopped partway into. */
const TAG_NAMES = ['function_calls', 'invoke', 'parameter', 'tool_use'];

/** A tag at the very end of a reply, unclosed: `<`, `<inv`, `</param`, `<parameter name="ti`. */
const TRAILING_TAG = /<(\/?)([a-z_]*)(\s[^<>]*)?$/i;

const TAG_RESULT_BLOCK = /<tool_result>\n?([\s\S]*?)\n?<\/tool_result>/g;

export interface ClaudeCodec extends ToolCallCodec {
  /** A reply's prose (the calls cut out) and the calls in it, in order. */
  parse(text: string): { prose: string; calls: ParsedToolCall[] };
  /** The user turn carrying one round's results, in call order; `note` is appended when given. */
  responses(results: ReadonlyArray<{ name: string | null; content: string }>, note?: string): string;
}

export const claudeCodec: ClaudeCodec = {
  toolsPrompt(tools) {
    const lines = tools.map((tool) => `<function>${JSON.stringify(claudeFunction(tool))}</function>`).join('\n');
    return `In this environment you have access to a set of tools you can use to answer the user's question.
You can invoke functions by writing a "<function_calls>" block like the following as part of your reply to the user:
<function_calls>
<invoke name="$FUNCTION_NAME">
<parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</parameter>
...
</invoke>
<invoke name="$FUNCTION_NAME2">
...
</invoke>
</function_calls>

String and scalar parameters should be specified as is, while lists and objects should use JSON format.

Here are the functions available in JSONSchema format:
<functions>
${lines}
</functions>`;
  },

  parse(text) {
    return tagCodec.parse(stripTrailingTag(text));
  },

  responses(results, note) {
    const blocks = results.map(({ name, content }) =>
      name === null
        ? `<error>\n${content}\n</error>`
        : `<result>\n<tool_name>${name}</tool_name>\n<stdout>\n${content}\n</stdout>\n</result>`);
    const block = `<function_results>\n${blocks.join('\n')}\n</function_results>`;
    return note ? `${block}\n\n${note}` : block;
  },

  read(reply) {
    return { ...claudeCodec.parse(reply.text), message: { role: 'assistant', content: reply.text } };
  },

  results(calls, contents, note) {
    return [{ role: 'user', content: claudeCodec.responses(calls.map((call, i) => ({ name: call.ok ? call.name : null, content: contents[i] })), note) }];
  },

  replay(trace) {
    const out: ChatMessage[] = [];
    for (let i = 0; i < trace.length; i++) {
      const message = trace[i];
      // Native: structured calls, then one `tool` message per call.
      if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
        const names = new Map(message.toolCalls.map((call) => [call.id, call.name]));
        out.push({ role: 'assistant', content: joinBlocks(message.content, functionCallsBlock(message.toolCalls.map(nativeArgs))) });
        const results: Array<{ name: string | null; content: string }> = [];
        for (; i + 1 < trace.length && trace[i + 1].role === 'tool'; i++) {
          const answer = trace[i + 1];
          results.push({ name: names.get(answer.toolCallId ?? '') ?? null, content: answer.content });
        }
        if (results.length > 0) out.push({ role: 'user', content: claudeCodec.responses(results) });
        continue;
      }
      // Tags: <tool_use> blocks in the text, and a <tool_result> turn after.
      if (message.role === 'assistant' && /<tool_use>/i.test(message.content)) {
        const parsed = tagCodec.parse(message.content);
        const answer = trace[i + 1]?.role === 'user' ? readTagResults(trace[i + 1].content) : null;
        const kept = parsed.calls.flatMap((call, k) => (call.ok ? [{ call, k }] : []));
        if (answer !== null && answer.contents.length === parsed.calls.length) {
          i += 1;
          out.push({ role: 'assistant', content: joinBlocks(parsed.prose, kept.length > 0 ? functionCallsBlock(kept.map(({ call }) => okCall(call))) : '') });
          if (kept.length > 0) out.push({ role: 'user', content: claudeCodec.responses(kept.map(({ call, k }) => ({ name: okCall(call).name, content: answer.contents[k] })), answer.note || undefined) });
        } else if (parsed.prose) {
          // Calls never answered (the last reply's, past maxRounds): its prose alone.
          out.push({ role: 'assistant', content: parsed.prose });
        }
        continue;
      }
      out.push({ role: message.role === 'tool' ? 'user' : message.role, content: message.content });
    }
    return out;
  },
};

/** A tool as one line of Claude's <functions> list. */
function claudeFunction(tool: Pick<Tool<any, any>, 'name' | 'description' | 'parameters'>): Record<string, unknown> {
  return { description: tool.description, name: tool.name, parameters: tool.parameters };
}

/** Calls as one <function_calls> block; a string argument as it is, anything else as JSON. */
export function functionCallsBlock(calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>): string {
  const invokes = calls.map(({ name, args }) => {
    const params = Object.entries(args).map(([key, value]) => `<parameter name="${key}">${typeof value === 'string' ? value : JSON.stringify(value)}</parameter>`);
    return [`<invoke name="${name}">`, ...params, '</invoke>'].join('\n');
  });
  return ['<function_calls>', ...invokes, '</function_calls>'].join('\n');
}

function stripTrailingTag(text: string): string {
  const match = TRAILING_TAG.exec(text);
  if (match === null) return text;
  const name = match[2].toLowerCase();
  const partOfOurs = TAG_NAMES.some((tag) => (match[3] === undefined ? tag.startsWith(name) : tag === name));
  return partOfOurs ? text.slice(0, match.index) : text;
}

function nativeArgs(call: NativeToolCall): { name: string; args: Record<string, unknown> } {
  const parsed = parseLenientJson(call.arguments);
  return { name: call.name, args: isObject(parsed) ? parsed : {} };
}

function okCall(call: ParsedToolCall): { name: string; args: Record<string, unknown> } {
  return call.ok ? { name: call.name, args: call.args } : { name: '', args: {} };
}

function joinBlocks(text: string, block: string): string {
  return [text.trim(), block].filter(Boolean).join('\n');
}

/** A tag-format results turn: each <tool_result>'s content, and the note after them. Null when it holds none. */
function readTagResults(text: string): { contents: string[]; note: string } | null {
  const contents = [...text.matchAll(TAG_RESULT_BLOCK)].map((match) => match[1]);
  if (contents.length === 0) return null;
  return { contents, note: text.replace(TAG_RESULT_BLOCK, '').trim() };
}
