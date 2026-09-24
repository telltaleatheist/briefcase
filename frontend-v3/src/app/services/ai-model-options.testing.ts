import type { AiModelsView } from '@crucible-wire/ai-wire';

/**
 * An options view for specs: the Mac Studio as it answered on 2026-09-24
 * (Crucible 1.0.27): its three analysis candidates, no upstream configured,
 * unless patched.
 */
export function modelsView(patch: Partial<AiModelsView> = {}): AiModelsView {
  return {
    server: 'owens-mac-studio',
    local: true,
    reach: 'ready',
    unavailable: null,
    upstreams: { anthropic: { configured: false, keyHint: null }, openai: { configured: false, keyHint: null }, ollama: { configured: false, url: null } },
    groups: [{
      kind: 'server',
      label: 'On this Crucible',
      error: null,
      options: [
        { value: 'local:qwen3.8-27b-8bit', label: 'qwen3.8-27b-8bit', group: 'server', sizeB: 27, resident: false, serverChoice: true },
        { value: 'local:qwen3.8-27b-4bit', label: 'qwen3.8-27b-4bit', group: 'server', sizeB: 27, resident: false, serverChoice: false },
        { value: 'local:qwen3.5-9b', label: 'qwen3.5-9b', group: 'server', sizeB: 9, resident: false, serverChoice: false },
      ],
    }],
    analysisDefault: 'local:qwen3.8-27b-8bit',
    resolved: [],
    ...patch,
  };
}
