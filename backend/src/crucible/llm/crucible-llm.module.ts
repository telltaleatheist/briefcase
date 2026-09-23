/**
 * LLM calls through Crucible (P3): the chat service every generateText call
 * goes through under `aiVia: 'crucible'`, and the AI pane's door.
 *
 * Its own module so the analysis pipeline can import it without pulling the
 * install door, and so ApiKeysModule (the legacy key file the one-time copy
 * reads) stays out of CrucibleModule.
 */
import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../../config/config.module';
import { CrucibleModule } from '../crucible.module';
import { CrucibleAiController } from './crucible-ai.controller';
import { CrucibleAiService } from './crucible-ai.service';
import { CrucibleChatService } from './crucible-chat.service';

@Module({
  imports: [CrucibleModule, ApiKeysModule],
  controllers: [CrucibleAiController],
  providers: [CrucibleChatService, CrucibleAiService],
  exports: [CrucibleChatService, CrucibleAiService],
})
export class CrucibleLlmModule {}
