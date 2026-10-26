/**
 * WHICH TOOL-CALL FORMAT A MODEL GETS (tool-harness/ codecs), decided here
 * only: each model the format it was trained on, where Briefcase can give it.
 *
 *   claude-cli   the Claude format (claude-codec.ts): `claude -p` takes no
 *                tool definitions, so the tools go in the prompt in the
 *                <function_calls> shape Claude was trained on;
 *   native       a Crucible that takes `tools` (2.0.30+, nativeToolsFor):
 *                definitions sent, and the engine writes each model's own
 *                template (Qwen's included) underneath;
 *   tags         everything else: plain <tool_use> tags in the prompt.
 *
 * A model a Crucible refuses native tools for falls back to tags in the
 * service (and is remembered there), not here.
 */
import { claudeCodec, nativeCodec, tagCodec, type ToolCallCodec } from '../tool-harness';

export type ToolFormat = 'claude' | 'native' | 'tags';

export interface ToolFormatFacts {
  /** The choice is a `claude-cli:` model (the local Claude Code CLI). */
  claudeCli: boolean;
  /** The serving Crucible takes native tools for this model (2.0.30+, not refused). */
  nativeTools: boolean;
}

export function toolFormatFor(facts: ToolFormatFacts): ToolFormat {
  if (facts.claudeCli) return 'claude';
  return facts.nativeTools ? 'native' : 'tags';
}

export function codecFor(format: ToolFormat): ToolCallCodec {
  return format === 'claude' ? claudeCodec : format === 'native' ? nativeCodec : tagCodec;
}
