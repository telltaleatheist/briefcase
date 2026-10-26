/**
 * A tool-calling harness for chat models: tools described in the prompt and
 * calls read from the reply's tags, or sent as native definitions and read
 * from its structured calls; results sent back, in a bounded loop. Self-contained (no imports outside this folder); see
 * README.md.
 */
export type {
  ChatMessage,
  ChatTransport,
  NativeToolCall,
  ParsedToolCall,
  Tool,
  ToolCallCodec,
  ToolCallRecord,
  ToolContext,
  ToolDefinition,
  ToolLoopEvent,
  TransportOptions,
  TransportReply,
} from './types';
export { DEFAULT_MAX_ROUNDS, LAST_ROUND_NOTE, runToolLoop, ToolLoopAborted, type ToolLoopOptions, type ToolLoopResult } from './loop';
export { functionDefinition, tagCodec, toolUseBlock, type TagCodec } from './tag-codec';
export { nativeCodec, NOT_RUN_RESULT } from './native-codec';
export { claudeCodec, functionCallsBlock, type ClaudeCodec } from './claude-codec';
export { replayHistory, type StoredTurn } from './history';
export { parseLenientJson } from './lenient-json';
