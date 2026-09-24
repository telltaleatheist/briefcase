/**
 * The DI wiring: CrucibleLlmModule resolves on its own, and AIProviderService
 * takes the chat service (the only road since P7: no direct providers, no
 * llama runtime, no key file but the legacy one the copy action reads).
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { CrucibleAiService } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLlmModule } from '../../src/crucible/llm/crucible-llm.module';
import { LegacyApiKeys } from '../../src/crucible/llm/legacy-api-keys';
import { tempDir } from './helpers';

@Module({
  imports: [CrucibleLlmModule],
  providers: [AIProviderService],
})
class ProbeModule {}

describe('CrucibleLlmModule wiring', () => {
  const saved = { ...process.env };
  afterAll(() => { process.env = saved; });

  it('resolves the chat and AI services, and hands the chat service to AIProviderService', async () => {
    process.env = { ...saved, APPDATA: tempDir('llm-module-') };
    const ref = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot({ global: true }), ProbeModule] })
      .compile()
      .catch((err) => { throw err; });
    expect(ref.get(CrucibleChatService)).toBeInstanceOf(CrucibleChatService);
    expect(ref.get(CrucibleAiService)).toBeInstanceOf(CrucibleAiService);
    // The legacy key file is read under the (temp) APPDATA, never the user's own.
    expect(ref.get(LegacyApiKeys).file.startsWith(process.env.APPDATA!)).toBe(true);
    const provider = ref.get(AIProviderService);
    expect((provider as unknown as { crucibleChat: unknown }).crucibleChat).toBe(ref.get(CrucibleChatService));
    await ref.close();
  });
});
