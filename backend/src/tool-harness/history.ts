/**
 * Replaying stored turns. A host stores, per answered turn, the user's message
 * and the loop's trace (runToolLoop's `trace`); replayed in order they are the
 * history of the next turn, so the model sees its own earlier tool calls and
 * their results.
 *
 * A trace is replayed through the codec the next turn runs with: a thread may
 * hold turns stored in the tag format and turns stored in the native one (a
 * thread from before native tools, a model switched mid-thread), and each
 * codec reads both into its own (tag-codec.ts, native-codec.ts).
 */
import { tagCodec } from './tag-codec';
import type { ChatMessage, ToolCallCodec } from './types';

export interface StoredTurn {
  userMessage: string;
  trace: ChatMessage[];
}

export function replayHistory(turns: ReadonlyArray<StoredTurn>, codec: ToolCallCodec = tagCodec): ChatMessage[] {
  return turns.flatMap((turn, i) => [{ role: 'user' as const, content: turn.userMessage }, ...codec.replay(turn.trace, i)]);
}
