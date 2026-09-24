/**
 * The DI wiring (P5): CrucibleAsrModule resolves on its own, and WhisperService
 * (the one transcription seam) gets the Crucible transcription service
 * injected beside it, as MediaModule wires them.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CrucibleAsrModule } from '../../src/crucible/asr/crucible-asr.module';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleTranscriptionController } from '../../src/crucible/asr/transcription.controller';
import { MediaEventService } from '../../src/media/media-event.service';
import { WhisperService } from '../../src/media/whisper.service';
import { tempDir } from './helpers';

@Module({
  imports: [CrucibleAsrModule],
  providers: [WhisperService, { provide: MediaEventService, useValue: {} }],
})
class ProbeModule {}

describe('CrucibleAsrModule wiring', () => {
  const saved = { ...process.env };
  afterAll(() => { process.env = saved; });

  it('resolves the service and its door, and hands the service to WhisperService', async () => {
    process.env = { ...saved, APPDATA: tempDir('asr-module-') };
    const ref = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const service = ref.get(CrucibleTranscriptionService);
    expect(service).toBeInstanceOf(CrucibleTranscriptionService);
    expect(ref.get(CrucibleTranscriptionController)).toBeInstanceOf(CrucibleTranscriptionController);
    expect((ref.get(WhisperService) as unknown as { crucibleAsr: unknown }).crucibleAsr).toBe(service);
    await ref.close();
  });
});
