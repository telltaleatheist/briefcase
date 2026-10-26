/**
 * THE NATIVE TOOL-CALL FORMAT: for a model API that takes OpenAI `tools`
 * (Crucible 2.0.30+'s chat door; it writes each model's own trained format
 * underneath, so this side sees one shape for every model):
 *
 *   tools     sent as definitions (TransportOptions.tools, each tool's
 *             functionDefinition), not in the prompt;
 *   a call    the reply's structured `toolCalls`, any number of them, each an
 *             opaque id, a name and its arguments as a JSON string;
 *   results   one `tool` message per call, carrying the call's id back
 *             exactly, after the assistant message exactly as it came.
 *
 * Arguments that aren't a JSON object are a call with the reason, so the
 * model is told and may call again, as with an unreadable tag. Every call is
 * answered: the calls a last reply makes past maxRounds get a `tool` message
 * saying they were not run, so a stored trace is a conversation a model API
 * takes back.
 *
 * A trace stored in the tag format (a thread from before native tools, or
 * from a tag-only model), or in the Claude format (claude-codec.ts), replays as native messages: each assistant reply's
 * <tool_use> blocks become structured calls (ids made up per turn, as stable
 * as the stored turn) beside its prose, and the <tool_result> turn after it
 * the matching `tool` messages. The model then sees one format only, its
 * own, and nothing in its history shows it tags to imitate. A block that could
 * not be read (and its "couldn't read" result) is dropped, and so are calls a
 * last reply made that were never run: neither had an effect.
 */
import { functionDefinition, isObject, tagCodec } from './tag-codec';
import type { ChatMessage, NativeToolCall, ParsedToolCall, ToolCallCodec } from './types';

/** The result a call the loop did not run is answered with. */
export const NOT_RUN_RESULT = 'Not run: no more tool calls can be made in this answer.';

/** A result in a text-format trace: the tag format's <tool_result>, or the Claude format's <result>'s <stdout> or <error>. */
const RESULT_BLOCK = /<tool_result>\n?([\s\S]*?)\n?<\/tool_result>|<result>\s*(?:<tool_name>[\s\S]*?<\/tool_name>\s*)?<stdout>\n?([\s\S]*?)\n?<\/stdout>\s*<\/result>|<error>\n?([\s\S]*?)\n?<\/error>/g;

export const nativeCodec: ToolCallCodec = {
  toolsPrompt() {
    return '';
  },

  definitions(tools) {
    return tools.map(functionDefinition);
  },

  read(reply) {
    // An id is the API's to give; one that came without is given one, the same in the message and its result.
    const toolCalls: NativeToolCall[] = (reply.toolCalls ?? []).map((call, i) => ({ ...call, id: call.id || `call_${i}` }));
    const message: ChatMessage = { role: 'assistant', content: reply.text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    return { prose: reply.text.trim(), calls: toolCalls.map(readNativeCall), message };
  },

  results(calls, contents, note) {
    return calls.map((call, i) => ({
      role: 'tool' as const,
      toolCallId: call.id ?? '',
      content: note && i === calls.length - 1 ? `${contents[i]}\n\n${note}` : contents[i],
    }));
  },

  unanswered(calls) {
    return calls.map((call) => ({ role: 'tool' as const, toolCallId: call.id ?? '', content: NOT_RUN_RESULT }));
  },

  replay(trace, turn) {
    const out: ChatMessage[] = [];
    let next = 0;
    for (let i = 0; i < trace.length; i++) {
      const message = trace[i];
      const parsed = message.role === 'assistant' && message.toolCalls === undefined ? tagCodec.parse(message.content) : null;
      if (parsed === null || parsed.calls.length === 0) {
        out.push({ ...message });
        continue;
      }
      const results = trace[i + 1]?.role === 'user' ? readResults(trace[i + 1].content) : null;
      if (results === null || results.contents.length !== parsed.calls.length) {
        // Calls never answered (the last reply's, past maxRounds): its prose alone.
        if (parsed.prose) out.push({ role: 'assistant', content: parsed.prose });
        continue;
      }
      i += 1;
      const toolCalls: NativeToolCall[] = [];
      const answers: ChatMessage[] = [];
      parsed.calls.forEach((call, k) => {
        if (!call.ok) return;
        const id = `replay_${turn}_${next++}`;
        toolCalls.push({ id, name: call.name, arguments: JSON.stringify(call.args) });
        answers.push({ role: 'tool', toolCallId: id, content: results.contents[k] });
      });
      if (results.note && answers.length > 0) answers[answers.length - 1].content += `\n\n${results.note}`;
      if (toolCalls.length > 0) out.push({ role: 'assistant', content: parsed.prose, toolCalls }, ...answers);
      else if (parsed.prose) out.push({ role: 'assistant', content: parsed.prose });
    }
    return out;
  },
};

function readNativeCall(call: NativeToolCall): ParsedToolCall {
  const id = call.id;
  const name = typeof call.name === 'string' ? call.name.trim() : '';
  if (!name) return { ok: false, id, reason: 'it names no tool ("name")' };
  const raw = typeof call.arguments === 'string' ? call.arguments.trim() : '';
  if (!raw) return { ok: true, id, name, args: {} };
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch (error) {
    return { ok: false, id, reason: `its arguments are not valid JSON (${(error as Error).message})` };
  }
  if (!isObject(args)) return { ok: false, id, reason: '"arguments" is not a JSON object' };
  return { ok: true, id, name, args };
}

/** A text-format results turn (tags or Claude's): each result's content, and the note after them. Null when it holds none. */
function readResults(text: string): { contents: string[]; note: string } | null {
  const contents = [...text.matchAll(RESULT_BLOCK)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (contents.length === 0) return null;
  return { contents, note: text.replace(RESULT_BLOCK, '').replace(/<\/?function_results>/g, '').trim() };
}
