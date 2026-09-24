/**
 * LLM calls through Crucible (P3): the chat service every generateText call
 * goes through (the only road since P7), and the AI pane's door.
 *
 * Its own module so the analysis pipeline can import it without pulling the
 * install door. LegacyApiKeys is the old api-keys.json, read only by the
 * one-time "copy my keys to Crucible" action.
 */
import { Module } from '@nestjs/common';
import { CrucibleModule } from '../crucible.module';
import { CrucibleAiController } from './crucible-ai.controller';
import { CrucibleAiService } from './crucible-ai.service';
import { CrucibleChatService } from './crucible-chat.service';
import { LegacyApiKeys } from './legacy-api-keys';

@Module({
  imports: [CrucibleModule],
  controllers: [CrucibleAiController],
  providers: [CrucibleChatService, CrucibleAiService, LegacyApiKeys],
  exports: [CrucibleChatService, CrucibleAiService],
})
export class CrucibleLlmModule {}
