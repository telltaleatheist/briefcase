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
import { ClaudeCliService } from '../../claude-cli/claude-cli.service';

@Module({
  imports: [CrucibleModule],
  controllers: [CrucibleAiController],
  // TEMPORARY (claude-cli): ClaudeCliService, the local Claude Code CLI (the
  // user's exception to Crucible-only AI), rides here so the analysis and Ask reach it.
  providers: [CrucibleChatService, CrucibleAiService, LegacyApiKeys, ClaudeCliService],
  exports: [CrucibleChatService, CrucibleAiService, ClaudeCliService],
})
export class CrucibleLlmModule {}
