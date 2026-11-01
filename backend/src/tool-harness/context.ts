/**
 * KEEPING A TOOL LOOP'S REQUESTS WITHIN THE MODEL'S CONTEXT (loop.ts).
 *
 * A request's size is what the model API last measured plus an estimate of
 * what was added since: the transport's usage of the previous request
 * (`usageTokens`: its prompt and its reply) counts every message it held, and
 * the messages after them are counted at `charsPerToken`. With no usage (or
 * just after a cut, which changed what was measured) all of it is estimated,
 * at `charsPerToken` or at what the last measured request came to, whichever
 * counts more tokens (text denser than the estimate is never undercounted
 * twice).
 *
 * A request over the budget is CUT: results of tools that allow it
 * (Tool.dropOrder) are replaced by the dropped note, in groups of one round's
 * results of one order, the lowest order first and, within it, the oldest
 * round first, until the conversation is down to `cutTo` of the room above
 * its fixed part (the system prompt, history and question). Cutting that far
 * in one step, rather than just under the budget, is what lets the next
 * several requests only append, so the prefix a server has cached stays the
 * same until the next cut. The newest round's results are never dropped: the
 * model has not seen them yet.
 */
import type { ChatMessage } from './types';

export interface ContextBudget {
  /** The most tokens a request may hold: the model's context less the room its reply needs. */
  tokens: number;
  /** Characters a token, for estimating what no usage has measured (kept on the safe side). */
  charsPerToken: number;
  /** A reply's usage as token counts (its request's prompt, its own completion), or null when it states none. */
  usageTokens?: (usage: unknown) => { prompt: number; completion: number } | null;
  /** How far a cut goes: this share of the room above the fixed prompt (default {@link DEFAULT_CUT_TO}). */
  cutTo?: number;
  /** What a dropped result is replaced by (default {@link DEFAULT_DROPPED_NOTE}). */
  droppedNote?: string;
}

export const DEFAULT_CUT_TO = 0.5;

export const DEFAULT_DROPPED_NOTE = '[This result was dropped to fit the context; make the call again if you need it.]';

/** A request the model API measured: how many messages it held, its prompt tokens and its reply's. */
export interface Measured {
  messages: number;
  prompt: number;
  completion: number;
}

/** What the fitter needs of a round: for each result, the order it may be dropped in (undefined: never), and whether it has been. */
export interface FitRound {
  droppable: Array<number | undefined>;
  dropped: boolean[];
}

function chars(message: ChatMessage): number {
  return message.content.length + (message.toolCalls ?? []).reduce((sum, call) => sum + call.name.length + call.arguments.length, 0);
}

/** A request's characters: its messages' text and calls, and the native tool definitions sent beside it. */
export function requestChars(messages: ReadonlyArray<ChatMessage>, definitionChars: number): number {
  return messages.reduce((sum, m) => sum + chars(m), 0) + definitionChars;
}

/** The tokens a request holds: measured where it can be, estimated past that. `definitionChars`: the native tool definitions sent beside it. */
export function requestTokens(messages: ReadonlyArray<ChatMessage>, definitionChars: number, budget: ContextBudget, measured: Measured | null): number {
  if (measured !== null && measured.messages < messages.length) {
    // The measured request's messages, then its reply (the completion), then what was added after it.
    const added = messages.slice(measured.messages + 1).reduce((sum, m) => sum + chars(m), 0);
    return measured.prompt + measured.completion + Math.ceil(added / budget.charsPerToken);
  }
  return Math.ceil(requestChars(messages, definitionChars) / budget.charsPerToken);
}

/**
 * Cut the rounds (marking results dropped, in place) until the conversation
 * is at most `cutTo` of the room above its fixed part, or nothing more may be
 * dropped. Returns the estimated size it was cut to.
 */
export function fitRounds<R extends FitRound>(
  rounds: R[],
  render: (round: R) => ChatMessage[],
  base: ReadonlyArray<ChatMessage>,
  definitionChars: number,
  budget: ContextBudget,
): { tokens: number } {
  const size = () => requestTokens([...base, ...rounds.flatMap(render)], definitionChars, budget, null);
  const fixed = requestTokens(base, definitionChars, budget, null);
  const target = fixed + Math.floor((budget.tokens - fixed) * (budget.cutTo ?? DEFAULT_CUT_TO));
  const groups: Array<{ order: number; round: number }> = [];
  rounds.slice(0, -1).forEach((round, index) => {
    const orders = new Set(round.droppable.filter((order, i): order is number => order !== undefined && !round.dropped[i]));
    for (const order of orders) groups.push({ order, round: index });
  });
  groups.sort((a, b) => a.order - b.order || a.round - b.round);
  let tokens = size();
  for (const group of groups) {
    if (tokens <= target) break;
    const round = rounds[group.round];
    round.droppable.forEach((order, i) => {
      if (order === group.order) round.dropped[i] = true;
    });
    tokens = size();
  }
  return { tokens };
}
