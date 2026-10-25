/**
 * Ask: a chat about one video's transcript. DatabaseModule and CommonModule
 * are global; the chat goes straight to Crucible (never the task queue).
 */
import { Module } from '@nestjs/common';
import { CrucibleModule } from '../crucible/crucible.module';
import { CrucibleLlmModule } from '../crucible/llm/crucible-llm.module';
import { VideoChatController } from './video-chat.controller';
import { VideoChatService } from './video-chat.service';

@Module({
  imports: [CrucibleModule, CrucibleLlmModule],
  controllers: [VideoChatController],
  providers: [VideoChatService],
})
export class VideoChatModule {}
