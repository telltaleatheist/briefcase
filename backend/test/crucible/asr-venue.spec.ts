/**
 * Which asr model, and where a transcription runs (P5): the model ladder per
 * backend, the vad rule, and the venue rule's defaults and fallbacks.
 */
import type { ServerInfo } from '@crucible/client';
import { asrOfferOf, chooseAsrModel, crucibleAsrLanguage, vadFilterFor, type AsrOffer } from '../../src/crucible/asr/asr-models';
import { DEFAULT_TRANSCRIPTION_SETTING, readTranscriptionSetting, writeTranscriptionSetting, parseTranscriptionSettingInput, type TranscriptionSetting } from '../../src/crucible/asr/transcription-setting';
import { decideTranscriptionRoute, type TranscriptionVenueHost } from '../../src/crucible/asr/transcription-venue';
import type { ServerReach } from '../../src/crucible/wire/settings-wire';
import { tempDir } from './helpers';
import * as fs from 'fs';
import * as path from 'path';

/** `/v1/info` as the SDK returns it, with asr rows for both engines, as a live mlx-darwin server lists them. */
function info(backend: string, installed: string[], jobTypes = ['asr', 'echo']): ServerInfo {
  const rows = ['faster-whisper', 'mlx-whisper'].flatMap((engine) =>
    ['base', 'distil-large-v3', 'large-v3', 'large-v3-turbo', 'medium', 'small', 'tiny'].map((size) => {
      const id = `${engine}-${size}`;
      return { id, revision: '', source: '', installed: installed.includes(id), resident: false, vramBytes: 0 };
    }));
  return {
    server: { name: 'crucible@x', version: '1.0.23', apiVersion: 1 },
    host: { platform: 'x', arch: 'y', backend, gpu: { vendor: 'v', name: 'n', vramBytes: 1 } },
    jobTypes,
    capabilities: jobTypes.includes('asr') ? [{ jobType: 'asr', models: rows }] : [],
  } as unknown as ServerInfo;
}

describe('the model ladder, per backend', () => {
  it('mlx-darwin with large-v3 and turbo pulled (the Mac today) → mlx-whisper-large-v3; faster-whisper rows are not offered', () => {
    const offer = asrOfferOf(info('mlx-darwin', ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo']));
    expect(offer.offersAsr).toBe(true);
    expect(offer.choice.recommended).toBe('mlx-whisper-large-v3');
    expect(offer.choice.models.every((m) => m.id.startsWith('mlx-whisper-'))).toBe(true);
    expect(offer.choice.models.map((m) => m.id).slice(0, 3)).toEqual(['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo', 'mlx-whisper-distil-large-v3']);
  });

  it('cuda-linux (the PC) → faster-whisper-large-v3', () => {
    expect(asrOfferOf(info('cuda-linux', ['faster-whisper-large-v3', 'faster-whisper-base'])).choice.recommended).toBe('faster-whisper-large-v3');
  });

  it('the best offered but not pulled is named for a pull; the best INSTALLED is recommended', () => {
    const choice = asrOfferOf(info('mlx-darwin', ['mlx-whisper-small'])).choice;
    expect(choice).toMatchObject({ recommended: 'mlx-whisper-small', betterNotInstalled: 'mlx-whisper-large-v3' });
  });

  it('nothing installed: no recommendation; no asr job type: not offered', () => {
    expect(asrOfferOf(info('mlx-darwin', [])).choice.recommended).toBeNull();
    expect(asrOfferOf(info('mlx-darwin', [], ['echo'])).offersAsr).toBe(false);
  });

  it('an id off the ladder is listed last and never chosen automatically', () => {
    const choice = chooseAsrModel([
      { id: 'mlx-whisper-large-v4', installed: true, resident: false },
      { id: 'mlx-whisper-small', installed: true, resident: false },
    ]);
    expect(choice.recommended).toBe('mlx-whisper-small');
    expect(choice.models.map((m) => [m.id, m.rank])).toEqual([['mlx-whisper-small', 4], ['mlx-whisper-large-v4', null]]);
  });

  it('vad_filter: false for mlx-whisper (the server refuses true), true for faster-whisper, refused for anything else', () => {
    expect(vadFilterFor('mlx-whisper-large-v3')).toBe(false);
    expect(vadFilterFor('faster-whisper-large-v3')).toBe(true);
    expect(() => vadFilterFor('whisper-large-v3')).toThrow(/neither/);
  });

  it('language: auto unless a real code is given', () => {
    expect(crucibleAsrLanguage(undefined)).toBe('auto');
    expect(crucibleAsrLanguage('und')).toBe('auto');
    expect(crucibleAsrLanguage(' EN ')).toBe('en');
  });
});

describe('the setting file', () => {
  it('absent reads as auto; written temp-then-rename keeping every other key; junk is reported and ignored', () => {
    const dir = tempDir();
    expect(readTranscriptionSetting(dir)).toEqual({ setting: DEFAULT_TRANSCRIPTION_SETTING, explicit: false });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ aiVia: 'crucible', outputDir: '/x' }));
    writeTranscriptionSetting(dir, { venue: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3' });
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'app-config.json'), 'utf8'));
    expect(config).toMatchObject({ aiVia: 'crucible', outputDir: '/x', transcription: { venue: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3' } });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ transcription: { venue: 'gpu', server: 3 } }));
    expect(readTranscriptionSetting(dir)).toMatchObject({ setting: { venue: 'auto', server: null }, ignored: expect.stringMatching(/venue="gpu".*server=3/) });
  });

  it('the pane’s input is validated strictly', () => {
    expect(parseTranscriptionSettingInput({ venue: 'whisper-cli', server: '', model: null })).toEqual({ venue: 'whisper-cli', server: null, model: null });
    expect(() => parseTranscriptionSettingInput({ venue: 'gpu' })).toThrow(/venue is/);
    expect(() => parseTranscriptionSettingInput({ venue: 'auto', server: 4 })).toThrow(/server is/);
  });
});

/** A scripted host: servers by name with their reach and offer. */
function host(opts: {
  setting?: Partial<TranscriptionSetting>;
  via?: 'crucible' | 'direct';
  servers?: Array<{ name: string; enabled?: boolean; reach?: ServerReach; offer?: AsrOffer | Error }>;
}): TranscriptionVenueHost & { asked: string[] } {
  const asked: string[] = [];
  const servers = opts.servers ?? [];
  return {
    asked,
    setting: () => ({ ...DEFAULT_TRANSCRIPTION_SETTING, ...opts.setting }),
    aiVia: () => opts.via ?? 'crucible',
    registered: () => servers.map((s) => ({ name: s.name, enabled: s.enabled ?? true })),
    reach: async (name) => {
      asked.push(name);
      return { reach: servers.find((s) => s.name === name)?.reach ?? 'ready' };
    },
    asrOffer: async (name) => {
      const offer = servers.find((s) => s.name === name)?.offer;
      if (offer instanceof Error) throw offer;
      return offer ?? asrOfferOf(info('mlx-darwin', ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo']));
    },
  };
}

const MAC_OFFER = asrOfferOf(info('mlx-darwin', ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo']));
const PC_OFFER = asrOfferOf(info('cuda-linux', ['faster-whisper-large-v3']));
const NO_ASR = asrOfferOf(info('mlx-darwin', [], ['echo', 'llm']));

describe('the venue rule', () => {
  it('default: Crucible when a server is connected and offers asr, with its most accurate installed model', async () => {
    expect(await decideTranscriptionRoute({}, host({ servers: [{ name: 'mac', offer: MAC_OFFER }] })))
      .toEqual({ kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3' });
  });

  it('default with no server at all: whisper-cli, with no warning (nothing was expected)', async () => {
    expect(await decideTranscriptionRoute({}, host({}))).toEqual({ kind: 'cli', reason: 'No Crucible server is connected.', warning: null });
  });

  it('venue "crucible" with no server: whisper-cli WITH a warning', async () => {
    const route = await decideTranscriptionRoute({}, host({ setting: { venue: 'crucible' } }));
    expect(route).toMatchObject({ kind: 'cli', warning: expect.stringMatching(/offline transcriber.*no Crucible server/) });
  });

  it('translate always goes to whisper-cli, by name, without asking any server', async () => {
    const h = host({ servers: [{ name: 'mac', offer: MAC_OFFER }] });
    expect(await decideTranscriptionRoute({ translate: true }, h)).toMatchObject({ kind: 'cli', warning: null, reason: expect.stringMatching(/Translat/) });
    expect(h.asked).toEqual([]);
  });

  it('venue "whisper-cli" is whisper-cli; "auto" under aiVia direct is whisper-cli; "crucible" under direct is Crucible', async () => {
    const servers = [{ name: 'mac', offer: MAC_OFFER }];
    expect(await decideTranscriptionRoute({}, host({ setting: { venue: 'whisper-cli' }, servers }))).toMatchObject({ kind: 'cli', warning: null });
    expect(await decideTranscriptionRoute({}, host({ via: 'direct', servers }))).toMatchObject({ kind: 'cli', warning: null });
    expect(await decideTranscriptionRoute({}, host({ via: 'direct', setting: { venue: 'crucible' }, servers }))).toMatchObject({ kind: 'crucible', server: 'mac' });
  });

  it('the first server that answers AND offers asr, best first: an unreachable Mac goes to the PC with its own engine’s model', async () => {
    const route = await decideTranscriptionRoute({}, host({ servers: [{ name: 'mac', reach: 'unreachable' }, { name: 'pc', offer: PC_OFFER }] }));
    expect(route).toEqual({ kind: 'crucible', server: 'pc', model: 'faster-whisper-large-v3' });
  });

  it('a busy server is still the venue (the submit decides, and a 409 parks)', async () => {
    expect(await decideTranscriptionRoute({}, host({ servers: [{ name: 'mac', reach: 'busy', offer: MAC_OFFER }] }))).toMatchObject({ kind: 'crucible', server: 'mac' });
  });

  it('nothing can take it: whisper-cli with a warning naming every reason', async () => {
    const route = await decideTranscriptionRoute({}, host({ servers: [
      { name: 'mac', reach: 'unreachable' },
      { name: 'pc', offer: NO_ASR },
      { name: 'nas', enabled: false },
      { name: 'lab', offer: asrOfferOf(info('mlx-darwin', [])) },
      { name: 'old', offer: new Error('HTTP 500') },
    ] }));
    expect(route.kind).toBe('cli');
    const warning = (route as { warning: string }).warning;
    expect(warning).toMatch(/^Transcribed with the offline transcriber \(whisper\) because /);
    expect(warning).toMatch(/Crucible on mac isn't answering/);
    expect(warning).toMatch(/Crucible on pc has no transcription engine/);
    expect(warning).toMatch(/nas is paused/);
    expect(warning).toMatch(/lab has no transcription model downloaded \(mlx-whisper-large-v3 can be pulled\)/);
    expect(warning).toMatch(/old couldn't say what it offers \(HTTP 500\)/);
  });

  it('a named server is the only candidate; one that is gone falls back with a warning', async () => {
    const servers = [{ name: 'mac', offer: MAC_OFFER }, { name: 'pc', offer: PC_OFFER }];
    expect(await decideTranscriptionRoute({}, host({ setting: { server: 'pc' }, servers }))).toMatchObject({ kind: 'crucible', server: 'pc' });
    expect(await decideTranscriptionRoute({}, host({ setting: { server: 'gone' }, servers }))).toMatchObject({ kind: 'cli', warning: expect.stringMatching(/"gone"/) });
  });

  it('the setting’s model is used where that server has it installed; elsewhere its own best', async () => {
    const setting = { model: 'mlx-whisper-large-v3-turbo' };
    expect(await decideTranscriptionRoute({}, host({ setting, servers: [{ name: 'mac', offer: MAC_OFFER }] })))
      .toMatchObject({ server: 'mac', model: 'mlx-whisper-large-v3-turbo' });
    expect(await decideTranscriptionRoute({}, host({ setting, servers: [{ name: 'pc', offer: PC_OFFER }] })))
      .toMatchObject({ server: 'pc', model: 'faster-whisper-large-v3' });
  });
});
