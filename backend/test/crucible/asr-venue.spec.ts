/**
 * The transcriber and where it runs (P5, and since P7 the only transcriber):
 * Qwen3-ASR-1.7B on the selected server, its params, and the venue rule. When
 * the server can't take it the answer is `none` with the reason, and the task
 * parks on it: there is no other model and no offline transcriber.
 */
import type { ServerInfo } from '@crucible/client';
import { asrOfferOf, qwenAsrModelFor, qwenAsrParams, qwenUnavailable, type AsrOffer } from '../../src/crucible/asr/asr-models';
import { decideTranscriptionRoute, type TranscriptionVenueHost } from '../../src/crucible/asr/transcription-venue';
import type { ServerReach } from '../../src/crucible/wire/settings-wire';

/** `/v1/info` of a 1.0.29+ server: the asr lineup, and the aligner under `align` when that job type is installed. */
function info(opts: { installed?: string[]; jobTypes?: string[]; asrIds?: string[] } = {}): ServerInfo {
  const installed = opts.installed ?? [];
  const jobTypes = opts.jobTypes ?? ['asr', 'align'];
  const row = (id: string) => ({ id, revision: '', source: '', installed: installed.includes(id), resident: false, vramBytes: 0 });
  const capabilities = [
    ...(jobTypes.includes('asr') ? [{ jobType: 'asr', models: (opts.asrIds ?? ['qwen3-asr-1.7b', 'qwen3-asr-0.6b', 'qwen3-asr-0.6b-mlx', 'whisper-large-v3-turbo', 'whisper-tiny']).map(row) }] : []),
    ...(jobTypes.includes('align') ? [{ jobType: 'align', models: [row('qwen3-aligner')] }] : []),
  ];
  return {
    server: { name: 'crucible@x', version: '1.0.29', apiVersion: 1 },
    host: { platform: 'x', arch: 'y', backend: 'mlx-darwin', gpu: { vendor: 'v', name: 'n', vramBytes: 1 } },
    jobTypes,
    capabilities,
  } as unknown as ServerInfo;
}

const READY = ['qwen3-asr-0.6b-mlx', 'qwen3-aligner'];

describe('the transcriber: Qwen3-ASR-1.7B, and nothing else', () => {
  it('the fastest 0.6B on each machine: the MLX port on a Mac, the one id elsewhere', () => {
    expect(qwenAsrModelFor('mlx-darwin')).toBe('qwen3-asr-0.6b-mlx');
    expect(qwenAsrModelFor('cuda-linux')).toBe('qwen3-asr-0.6b');
    expect(qwenAsrModelFor(null)).toBe('qwen3-asr-0.6b');
  });

  it('reads that model and its aligner off /v1/info', () => {
    expect(asrOfferOf(info({ installed: READY }))).toEqual({
      backend: 'mlx-darwin', offersAsr: true, model: 'qwen3-asr-0.6b-mlx',
      qwen: { offered: true, installed: true }, aligner: { offered: true, installed: true },
    });
  });

  it('every reason a server can\'t transcribe with it, by name; whisper installed does not count', () => {
    const why = (offer: AsrOffer) => qwenUnavailable('mac', offer);
    expect(why(asrOfferOf(info({ installed: READY })))).toBeNull();
    expect(why(asrOfferOf(info({ jobTypes: ['echo'] })))).toBe('Crucible on mac has no transcription engine.');
    // A pre-1.0.29 server lists backend-prefixed whisper ids and no Qwen.
    expect(why(asrOfferOf(info({ asrIds: ['mlx-whisper-large-v3'], installed: ['mlx-whisper-large-v3'] }))))
      .toBe('Crucible on mac does not offer qwen3-asr-0.6b-mlx. Update it to Crucible 1.0.32 or later.');
    expect(why(asrOfferOf(info({ installed: ['qwen3-asr-1.7b', 'whisper-large-v3-turbo', 'qwen3-aligner'] }))))
      .toBe('Crucible on mac has not downloaded qwen3-asr-0.6b-mlx yet.');
    expect(why(asrOfferOf(info({ jobTypes: ['asr'], installed: ['qwen3-asr-0.6b-mlx'] }))))
      .toBe("Crucible on mac does not offer qwen3-aligner, which Qwen's word timings need.");
    expect(why(asrOfferOf(info({ installed: ['qwen3-asr-0.6b-mlx'] }))))
      .toBe("Crucible on mac has not downloaded qwen3-aligner (Qwen's word timings) yet.");
  });

  it('params: a stated language (English when none is), no VAD, words; a language Qwen does not take is refused', () => {
    for (const unstated of [undefined, null, '', 'auto', 'und', ' UNKNOWN ']) {
      expect(qwenAsrParams(unstated)).toEqual({ language: 'en', vad_filter: false, word_timestamps: true });
    }
    expect(qwenAsrParams(' DE ')).toEqual({ language: 'de', vad_filter: false, word_timestamps: true });
    expect(() => qwenAsrParams('nl')).toThrow(/"nl" is not one of them/);
  });
});

/** A scripted host: the selected server (or routing's refusal), with its reach and offer. */
function host(opts: {
  selected?: { name: string; reach?: ServerReach; offer?: AsrOffer | Error } | string;
}): TranscriptionVenueHost & { asked: string[] } {
  const asked: string[] = [];
  const selected = opts.selected ?? 'No Crucible server is connected. Add one in Settings › Crucible Servers.';
  return {
    asked,
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
      return offer ?? asrOfferOf(info({ installed: READY }));
    },
  };
}

describe('the venue rule', () => {
  it('Qwen on the selected server when it has Qwen and the aligner', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac' } })))
      .toEqual({ kind: 'crucible', server: 'mac', model: 'qwen3-asr-0.6b-mlx' });
  });

  it('no server selected: none, in routing’s words (the task parks; nothing else transcribes)', async () => {
    expect(await decideTranscriptionRoute(host({}))).toEqual({
      kind: 'none',
      reason: 'No Crucible server is connected. Add one in Settings › Crucible Servers. Transcription runs on Crucible.',
    });
  });

  it('the selected server not answering is none, naming it: never another server', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac', reach: 'unreachable' } })))
      .toEqual({ kind: 'none', reason: "Crucible on mac isn't answering." });
  });

  it('a busy server is still the venue (the submit decides, and a 409 parks)', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac', reach: 'busy' } }))).toMatchObject({ kind: 'crucible', server: 'mac' });
  });

  it('Qwen not downloaded is none with that reason, even with a whisper installed: never another model', async () => {
    const offer = asrOfferOf(info({ installed: ['qwen3-asr-1.7b', 'whisper-large-v3-turbo', 'qwen3-aligner'] }));
    expect(await decideTranscriptionRoute(host({ selected: { name: 'mac', offer } })))
      .toEqual({ kind: 'none', reason: 'Crucible on mac has not downloaded qwen3-asr-0.6b-mlx yet.' });
  });

  it('a server that can\'t say what it offers is none, with why', async () => {
    expect(await decideTranscriptionRoute(host({ selected: { name: 'old', offer: new Error('HTTP 500') } })))
      .toEqual({ kind: 'none', reason: "Crucible on old couldn't say what it offers (HTTP 500)." });
  });
});
