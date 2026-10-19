import type { AiModelsView } from '@crucible-wire/ai-wire';

/**
 * An options view for specs: the Mac Studio as it answers on 2026-10-19
 * (Crucible 2.0.16): the 27B ceiling (its pick today, the 8-bit) and the 9B,
 * no upstream configured, unless patched.
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
        { value: 'local:max-27b', label: 'Biggest that fits, up to 27B (qwen3.8-27b-8bit)', group: 'server', sizeB: 27, resident: false, serverChoice: true },
        { value: 'local:qwen3.5-9b', label: 'qwen3.5-9b', group: 'server', sizeB: 9, resident: false, serverChoice: false },
      ],
    }],
    analysisDefault: 'local:max-27b',
    resolved: [],
    ...patch,
  };
}
