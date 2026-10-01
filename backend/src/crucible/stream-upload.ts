/**
 * `POST /v1/uploads`, streamed from disk with node:http.
 *
 * WHY NOT THE SDK'S `upload()`. It sends a FormData through fetch, and fetch
 * (undici, the Node 20 in Electron 33) keeps every byte it sends in memory:
 * measured 2026-09-27 on a 6.9 GB four-hour video against a local server that
 * discarded the body, the upload STOPPED at 2.63 GB with 2.74 GB resident, from
 * `fs.openAsBlob`, from a plain file stream and from a counting wrapper alike
 * (the transcription sat at 4% until cancelled). The same file through
 * node:http piped from `fs.createReadStream` went in 1.6 s at 0.12 GB
 * resident. So the video is written to the socket in 1 MiB pieces as the
 * socket takes them, and never held.
 *
 * The body is one multipart part named `file` (the server's parameter), with
 * the file's name, exactly what the SDK's FormData sends. Errors are the SDK's
 * own types, so callers classify them as they would the SDK's.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';
import {
  API_VERSION,
  CrucibleAuthError,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';

export interface StreamUploadResult {
  readonly blobId: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface StreamUploadRequest {
  /** The engine's base URL (no trailing path). */
  readonly url: string;
  readonly token: string;
  readonly clientName: string;
  readonly file: string;
  /** The name the server stores it under (its extension is what ffmpeg reads). */
  readonly filename: string;
  readonly signal?: AbortSignal;
  /** Bytes read from disk into the socket so far (under backpressure: roughly bytes sent). */
  readonly onBytes?: (n: number) => void;
}

/** Read size of each piece of the file. */
const PIECE_BYTES = 1 << 20;

function quoted(name: string): string {
  return name.replace(/[\r\n"\\]/g, '_');
}

export function streamUpload(request: StreamUploadRequest): Promise<StreamUploadResult> {
  const { url, token, clientName, file, filename, signal, onBytes } = request;
  const target = new URL('/v1/uploads', url.endsWith('/') ? url : `${url}/`);
  const size = fs.statSync(file).size;
  const boundary = `----briefcase-${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted(filename)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise<StreamUploadResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The upload was aborted', 'AbortError'));
      return;
    }
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const source = fs.createReadStream(file, { highWaterMark: PIECE_BYTES });
    const req = transport.request(
      target,
      {
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': head.length + size + tail.length,
          Authorization: `Bearer ${token}`,
          'X-Crucible-Api': String(API_VERSION),
          'X-Crucible-Client': clientName,
          'User-Agent': `${clientName} (upload)`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => settle(() => reject(new CrucibleUnreachable(url, err.message, err))));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          settle(() => {
            try {
              resolve(readAnswer(status, text, url));
            } catch (err) {
              reject(err);
            }
          });
        });
      },
    );
    const onAbort = (): void => {
      source.destroy();
      req.destroy();
      settle(() => reject(signal!.reason ?? new DOMException('The upload was aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      source.destroy();
      settle(() => reject(signal?.aborted ? (signal.reason ?? err) : new CrucibleUnreachable(url, err.message, err)));
    });
    source.on('error', (err) => {
      req.destroy();
      settle(() => reject(new Error(`The video could not be read for upload (${err.message})`)));
    });
    source.on('data', (piece) => onBytes?.((piece as Buffer).length));
    source.on('end', () => req.end(tail));
    req.write(head);
    source.pipe(req, { end: false });
  });
}

/** The server's answer as the SDK would read it: the blob, or the error type its status and envelope name. */
function readAnswer(status: number, text: string, url: string): StreamUploadResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const obj = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    // As the SDK's own upload reads it (1.0.72): all three are required.
    if (typeof obj['blob_id'] !== 'string' || typeof obj['bytes'] !== 'number' || typeof obj['sha256'] !== 'string') {
      throw new CrucibleProtocolError(`upload did not return blob_id, bytes and sha256: ${text.slice(0, 200)}`);
    }
    return { blobId: obj['blob_id'], bytes: obj['bytes'], sha256: obj['sha256'] };
  }
  const envelope = obj['error'] as Record<string, unknown> | undefined;
  if (!envelope || typeof envelope !== 'object' || typeof envelope['code'] !== 'string' || typeof envelope['message'] !== 'string') {
    throw new CrucibleProtocolError(
      `HTTP ${status} from ${url} is not a crucible error ({"error": {"code", "message"}}); it said: ${text.slice(0, 200)}`,
    );
  }
  const code = envelope['code'];
  const message = envelope['message'];
  const details = (envelope['details'] ?? null) as Record<string, unknown> | null;
  if (status === 401) throw new CrucibleAuthError(code, message);
  if (status === 426) {
    const server = typeof details?.['server_api_version'] === 'number' ? (details['server_api_version'] as number) : null;
    throw new CrucibleVersionError(code, message, server, API_VERSION);
  }
  if (status >= 500) throw new CrucibleServerError(status, code, message, details);
  throw new CrucibleRefused(status, code, message, details);
}
