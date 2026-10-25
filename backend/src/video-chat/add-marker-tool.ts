/**
 * THE ASK CHAT'S ONE TOOL, add_marker: the model quotes, Briefcase places.
 *
 * A call names a passage by its first and last words, copied from the
 * transcript; they are found in the transcript's sentences
 * (analysis/passage-anchor.ts, the flags pipeline's matcher), and the marker
 * spans those sentences' segment times. Words that can't be found place
 * nothing: the model is told so (with the words it sent) and may quote again.
 * A placed marker goes back to the model with its times, so it knows where
 * it landed, and to Briefcase as the call's `data`.
 */
import type { RankedSentence } from '../analysis/flag-windows';
import { formatHms } from '../analysis/analysis-parts';
import { chunkWords, matchPassage, type ChunkWords } from '../analysis/passage-anchor';
import {
  ADD_MARKER_DESCRIPTION,
  ADD_MARKER_PARAMETERS,
  ADD_MARKER_TOOL_NAME,
  markerNotFoundResult,
  markerPlacedResult,
} from '../analysis/prompts/video-chat-prompts';
import type { Tool } from '../tool-harness';

export interface MarkerRequest {
  title: string;
  firstWords: string;
  lastWords: string;
  note: string | null;
}

export interface PlacedMarker extends MarkerRequest {
  startSeconds: number;
  endSeconds: number;
}

/** The transcript a chat reads: its sentences, and their words for finding quotes. */
export interface ChatTranscript {
  sentences: RankedSentence[];
  words: ChunkWords;
}

export function chatTranscript(sentences: RankedSentence[]): ChatTranscript {
  return { sentences, words: chunkWords(sentences) };
}

/** Where a requested marker lands: its quoted passage's sentences' times, or null when its words aren't found. */
export function placeMarker(transcript: ChatTranscript, request: MarkerRequest): PlacedMarker | null {
  const hit = matchPassage(transcript.words, request.firstWords, request.lastWords);
  if (!hit) return null;
  return { ...request, startSeconds: transcript.sentences[hit.from].start, endSeconds: transcript.sentences[hit.to].end };
}

/** add_marker over one transcript. Arguments missing a title or an anchor are refused by name (the harness tells the model). */
export function addMarkerTool(transcript: ChatTranscript): Tool<Record<string, unknown>, PlacedMarker> {
  return {
    name: ADD_MARKER_TOOL_NAME,
    description: ADD_MARKER_DESCRIPTION,
    parameters: ADD_MARKER_PARAMETERS,
    async execute(args) {
      const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
      const missing = ['title', 'first_words', 'last_words'].filter((key) => !str(key));
      if (missing.length > 0) throw new Error(`the arguments have no ${missing.join(', ')}`);
      const request: MarkerRequest = { title: str('title'), firstWords: str('first_words'), lastWords: str('last_words'), note: str('note') || null };
      const placed = placeMarker(transcript, request);
      if (placed === null) return { content: markerNotFoundResult(request.title, request.firstWords, request.lastWords) };
      return { content: markerPlacedResult(placed.title, formatHms(placed.startSeconds), formatHms(placed.endSeconds)), data: placed };
    },
  };
}
