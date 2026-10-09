import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { AIAnalysisService } from './ai-analysis.service';
import type { AIGenerateOverrides, AIProviderService } from './ai-provider.service';
import type { SnapAnalysisService } from '../scorer/snap-analysis.service';

/**
 * Pass 2 (one title + summary per chapter) asks with thinking off, a small
 * ceiling and the {title, summary} schema. Left to a thinking model's manifest
 * default, qwen3.8-27b on the Mac reasoned until its context ran out on most
 * chapters of a 96-minute debate (2026-10-08) and the job failed.
 */
describe('Pass 2 chapter summary call', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('turns thinking off, caps the output and sends the schema', async () => {
    const calls: Array<{ task: string; overrides?: AIGenerateOverrides }> = [];
    const provider = {
      async generateText(_prompt: string, _config: unknown, task: string, overrides?: AIGenerateOverrides) {
        calls.push({ task, overrides });
        return { text: '{"title": "Opening statements", "summary": "Both sides state their case."}' };
      },
    } as unknown as AIProviderService;
    const service = new AIAnalysisService(provider, {} as SnapAnalysisService);

    const result = await (service as unknown as {
      analyzeChapterWithRetry(config: unknown, text: string, title: string, n: number, prev: string, custom?: string): Promise<{ title: string; summary: string }>;
    }).analyzeChapterWithRetry({ provider: 'local', model: 'qwen3.8-27b-8bit' }, 'Some words.', 'A debate', 1, '');

    expect(result).toMatchObject({ title: 'Opening statements', summary: 'Both sides state their case.' });
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('chapter');
    expect(calls[0].overrides).toMatchObject({ thinking: false, maxTokens: 1024 });
    expect(calls[0].overrides?.format).toMatchObject({ required: ['title', 'summary'] });
  });
});
