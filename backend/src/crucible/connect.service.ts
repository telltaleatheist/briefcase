/**
 * ADDING A CRUCIBLE SERVER: device-code pairing, a pasted connect code, or the
 * Crucible on this computer. Every path ends the same way: a probe that must
 * answer `ok`, then one registry write.
 *
 * Ported from BookForge's electron/crucible/connect.ts and connect-code.ts.
 *
 * DEVICE-CODE PAIRING (crucible docs/INTEGRATING-AN-APP.md §5.1). The user
 * types an address; `startPairing` returns a short user code; `pollPairing`
 * answers `approved` with a token. On a server with `open_pairing` (the
 * default) the first poll approves. The device code and the token stay here:
 * the renderer holds only a request id and the user code.
 *
 * CONNECT CODES: `crucible://<name>@host:port/#<token>`, parsed by the SDK's
 * `parsePairing`, the one parser of that format. Copying a registered
 * server's code writes it to the clipboard FROM HERE, so the token never
 * crosses into the renderer; the answer carries the line with its token elided.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CruciblePairingError,
  parsePairing,
  pollPairing,
  startPairing,
  type Pairing,
  type PairingRequest,
} from '@crucible/client';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_PAIRING_HOST } from './crucible.constants';
import { CrucibleConnectError } from './errors';
import { maskToken } from './registry';
import { CrucibleRegistryService } from './registry.service';
import { CrucibleProbeService } from './probe';
import { readCruciblePairingFile, type PairingFileHost } from './pairing-file';
import type { ClipboardWriter } from './clipboard';
import type {
  ConnectCodeReading,
  CopiedConnectCode,
  CruciblePairingDecision,
  CruciblePairingPrompt,
} from './wire/connect-wire';
import type { CrucibleServerRow } from './wire/settings-wire';

/** How this app names itself on a pairing request, as the server's approval list shows it. */
export const PAIRING_CLIENT_NAME = 'Briefcase';

interface Pending {
  controller: AbortController;
  request: PairingRequest;
  expiresAt: number;
  /** The name the user asked this server to be filed under, if any. */
  name?: string;
  polling?: Promise<CruciblePairingDecision>;
}

/** `crucible://<name>@<host:port>/#<token>`, both components percent-encoded (crucible pairing.py's format). */
export function connectCodeFor(name: string, url: string, token: string): string {
  const authority = new URL(url).host;
  if (authority === '') {
    throw new CrucibleConnectError('invalid_pairing', `"${name}" is registered at ${url}, which has no host to build a connect code from.`);
  }
  return `crucible://${encodeURIComponent(name)}@${authority}/#${encodeURIComponent(token)}`;
}

/** A connect code with its token elided, fit to show. */
export function elideConnectCode(line: string): string {
  return line.replace(/#.*$/, '#****');
}

@Injectable()
export class CrucibleConnectService {
  private readonly logger = new Logger('CrucibleConnect');
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly registry: CrucibleRegistryService,
    private readonly probes: CrucibleProbeService,
    @Inject(CRUCIBLE_PAIRING_HOST) private readonly pairingHost: PairingFileHost,
    @Inject(CRUCIBLE_CLIPBOARD) private readonly clipboard: ClipboardWriter,
  ) {}

  // ── device-code pairing ────────────────────────────────────────────────

  async startPairing(address: string, name?: string): Promise<CruciblePairingPrompt> {
    const requestId = randomUUID();
    const controller = new AbortController();
    const request = await startPairing(address, PAIRING_CLIENT_NAME, { signal: controller.signal });
    const pending: Pending = {
      controller,
      request,
      expiresAt: Date.now() + request.expiresIn * 1000,
      ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
    };
    this.pending.set(requestId, pending);
    return {
      requestId,
      name: request.name,
      url: request.url,
      userCode: request.userCode,
      expiresIn: request.expiresIn,
      interval: request.interval,
      approvalRequired: request.approvalRequired,
    };
  }

  /**
   * Ask once. `approved` means the server was probed and registered, and the
   * answer carries the registry name. Concurrent polls of one request share one
   * round trip.
   */
  async pollPairing(requestId: string): Promise<CruciblePairingDecision> {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      throw new CrucibleConnectError('pairing_not_active', 'This connection request is no longer active. Enter the address to try again.');
    }
    if (Date.now() >= pending.expiresAt) {
      this.cancelPairing(requestId);
      return { status: 'expired' };
    }
    if (pending.polling) return pending.polling;
    pending.polling = (async (): Promise<CruciblePairingDecision> => {
      const result = await pollPairing(pending.request, { signal: pending.controller.signal });
      if (this.pending.get(requestId) !== pending) {
        throw new CrucibleConnectError('pairing_not_active', 'The connection request was cancelled.');
      }
      if (result.status === 'pending') return result;
      this.cancelPairing(requestId);
      if (result.status !== 'approved') return result;
      const row = await this.probeThenAdd(result.pairing, pending.name);
      return { status: 'approved', name: row.name };
    })();
    try {
      return await pending.polling;
    } finally {
      pending.polling = undefined;
    }
  }

  cancelPairing(requestId: string): void {
    this.pending.get(requestId)?.controller.abort();
    this.pending.delete(requestId);
  }

  // ── connect codes ───────────────────────────────────────────────────────

  /** A pasted line read back with the token masked, for the add form's preview. */
  readConnectCode(line: string): ConnectCodeReading {
    try {
      const pairing = parsePairing(line);
      return { ok: true, name: pairing.name, url: pairing.url, tokenMasked: maskToken(pairing.token) };
    } catch (err) {
      if (err instanceof CruciblePairingError) return { ok: false, code: 'invalid_pairing', message: err.message };
      throw err;
    }
  }

  async addFromConnectCode(line: string, name?: string): Promise<CrucibleServerRow> {
    let pairing: Pairing;
    try {
      pairing = parsePairing(line);
    } catch (err) {
      if (err instanceof CruciblePairingError) throw new CrucibleConnectError('invalid_pairing', err.message);
      throw err;
    }
    return this.probeThenAdd(pairing, name);
  }

  /** Adopt the Crucible on this computer, from its pairing file. */
  async addDiscovered(name?: string): Promise<CrucibleServerRow> {
    const found = readCruciblePairingFile(this.pairingHost);
    if (found === null) {
      throw new CrucibleConnectError('nothing_discovered', 'There is no Crucible on this computer to add.');
    }
    return this.probeThenAdd(found.pairing, name);
  }

  /** Put a registered server's connect code on the clipboard. The token never leaves the backend. */
  async copyConnectCode(serverName: string): Promise<CopiedConnectCode> {
    const entry = this.registry.getWithToken(serverName);
    return this.copy(connectCodeFor(entry.name, entry.url, entry.token));
  }

  /** Put THIS computer's Crucible connect code on the clipboard, for pasting on another machine. */
  async copyLocalConnectCode(): Promise<CopiedConnectCode> {
    const found = readCruciblePairingFile(this.pairingHost);
    if (found === null) {
      throw new CrucibleConnectError('nothing_discovered', 'There is no Crucible on this computer, so there is no connect code to copy.');
    }
    return this.copy(connectCodeFor(found.pairing.name, found.pairing.url, found.pairing.token));
  }

  private async copy(line: string): Promise<CopiedConnectCode> {
    try {
      await this.clipboard(line);
    } catch (err) {
      throw new CrucibleConnectError('clipboard_unavailable', `The connect code could not be copied: ${(err as Error).message}`);
    }
    return { copied: elideConnectCode(line) };
  }

  /** Probe, and write the registry only when the server answers `ok`. */
  private async probeThenAdd(pairing: Pairing, name?: string): Promise<CrucibleServerRow> {
    const result = await this.probes.probeCredentials(pairing.url, pairing.token, pairing.url);
    if (result.outcome !== 'ok') {
      throw new CrucibleConnectError('probe_failed', result.message);
    }
    const chosen = name !== undefined && name.trim() !== '' ? name : pairing.name;
    const row = this.registry.add({ name: chosen, url: pairing.url, token: pairing.token });
    this.logger.log(`Connected Crucible "${row.name}" (${result.facts.version}, ${result.facts.backend})`);
    return row;
  }
}
