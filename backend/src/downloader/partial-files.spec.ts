// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isPartialFileOf,
  removePartialFiles,
  stemOfDestination,
  stemOfOutputTemplate,
  stemsFromYtDlpOutput,
} from './partial-files';

const STEM = '2026-11-04 Alex Jones Live';

describe('isPartialFileOf', () => {
  it.each([
    `${STEM}.mp4.part`,
    `${STEM}.mp4.ytdl`,
    `${STEM}.mp4.part-Frag12`,
    `${STEM}.mp4.part-Frag12.part`,
    `${STEM}.f137.mp4`,
    `${STEM}.f137.mp4.part`,
    `${STEM}.fhls-2138.mp4.part-Frag3`,
    `${STEM}.temp.mp4`,
    `${STEM}.webm.part`,
  ])('matches the working file %s', (name) => {
    expect(isPartialFileOf(name, STEM)).toBe(true);
  });

  it.each([
    [`${STEM}.mp4`, 'the finished video'],
    [`${STEM} (2).mp4.part`, 'a second download of the same title'],
    [`${STEM} Part 2.mp4.part`, 'a different title that starts the same'],
    [`${STEM}.fun.mp4.part`, 'a title whose next word starts with f'],
    [`${STEM}.jpg`, 'a thumbnail'],
    [`Other ${STEM}.mp4.part`, 'a title that contains this one'],
  ])('leaves %s alone (%s)', (name) => {
    expect(isPartialFileOf(name, STEM)).toBe(false);
  });

  it('matches nothing for an empty stem', () => {
    expect(isPartialFileOf('.mp4.part', '')).toBe(false);
  });
});

describe('stems', () => {
  it('reads the stem off a template that names its file', () => {
    expect(stemOfOutputTemplate(`/clips/2026-11-01/${STEM}.%(ext)s`)).toBe(`/clips/2026-11-01/${STEM}`);
  });

  it('has none for a template yt-dlp fills in from the title', () => {
    expect(stemOfOutputTemplate('/clips/2026-11-01/%(upload_date>%Y-%m-%d )s%(title.200)s.%(ext)s')).toBeNull();
  });

  it('drops the extension and a format id from a destination', () => {
    expect(stemOfDestination('/clips/Title.f137.mp4')).toBe('/clips/Title');
    expect(stemOfDestination('/clips/Title.mp4')).toBe('/clips/Title');
  });

  it('collects every destination and merge target from a yt-dlp log', () => {
    const log = [
      '[info] abc: Downloading 1 format(s): 137+140',
      '[download] Destination: /clips/Some Title.f137.mp4',
      '[download] 100% of 10.00MiB',
      '[download] Destination: /clips/Some Title.f140.m4a',
      '[Merger] Merging formats into "/clips/Some Title.mp4"',
    ].join('\n');
    expect(stemsFromYtDlpOutput(log)).toEqual(['/clips/Some Title']);
  });
});

describe('removePartialFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'partial-files-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("removes this download's working files and keeps its neighbours", async () => {
    const mine = [`${STEM}.mp4.part`, `${STEM}.mp4.part-Frag7`, `${STEM}.mp4.part-Frag8.part`, `${STEM}.mp4.ytdl`];
    const others = [`${STEM}.mp4`, `${STEM} (2).mp4.part`, `${STEM} Part 2.mp4`, 'Unrelated.mp4.part'];
    for (const name of [...mine, ...others]) {
      await fs.promises.writeFile(path.join(dir, name), 'x');
    }

    const errors: string[] = [];
    const removed = await removePartialFiles([path.join(dir, STEM)], (p) => errors.push(p));

    expect(removed.map((p) => path.basename(p)).sort()).toEqual([...mine].sort());
    expect((await fs.promises.readdir(dir)).sort()).toEqual([...others].sort());
    expect(errors).toEqual([]);
  });

  it('is a no-op for a folder that is gone', async () => {
    const removed = await removePartialFiles([path.join(dir, 'missing', STEM)], () => {});
    expect(removed).toEqual([]);
  });
});
