/**
 * Which asr model, and where a transcription runs (P5, and since P7 the only
 * transcriber): the model ladder per backend, the vad rule, and the venue rule.
 * When no server can take it the answer is `none` with every reason, and the
 * task parks on it: there is no offline transcriber to fall back to.
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
  it('absent reads as the defaults; written temp-then-rename keeping every other key; junk is reported and ignored', () => {
    const dir = tempDir();
    expect(readTranscriptionSetting(dir)).toEqual({ setting: DEFAULT_TRANSCRIPTION_SETTING, explicit: false });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ outputDir: '/x' }));
    writeTranscriptionSetting(dir, { model: 'mlx-whisper-large-v3' });
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'app-config.json'), 'utf8'));
    expect(config).toMatchObject({ outputDir: '/x', transcription: { model: 'mlx-whisper-large-v3' } });
    expect(config.transcription.venue).toBeUndefined();
    expect(config.transcription.server).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ transcription: { model: 3 } }));
    expect(readTranscriptionSetting(dir)).toMatchObject({ setting: { model: null }, ignored: expect.stringMatching(/model=3/) });
  });

  it('a pre-P7 venue and a server chosen before selection are not read; "whisper-cli" is reported, since that transcriber is gone', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ transcription: { venue: 'whisper-cli', server: 'mac', model: null } }));
    const read = readTranscriptionSetting(dir);
    expect(read.setting).toEqual({ model: null });
    expect(read.ignored).toMatch(/whisper-cli.*removed/);
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ transcription: { venue: 'auto', server: null, model: null } }));
    expect(readTranscriptionSetting(dir).ignored).toBeUndefined();
  });

  it('the pane’s input is validated strictly', () => {
    expect(parseTranscriptionSettingInput({ model: '' })).toEqual({ model: null });
    expect(() => parseTranscriptionSettingInput({ model: 4 })).toThrow(/model is/);
    expect(() => parseTranscriptionSettingInput('crucible')).toThrow(/\{model\}/);
  });
});

/** A scripted host: the selected server (or routing's refusal), with its reach and offer. */
function host(opts: {
  setting?: Partial<TranscriptionSetting>;
  selected?: { name: string; reach?: ServerReach; offer?: AsrOffer | Error } | string;
}): TranscriptionVenueHost & { asked: string[] } {
  const asked: string[] = [];
  const selected = opts.selected ?? 'No Crucible server is connected. Add one in Settings › Crucible Servers.';
  return {
    asked,
    setting: () => ({ ...DEFAULT_TRANSCRIPTION_SETTING, ...opts.setting }),
    selected: () => {
      if (typeof selected === 'string') throw new Error(selected);
      return selected.name;
    },
    reach: async (name) => {
      asked.push(name);
      return { reach: typeof selected === 'string' ? 'unreachable' : selected.reach ?? 'ready' };
    },
    asrOffer: async () => {
      const offer = typeof selected === 'string' ? undefined : selected.offer;
      if (offer instanceof Error) throw offer;
      return offer ?? asrOfferOf(info('mlx-darwin', ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo']));
    },
  };
}

const MAC_OFFER = asrOfferOf(info('mlx-darwin', ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo']));
const PC_OFFER = asrOfferOf(info('cuda-linux', ['faster-whisper-large-v3']));
const NO_ASR = asrOfferOf(info('mlx-darwin', [], ['echo', 'llm']));

describe('the venue rule', () => {
  it('Crucible on the selected server when it offers asr, with its most accurate installed model', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac', offer: MAC_OFFER } })))
      .toEqual({ kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3' });
  });

  it('no server selected: none, in routing’s words (the task parks; nothing else transcribes)', async () => {
    expect(await decideTranscriptionRoute(host({}))).toEqual({
      kind: 'none',
      reason: 'No Crucible server is connected. Add one in Settings › Crucible Servers. Transcription runs on Crucible.',
    });
  });

  it('the selected server not answering is none, naming it: never another server', async () => {
    const route = await decideTranscriptionRoute(host({ selected: { name: 'mac', reach: 'unreachable' } }));
    expect(route).toEqual({ kind: 'none', reason: "Crucible on mac isn't answering." });
  });

  it('a busy server is still the venue (the submit decides, and a 409 parks)', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac', reach: 'busy', offer: MAC_OFFER } }))).toMatchObject({ kind: 'crucible', server: 'mac' });
  });

  it('each reason the selected server can’t take it, by name', async () => {
    const reason = async (selected: { name: string; offer: AsrOffer | Error }) =>
      (await decideTranscriptionRoute(host({ selected })) as { reason: string }).reason;
    expect(await reason({ name: 'pc', offer: NO_ASR })).toBe('Crucible on pc has no transcription engine.');
    expect(await reason({ name: 'lab', offer: asrOfferOf(info('mlx-darwin', [])) }))
      .toBe('Crucible on lab has no transcription model downloaded (mlx-whisper-large-v3 can be pulled).');
    expect(await reason({ name: 'old', offer: new Error('HTTP 500') })).toBe("Crucible on old couldn't say what it offers (HTTP 500).");
  });

  it('the setting’s model is used where the server has it installed; otherwise its own best', async () => {
    const setting = { model: 'mlx-whisper-large-v3-turbo' };
    expect(await decideTranscriptionRoute(host({ setting, selected: { name: 'mac', offer: MAC_OFFER } })))
      .toMatchObject({ server: 'mac', model: 'mlx-whisper-large-v3-turbo' });
    expect(await decideTranscriptionRoute(host({ setting, selected: { name: 'pc', offer: PC_OFFER } })))
      .toMatchObject({ server: 'pc', model: 'faster-whisper-large-v3' });
  });
});
