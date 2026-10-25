/**
 * A tool-calling harness for chat models that may not take native tools:
 * tools described in the prompt, calls read from the reply, results sent back,
 * in a bounded loop. Self-contained (no imports outside this folder); see
 * README.md.
 */
export type {
  ChatMessage,
  ChatTransport,
  ParsedToolCall,
  Tool,
  ToolCallCodec,
  ToolCallRecord,
  ToolContext,
  ToolLoopEvent,
  TransportReply,
} from './types';
export { DEFAULT_MAX_ROUNDS, LAST_ROUND_NOTE, runToolLoop, ToolLoopAborted, type ToolLoopOptions, type ToolLoopResult } from './loop';
export { functionDefinition, tagCodec } from './tag-codec';
export { replayHistory, type StoredTurn } from './history';
export { parseLenientJson } from './lenient-json';
