/**
 * The tool harness's transport for Briefcase (tool-harness/ ChatTransport): a
 * chat through Crucible's chat door, in either of the harness's formats. With
 * the native codec the loop hands it the tools as definitions: they are sent
 * as `tools` (tool_choice auto), and the reply's structured calls come back as
 * `toolCalls`, the assistant's calls and the `tool` results crossing in the
 * next round's messages (Crucible 2.0.30+, every route). With the tag codec
 * no tools are sent: the harness puts them in the system prompt and reads
 * inline <tool_use> tags out of the reply. No response_format either way:
 * replies are free prose (and Crucible refuses it beside tools).
 *
 * What crosses the wire is target.ts's rule, as for every Briefcase call: a
 * cloud upstream gets no temperature and no max_tokens; a local model and
 * ollama/ get the unspecified-task temperature.
 */
import type { CrucibleChatService } from '../crucible/llm/crucible-chat.service';
import { CrucibleChatError } from '../crucible/llm/errors';
import { stripThinkTags, temperatureForTask } from '../analysis/model-utils';
import type { ChatTransport } from '../tool-harness';
import type { ClaudeCliService } from '../claude-cli/claude-cli.service';

export interface CrucibleTransportOptions {
  /** The stored choice, read by target.ts. */
  provider: string;
  model: string;
  /** `ollama/` only: the window, sent as `context_tokens` (num_ctx), fixed for the whole answer. */
  contextTokens?: number;
  /** A local model: the context it is loaded at, at least. */
  loadContext?: number;
  /** A local model: the reply's token ceiling (cloud upstreams are never sent one, target.ts). */
  maxTokens?: number;
  /** A local model: thinking on or off (absent: the model's default). */
  thinking?: boolean;
  /** The temperature for a local model or `ollama/` (absent: the unspecified-task default). */
  temperature?: number;
}

export function crucibleTransport(chat: CrucibleChatService, options: CrucibleTransportOptions): ChatTransport {
  return async (messages, { signal, tools }) => {
    const result = await chat.chat({
      provider: options.provider,
      model: options.model,
      messages,
      ...(tools === undefined || tools.length === 0 ? {} : { tools, toolChoice: 'auto' }),
      temperature: options.temperature ?? temperatureForTask(),
      ...(options.contextTokens === undefined ? {} : { contextTokens: options.contextTokens }),
      ...(options.loadContext === undefined ? {} : { loadContext: options.loadContext }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = stripThinkTags(result.text);
    const toolCalls = result.toolCalls ?? [];
    // The tag format on a Crucible before 2.0.30: a model that falls back to
    // its own native tool call (Qwen's <tool_call> special token) has the call
    // lifted out of its reply by the engine, and that Crucible doesn't relay
    // `tool_calls`: what arrives is nothing. Said, not read as an empty answer.
    // (2.0.30+ relays the calls when tools were sent, and returns a stray call
    // as content when none were, so this no longer fires there.)
    if (result.finishReason === 'tool_calls' && toolCalls.length === 0 && !text.trim()) {
      throw new CrucibleChatError(502, 'tool_call_lost', `${options.model} called a tool in its own native format, which Crucible doesn't pass back. Ask again.`);
    }
    return { text, ...(toolCalls.length === 0 ? {} : { toolCalls }), usage: result.usage };
  };
}

/**
 * TEMPORARY (claude-cli): the transport for a `claude-cli:` choice, the local
 * Claude Code CLI (a user-requested exception to Crucible-only AI). The
 * conversation is flattened into one `-p` prompt (claude-cli.service.ts); no
 * temperature, no max_tokens, nothing through Crucible. Always the Claude
 * codec (tool-format.ts): its history is replayed in that text format, so no
 * `tool` message reaches it (one that did would go as a user turn).
 */
export function claudeCliTransport(cli: ClaudeCliService, model: string): ChatTransport {
  return async (messages, { signal }) => {
    const turns = messages.map((m) => ({ role: m.role === 'tool' ? 'user' as const : m.role, content: m.content }));
    const result = await cli.complete({ model, messages: turns, ...(signal === undefined ? {} : { signal }) });
    return { text: stripThinkTags(result.text), usage: result.usage };
  };
}
