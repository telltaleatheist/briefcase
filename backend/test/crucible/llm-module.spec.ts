/**
 * The DI wiring: CrucibleLlmModule resolves on its own, and AIProviderService
 * gets the chat service injected (so `via()` can answer 'crucible').
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { LlamaManager } from '../../src/bridges';
import { CrucibleAiService } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLlmModule } from '../../src/crucible/llm/crucible-llm.module';
import { AI_VIA_ENV } from '../../src/crucible/llm/ai-via';
import { ApiKeysService } from '../../src/config/api-keys.service';
import { ModelManagerService } from '../../src/config/model-manager.service';
import { tempDir } from './helpers';

@Module({
  imports: [CrucibleLlmModule],
  providers: [AIProviderService, { provide: LlamaManager, useValue: { isAvailable: () => false } }],
})
class ProbeModule {}

describe('CrucibleLlmModule wiring', () => {
  const saved = { ...process.env };
  afterAll(() => { process.env = saved; });

  it('resolves the chat and AI services, and hands the chat service to AIProviderService', async () => {
    process.env = { ...saved, APPDATA: tempDir('llm-module-'), [AI_VIA_ENV]: 'crucible' };
    const ref = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot({ global: true }), ProbeModule] })
      // Never the real ones: they read the user's own api-keys.json and models dir.
      .overrideProvider(ApiKeysService).useValue({ keysForCopy: () => ({}) })
      .overrideProvider(ModelManagerService).useValue({})
      .compile()
      .catch((err) => { throw err; });
    expect(ref.get(CrucibleChatService)).toBeInstanceOf(CrucibleChatService);
    expect(ref.get(CrucibleAiService)).toBeInstanceOf(CrucibleAiService);
    expect(ref.get(AIProviderService).via()).toBe('crucible');
    await ref.close();
  });
});
