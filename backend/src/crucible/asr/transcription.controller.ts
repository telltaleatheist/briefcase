/**
 * `/crucible/transcription`: Settings › Transcription and the setup wizard (P5).
 * Every refusal is `{code, message}`; no response carries a token.
 */
import { Body, Controller, Get, HttpException, HttpStatus, Put, UseGuards } from '@nestjs/common';
import { LoopbackOriginGuard } from '../loopback-origin.guard';
import type { TranscriptionView } from '../wire/transcription-wire';
import { CrucibleTranscriptionService } from './crucible-transcription.service';
import { TranscriptionSettingError } from './transcription-setting';

@UseGuards(LoopbackOriginGuard)
@Controller('crucible/transcription')
export class CrucibleTranscriptionController {
  constructor(private readonly transcription: CrucibleTranscriptionService) {}

  @Get()
  view(): Promise<TranscriptionView> {
    return this.transcription.view();
  }

  /** `{venue: 'auto'|'crucible'|'whisper-cli', server: string|null, model: string|null}`. */
  @Put()
  async save(@Body() body: unknown): Promise<TranscriptionView> {
    try {
      this.transcription.saveSetting(body);
    } catch (err) {
      if (err instanceof TranscriptionSettingError) {
        throw new HttpException({ code: err.code, message: err.message }, HttpStatus.BAD_REQUEST);
      }
      throw err;
    }
    this.transcription.forget();
    return this.transcription.view();
  }
}
