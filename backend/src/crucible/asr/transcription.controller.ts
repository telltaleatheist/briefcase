/**
 * `/crucible/transcription`: what Settings › Transcription reads (P5). There is
 * nothing to set: Briefcase transcribes with Qwen3-ASR on the selected server.
 * Every refusal is `{code, message}`; no response carries a token.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { LoopbackOriginGuard } from '../loopback-origin.guard';
import type { TranscriptionView } from '../wire/transcription-wire';
import { CrucibleTranscriptionService } from './crucible-transcription.service';

@UseGuards(LoopbackOriginGuard)
@Controller('crucible/transcription')
export class CrucibleTranscriptionController {
  constructor(private readonly transcription: CrucibleTranscriptionService) {}

  @Get()
  view(): Promise<TranscriptionView> {
    return this.transcription.view();
  }
}
