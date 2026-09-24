/**
 * A SOCKET THAT DIED MID-ANSWER IS A WAIT, NOT A FAILURE.
 *
 * Ported from BookForge's electron/crucible/transport-failure.ts. The SDK maps
 * a connection it never got onto `CrucibleUnreachable`. What it does NOT map is
 * a socket destroyed AFTER the response started: undici surfaces that as a
 * bare `TypeError: terminated` (and a connect that failed inside `fetch` as
 * `TypeError: fetch failed` with the errno on `cause.code`). Those must be
 * classified the same way, or a server that is rebooting reads as a broken one.
 *
 * DELIBERATELY NARROW. A `TypeError` is also what `x is not a function`
 * throws, and parking work on a programming mistake is work that waits for
 * ever with nobody told. So a `TypeError` qualifies only on undici's two exact
 * messages, and anything else only by carrying a real transport errno.
 */
import { CrucibleServerError, CrucibleUnreachable } from '@crucible/client';

/** The errnos that mean "the wire, not the work", including undici's own three clocks. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** undici's own words for a transport death. */
const UNDICI_MESSAGES: ReadonlySet<string> = new Set(['terminated', 'fetch failed']);

interface MaybeCause {
  readonly message?: unknown;
  readonly code?: unknown;
}

function causeOf(err: unknown): MaybeCause | null {
  if (typeof err !== 'object' || err === null) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  return cause as MaybeCause;
}

/**
 * The wire's own words for why it died (`terminated (ECONNRESET)`), or null
 * when this was not the wire. Never a category invented here.
 */
export function transportFailureCause(err: unknown): string | null {
  // Duck-typed, not `instanceof Error`: undici's errors come from Node's own
  // realm, which is not the realm a Jest sandbox (or a vm context) calls Error.
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { name?: unknown; message?: unknown };
  if (typeof e.name !== 'string' || typeof e.message !== 'string') return null;
  const cause = causeOf(err);
  const code = typeof cause?.code === 'string' ? cause.code : null;
  const codeIsTransport = code !== null && TRANSPORT_CODES.has(code);
  const messageIsUndici = e.name === 'TypeError' && UNDICI_MESSAGES.has(e.message);
  if (!codeIsTransport && !messageIsUndici) return null;
  const detail = code ?? (typeof cause?.message === 'string' && cause.message !== '' ? cause.message : null);
  return detail === null || detail === e.message ? e.message : `${e.message} (${detail})`;
}

export function isTransportFailure(err: unknown): boolean {
  return transportFailureCause(err) !== null;
}

/**
 * "Not now", in the server's own words: an unreachable server, a 5xx, or a
 * socket that died mid-answer. The whole membership test for "wait, don't
 * fail", for a caller holding a raw error.
 */
export function crucibleUnavailableCause(err: unknown): string | null {
  if (err instanceof CrucibleUnreachable) return err.message;
  if (err instanceof CrucibleServerError) return `HTTP ${err.status}: ${err.serverMessage}`;
  return transportFailureCause(err);
}
