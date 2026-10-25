import { isClaudeCliValue, splitAiModelValue } from './ai-model-value';

describe('splitAiModelValue', () => {
  it('splits each provider, crucible: as local, and a bare id as local', () => {
    expect(splitAiModelValue('local:max-27b')).toEqual({ aiProvider: 'local', aiModel: 'max-27b' });
    expect(splitAiModelValue('crucible:qwen3.5-9b')).toEqual({ aiProvider: 'local', aiModel: 'qwen3.5-9b' });
    expect(splitAiModelValue('claude:claude-sonnet-5')).toEqual({ aiProvider: 'claude', aiModel: 'claude-sonnet-5' });
    expect(splitAiModelValue('ollama:qwen3:14b')).toEqual({ aiProvider: 'ollama', aiModel: 'qwen3:14b' });
    expect(splitAiModelValue('qwen3.5-9b')).toEqual({ aiProvider: 'local', aiModel: 'qwen3.5-9b' });
  });

  // TEMPORARY (claude-cli): the local Claude Code CLI.
  it('splits a claude-cli value, and knows one', () => {
    expect(splitAiModelValue('claude-cli:claude-haiku-5-5')).toEqual({ aiProvider: 'claude-cli', aiModel: 'claude-haiku-5-5' });
    expect(isClaudeCliValue('claude-cli:claude-opus-5-5')).toBeTrue();
    expect(isClaudeCliValue('claude:claude-opus-5')).toBeFalse();
    expect(isClaudeCliValue('claude-cli:')).toBeFalse();
    expect(isClaudeCliValue(null)).toBeFalse();
  });
});
