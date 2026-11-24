import { describe, expect, it } from '@jest/globals';

import { ffmpegFailure } from '../bridges/ffmpeg-bridge';
import { ClipExtractorService } from './clip-extractor.service';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('ClipExtractorService.generateClipFilename', () => {
  const service = new ClipExtractorService();

  it('names a clip by its upload date and title', () => {
    expect(service.generateClipFilename('source.mp4', 10, 20, 'false-prophecy', 'Says the mint: gold?', '2026-11-20'))
      .toBe('2026-11-20 Says the mint gold.mp4');
  });

  it('keeps a long title within what the filesystem accepts (255 bytes)', () => {
    // 2026-11-23: this export failed with ffmpeg's "File name too long".
    const title = 'Says blockchain will absolutely be the Mark of the Beast, Antichrist will use it — Flatly asserts end-times prophecy as certain: the blockchain will be the Mark of the Beast and the Antichrist will use it, while telling viewers not to be scared.';
    const name = service.generateClipFilename('source.mp4', 763, 961.6, 'false-prophecy', title, '2026-11-20');
    expect(name.startsWith('2026-11-20 Says blockchain will absolutely')).toBe(true);
    expect(name.endsWith('.mp4')).toBe(true);
    expect(bytes(name + ' (censored)')).toBeLessThanOrEqual(255);
  });

  it('cuts a long source name, not the time range, when there is no title', () => {
    const source = `${'a very long source name '.repeat(12)}.mov`;
    const name = service.generateClipFilename(source, 65, 130, 'hate');
    expect(name.endsWith('_hate_01-05_02-10.mov')).toBe(true);
    expect(bytes(name)).toBeLessThanOrEqual(255);
  });

  it('names a full video by its source and category', () => {
    expect(service.generateClipFilename('show.mp4', null, null, 'hate')).toBe('show_hate.mp4');
    expect(service.generateClipFilename('show.mp4', null, null)).toBe('show_scaled.mp4');
  });
});

describe('ffmpegFailure', () => {
  it("carries ffmpeg's last line, the reason", () => {
    const stderr = '  Stream #0:1(und): Audio: aac\n    Metadata:\n/Volumes/x/clip.mp4: File name too long\n';
    expect(ffmpegFailure(1, stderr)).toBe('FFmpeg exited with code 1: /Volumes/x/clip.mp4: File name too long');
  });

  it('keeps the line before a bare "Conversion failed!"', () => {
    expect(ffmpegFailure(1, 'frame= 10\rError while opening encoder\nConversion failed!\n'))
      .toBe('FFmpeg exited with code 1: Error while opening encoder Conversion failed!');
  });

  it('says only the code when stderr is empty', () => {
    expect(ffmpegFailure(255, '')).toBe('FFmpeg exited with code 255');
  });
});
