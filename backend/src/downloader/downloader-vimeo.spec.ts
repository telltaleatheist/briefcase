// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { DownloaderService } from './downloader.service';

/**
 * The Vimeo access-error fallback. Vimeo revoked the private OAuth client
 * yt-dlp's "macos" extractor used (Sep 2026), so the yt-dlp we ship fails every
 * vimeo.com/ID link with a 401 that the old matcher did not recognise — the
 * embed fallback (which still works) never ran. These tests pin the matcher
 * against the real stderr shapes and the direct-URL handling in the embed
 * extractor. The private methods are pure (or take a stubbed `this`), so they
 * are exercised via the prototype without constructing the service.
 */

const proto = DownloaderService.prototype as any;

const parseDirectVimeoUrl = (url: string) => proto.parseDirectVimeoUrl.call(null, url);
const isVimeoAccessError = (msg: string, url: string) => proto.isVimeoAccessError.call(null, msg, url);

function extractVimeoEmbedUrl(pageUrl: string, fetchPageContent: (url: string) => Promise<string>) {
  const self = {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    fetchPageContent,
    parseDirectVimeoUrl: proto.parseDirectVimeoUrl,
  };
  return proto.extractVimeoEmbedUrl.call(self, pageUrl) as Promise<{ playerUrl: string; referer: string } | null>;
}

const VIDEO_ID = '1223128467';
const PAGE_URL = `https://vimeo.com/${VIDEO_ID}?fl=pl&fe=cm`;

describe('parseDirectVimeoUrl', () => {
  it('recognises direct video page URLs, ignoring share query params', () => {
    expect(parseDirectVimeoUrl(PAGE_URL)).toEqual({ id: VIDEO_ID });
    expect(parseDirectVimeoUrl(`https://vimeo.com/${VIDEO_ID}`)).toEqual({ id: VIDEO_ID });
    expect(parseDirectVimeoUrl(`https://www.vimeo.com/video/${VIDEO_ID}`)).toEqual({ id: VIDEO_ID });
  });

  it('carries the unlisted hash from the path or the h= parameter', () => {
    expect(parseDirectVimeoUrl('https://vimeo.com/123456/abcdef1234')).toEqual({ id: '123456', hash: 'abcdef1234' });
    expect(parseDirectVimeoUrl('https://vimeo.com/123456?h=deadbeef')).toEqual({ id: '123456', hash: 'deadbeef' });
  });

  it('returns null for player embeds, channels, showcases and non-Vimeo pages', () => {
    expect(parseDirectVimeoUrl(`https://player.vimeo.com/video/${VIDEO_ID}`)).toBeNull();
    expect(parseDirectVimeoUrl('https://vimeo.com/channels/staffpicks/123')).toBeNull();
    expect(parseDirectVimeoUrl('https://vimeo.com/showcase/123')).toBeNull();
    expect(parseDirectVimeoUrl('https://example.com/page')).toBeNull();
  });
});

describe('isVimeoAccessError', () => {
  const vimeoUrl = `https://vimeo.com/${VIDEO_ID}`;

  it('matches the 401 the old "macos" client now gets (ERROR line and verbose traceback tail)', () => {
    expect(isVimeoAccessError(
      `ERROR: [vimeo] ${VIDEO_ID}: Unable to download macos API JSON: HTTP Error 401: Unauthorized (caused by <HTTPError 401: Unauthorized>)`,
      vimeoUrl,
    )).toBe(true);
    expect(isVimeoAccessError(
      `ERROR: [vimeo] ${VIDEO_ID}: Failed to fetch macos OAuth token: HTTP Error 401: Unauthorized`,
      vimeoUrl,
    )).toBe(true);
    // With --verbose the 500-char stderr tail is the Python traceback.
    expect(isVimeoAccessError(
      '  File "yt_dlp/networking/_curlcffi.py", line 326, in _send\nyt_dlp.networking.exceptions.HTTPError: HTTP Error 401: Unauthorized',
      vimeoUrl,
    )).toBe(true);
  });

  it('still matches the errors the old matcher covered', () => {
    expect(isVimeoAccessError('ERROR: [vimeo] 1: The web client only works when logged-in. Use --cookies', vimeoUrl)).toBe(true);
    expect(isVimeoAccessError('ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden', 'https://example.com/embed-page')).toBe(true);
    expect(isVimeoAccessError('ERROR: [vimeo] 1: Requested format is not available', 'https://example.com/page')).toBe(true);
  });

  it('does not fire on 401s from other sites', () => {
    expect(isVimeoAccessError('ERROR: [youtube] x: HTTP Error 401: Unauthorized', 'https://youtube.com/watch?v=x')).toBe(false);
    expect(isVimeoAccessError('ERROR: [generic] Unsupported URL', vimeoUrl)).toBe(false);
  });
});

describe('extractVimeoEmbedUrl', () => {
  it('scrapes the h= player URL for the requested ID, not a related video listed earlier', async () => {
    const page = `
      <a href="https://vimeo.com/99999">related</a>
      <link rel="alternate" href="https://player.vimeo.com/video/99999?h=0000000000">
      <meta property="og:video:url" content="https://player.vimeo.com/video/${VIDEO_ID}?h=e33a9255bc">
    `;
    const result = await extractVimeoEmbedUrl(PAGE_URL, async () => page);
    expect(result).toEqual({
      playerUrl: `https://player.vimeo.com/video/${VIDEO_ID}?h=e33a9255bc`,
      referer: PAGE_URL,
    });
  });

  it('synthesises the player URL for a direct link when the page fetch fails', async () => {
    const result = await extractVimeoEmbedUrl(PAGE_URL, async () => { throw new Error('ECONNRESET'); });
    expect(result).toEqual({ playerUrl: `https://player.vimeo.com/video/${VIDEO_ID}`, referer: PAGE_URL });
  });

  it('keeps the unlisted hash when synthesising', async () => {
    const url = 'https://vimeo.com/123456/abcdef1234';
    const result = await extractVimeoEmbedUrl(url, async () => '<html>nothing useful</html>');
    expect(result).toEqual({ playerUrl: 'https://player.vimeo.com/video/123456?h=abcdef1234', referer: url });
  });

  it('still finds a player iframe on a non-Vimeo page, and returns null when there is none', async () => {
    const host = 'https://example.com/article';
    const withIframe = `<iframe src="https://player.vimeo.com/video/555?h=abc123&amp;dnt=1"></iframe>`;
    expect(await extractVimeoEmbedUrl(host, async () => withIframe)).toEqual({
      playerUrl: 'https://player.vimeo.com/video/555?h=abc123&dnt=1',
      referer: host,
    });
    expect(await extractVimeoEmbedUrl(host, async () => '<html>no video</html>')).toBeNull();
    expect(await extractVimeoEmbedUrl(host, async () => { throw new Error('boom'); })).toBeNull();
  });
});
