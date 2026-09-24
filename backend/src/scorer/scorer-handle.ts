/**
 * THE SCORER SEAM: what the snap pipelines (chapters, flags, refinement) are
 * handed for one scorer lease. Crucible's decision door implements it
 * (crucible-scorer.service.ts); P7 removed the scorer's own llama-server, the
 * other implementation. Chapters, flags and every decision about them stay
 * above this seam, in Briefcase.
 */

import type { ChatMessage, DecideOptions, DecideRequest, DecideResponse, GenerateOptions, GenerateResult } from './scorer.types';

export interface ScorerHandle {
  decide(req: DecideRequest, options?: DecideOptions): Promise<DecideResponse>;
  generate(messages: ChatMessage[] | string, options: GenerateOptions): Promise<GenerateResult>;
  /** The model the decisions are read from, as the engine names it. */
  readonly model: string;
  /** Tokens `text` is on this model (chunk planning). */
  countTokens(text: string, signal?: AbortSignal): Promise<number>;
}
