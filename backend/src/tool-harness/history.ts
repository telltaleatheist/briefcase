/**
 * Replaying stored turns. A host stores, per answered turn, the user's message
 * and the loop's trace (runToolLoop's `trace`); replayed in order they are the
 * history of the next turn, so the model sees its own earlier tool calls and
 * their results.
 */
import type { ChatMessage } from './types';

export interface StoredTurn {
  userMessage: string;
  trace: ChatMessage[];
}

export function replayHistory(turns: ReadonlyArray<StoredTurn>): ChatMessage[] {
  return turns.flatMap((turn) => [{ role: 'user' as const, content: turn.userMessage }, ...turn.trace]);
}
