/**
 * The tool harness's transport for Briefcase (tool-harness/ ChatTransport): a
 * plain chat through Crucible's chat door. The harness puts the tools in the
 * system prompt and reads inline <tool_use> tags out of the reply, so
 * no response_format and no native `tools` are sent: replies are free prose.
 * Crucible refuses native `tools`/`tool_calls` on its upstreams today; when it
 * passes them through, a transport that sends them (with a matching codec)
 * replaces this one.
 *
 * What crosses the wire is target.ts's rule, as for every Briefcase call: a
 * cloud upstream gets no temperature and no max_tokens; a local model and
 * ollama/ get the unspecified-task temperature.
 */
import type { CrucibleChatService } from '../crucible/llm/crucible-chat.service';
import { CrucibleChatError } from '../crucible/llm/errors';
import { stripThinkTags, temperatureForTask } from '../analysis/model-utils';
import type { ChatTransport } from '../tool-harness';

export interface CrucibleTransportOptions {
  /** The stored choice, read by target.ts. */
  provider: string;
  model: string;
  /** `ollama/` only: the window, sent as `context_tokens` (num_ctx), fixed for the whole answer. */
  contextTokens?: number;
  /** A local model: the context it is loaded at, at least. */
  loadContext?: number;
}

export function crucibleTransport(chat: CrucibleChatService, options: CrucibleTransportOptions): ChatTransport {
  return async (messages, { signal }) => {
    const result = await chat.chat({
      provider: options.provider,
      model: options.model,
      messages,
      temperature: temperatureForTask(),
      ...(options.contextTokens === undefined ? {} : { contextTokens: options.contextTokens }),
      ...(options.loadContext === undefined ? {} : { loadContext: options.loadContext }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = stripThinkTags(result.text);
    // A model that falls back to its own native tool call (Qwen's <tool_call>
    // special token) has the call lifted out of its reply by the engine, and
    // Crucible doesn't relay `tool_calls`: what arrives is nothing. Said, not
    // read as an empty answer.
    if (result.finishReason === 'tool_calls' && !text.trim()) {
      throw new CrucibleChatError(502, 'tool_call_lost', `${options.model} called a tool in its own native format, which Crucible doesn't pass back. Ask again.`);
    }
    return { text, usage: result.usage };
  };
}
