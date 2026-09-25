// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import {
  buildLoudnormFilter,
  isAlreadyNormalized,
  DEFAULT_LOUDNESS_TARGET,
  LOUDNESS_TOLERANCE_LU,
} from './ffmpeg.service';
import type { LoudnessMeasurement } from '../bridges';

/**
 * Regression cover for the loudness bug: the normalize step used to hand the
 * LUFS target to ffmpeg's `volume` filter, which read -16 LUFS as a 16 dB cut
 * and buried the audio ~22 LU below where it belonged.
 */
describe('buildLoudnormFilter', () => {
  const measurement: LoudnessMeasurement = {
    inputI: -17.69,
    inputTP: 2.14,
    inputLRA: 13.0,
    inputThresh: -28.28,
    targetOffset: 3.07,
  };

  it('defaults to the streaming reference level, not a broadcast-quiet one', () => {
    expect(DEFAULT_LOUDNESS_TARGET).toBe(-14);
  });

  it('targets integrated loudness rather than applying the target as a gain', () => {
    const filter = buildLoudnormFilter(-14);
    expect(filter).toContain('loudnorm=I=-14');
    expect(filter).not.toContain('volume=');
  });

  it('caps true peak at the streaming spec', () => {
    expect(buildLoudnormFilter(-14)).toContain('TP=-1');
  });

  it('falls back to one-pass when there is no measurement', () => {
    expect(buildLoudnormFilter(-14, null)).toBe('loudnorm=I=-14:TP=-1:LRA=11');
    expect(buildLoudnormFilter(-14, undefined)).toBe('loudnorm=I=-14:TP=-1:LRA=11');
  });

  it('feeds every measured value back for the linear second pass', () => {
    const filter = buildLoudnormFilter(-14, measurement);
    expect(filter).toContain('measured_I=-17.69');
    expect(filter).toContain('measured_TP=2.14');
    expect(filter).toContain('measured_LRA=13');
    expect(filter).toContain('measured_thresh=-28.28');
    expect(filter).toContain('offset=3.07');
    expect(filter).toContain('linear=true');
  });

  it('honors a louder target when the user asks for one', () => {
    expect(buildLoudnormFilter(-9)).toContain('loudnorm=I=-9');
  });

  it('emits options ffmpeg can parse, with no stray separators', () => {
    const filter = buildLoudnormFilter(-14, measurement);
    for (const part of filter.replace(/^loudnorm=/, '').split(':')) {
      expect(part).toMatch(/^[A-Za-z_]+=-?[\d.a-z]+$/);
    }
  });
});

/**
 * The skip test. It has to converge: normalizing a file once must leave it in a
 * state where normalizing again does nothing, or every run re-encodes forever.
 */
describe('isAlreadyNormalized', () => {
  const at = (i: number, tp = -1.0): LoudnessMeasurement => ({
    inputI: i,
    inputTP: tp,
    inputLRA: 8,
    inputThresh: -25,
    targetOffset: 0,
  });

  it('skips a file sitting on the target', () => {
    expect(isAlreadyNormalized(at(-14), -14)).toBe(true);
  });

  it('skips within tolerance on both sides', () => {
    expect(isAlreadyNormalized(at(-14 + LOUDNESS_TOLERANCE_LU), -14)).toBe(true);
    expect(isAlreadyNormalized(at(-14 - LOUDNESS_TOLERANCE_LU), -14)).toBe(true);
  });

  it('normalizes a file outside tolerance', () => {
    expect(isAlreadyNormalized(at(-17.2), -14)).toBe(false);
    expect(isAlreadyNormalized(at(-11.5), -14)).toBe(false);
  });

  it('normalizes the files the gain bug buried', () => {
    expect(isAlreadyNormalized(at(-30.2), -14)).toBe(false);
    expect(isAlreadyNormalized(at(-70), -14)).toBe(false);
  });

  it('converges: a real post-normalization measurement skips', () => {
    // Measured from an actual two-pass run. The +0.37 dBTP is AAC overshoot
    // past loudnorm's -1.0 ceiling, and must not force another encode.
    expect(isAlreadyNormalized(at(-14.38, 0.37), -14)).toBe(true);
  });

  it('follows the target the user picked', () => {
    expect(isAlreadyNormalized(at(-14), -9)).toBe(false);
    expect(isAlreadyNormalized(at(-9.2), -9)).toBe(true);
  });
});
