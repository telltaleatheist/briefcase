/**
 * Transcription through Crucible's `asr` job (P5): the venue rule, the job
 * runner and the settings door. Its own module so MediaModule (WhisperService,
 * the one transcription seam) and QueueModule (the GPU lanes) can import it
 * without pulling the install door or the LLM chat service.
 */
import { Module } from '@nestjs/common';
import { CrucibleModule } from '../crucible.module';
import { CrucibleTranscriptionController } from './transcription.controller';
import { CrucibleTranscriptionService } from './crucible-transcription.service';

@Module({
  imports: [CrucibleModule],
  controllers: [CrucibleTranscriptionController],
  providers: [CrucibleTranscriptionService],
  exports: [CrucibleTranscriptionService],
})
export class CrucibleAsrModule {}
