import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigController } from './config.controller';

/**
 * "How flags are found" (Settings › AI Analysis): stored as `flagFinder` in
 * app-config.json beside the other settings, generate by default.
 */
describe('config: how flags are found', () => {
  const savedEnv = { ...process.env };
  let tmp: string;
  const configFile = () => path.join(tmp, 'briefcase', 'app-config.json');
  const controller = () => new ConfigController({} as never);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-finder-spec-'));
    process.env.APPDATA = tmp;
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it('reads generate when nothing is stored', async () => {
    await expect(controller().getFlagFinder()).resolves.toEqual({ success: true, finder: 'generate', default: 'generate' });
  });

  it('stores the choice in app-config.json, keeping the other settings, and reads it back', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ analysisWindows: { mode: 'sentence' } }));
    await expect(controller().saveFlagFinder({ finder: 'snap' })).resolves.toEqual({ success: true, finder: 'snap' });
    const stored = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(stored.flagFinder).toBe('snap');
    expect(stored.analysisWindows).toEqual({ mode: 'sentence' });
    await expect(controller().getFlagFinder()).resolves.toMatchObject({ finder: 'snap' });
    await controller().saveFlagFinder({ finder: 'generate' });
    await expect(controller().getFlagFinder()).resolves.toMatchObject({ finder: 'generate' });
  });

  it('refuses anything else by name, and stores nothing', async () => {
    const err = await controller().saveFlagFinder({ finder: 'decide' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(configFile())).toBe(false);
  });
});
