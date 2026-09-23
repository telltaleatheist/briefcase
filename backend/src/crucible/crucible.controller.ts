/**
 * The HTTP door the Settings › Crucible Servers pane talks to.
 *
 * NO RESPONSE HERE CARRIES A TOKEN. Rows carry `tokenMasked`, connect codes
 * come back elided, and settings carry the server's `keyHint`. The registry's
 * token-bearing read is used only by the client factory, which this controller
 * never hands anything but a name.
 *
 * Every refusal comes back as `{code, message}` with a status that says what
 * kind of refusal it is, and the message always carries the fix.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CrucibleConnectionError, CrucibleError } from '@crucible/client';
import { CrucibleConnectService } from './connect.service';
import { CrucibleProbeService, failureOutcome } from './probe';
import { CrucibleRegistryService } from './registry.service';
import { CrucibleSettingsBridge, CrucibleSettingsInputError } from './settings-bridge.service';
import { discoveredRow } from './discovery';
import { CrucibleConnectError, CrucibleRegistryError, CrucibleRoutingError } from './errors';
import { CRUCIBLE_PAIRING_HOST } from './crucible.constants';
import type { PairingFileHost } from './pairing-file';
import type {
  ConnectCodeReading,
  CopiedConnectCode,
  CruciblePairingDecision,
  CruciblePairingPrompt,
} from './wire/connect-wire';
import type {
  CrucibleProbeAnswer,
  CrucibleServerRow,
  CrucibleServersView,
  CrucibleSettingsView,
  DiscoveredCrucibleRow,
  RoutingView,
  UpstreamTestAnswer,
} from './wire/settings-wire';

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  unknown_server: HttpStatus.NOT_FOUND,
  duplicate_server: HttpStatus.CONFLICT,
  invalid_name: HttpStatus.BAD_REQUEST,
  invalid_url: HttpStatus.BAD_REQUEST,
  empty_token: HttpStatus.BAD_REQUEST,
  corrupt_registry: HttpStatus.INTERNAL_SERVER_ERROR,
  corrupt_routing: HttpStatus.INTERNAL_SERVER_ERROR,
  incomplete_order: HttpStatus.BAD_REQUEST,
  duplicate_in_order: HttpStatus.BAD_REQUEST,
  server_is_known: HttpStatus.CONFLICT,
  no_enabled_server: HttpStatus.CONFLICT,
  invalid_pairing: HttpStatus.BAD_REQUEST,
  pairing_not_active: HttpStatus.GONE,
  probe_failed: HttpStatus.BAD_GATEWAY,
  nothing_discovered: HttpStatus.NOT_FOUND,
  clipboard_unavailable: HttpStatus.INTERNAL_SERVER_ERROR,
  invalid_settings: HttpStatus.BAD_REQUEST,
  invalid_address: HttpStatus.BAD_REQUEST,
  invalid_request: HttpStatus.BAD_REQUEST,
};

function refusal(code: string, message: string, status?: HttpStatus): HttpException {
  return new HttpException({ code, message }, status ?? STATUS_BY_CODE[code] ?? HttpStatus.BAD_GATEWAY);
}

function badRequest(message: string): HttpException {
  return refusal('invalid_request', message);
}

@Controller('crucible')
export class CrucibleController {
  private readonly logger = new Logger('CrucibleController');

  constructor(
    private readonly registry: CrucibleRegistryService,
    private readonly probes: CrucibleProbeService,
    private readonly connect: CrucibleConnectService,
    private readonly settings: CrucibleSettingsBridge,
    @Inject(CRUCIBLE_PAIRING_HOST) private readonly pairingHost: PairingFileHost,
  ) {}

  /** Turn any failure into a named refusal. Never lets a raw SDK error (or its URL) through unshaped. */
  private async guard<T>(work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof CrucibleRegistryError || err instanceof CrucibleRoutingError || err instanceof CrucibleConnectError
        || err instanceof CrucibleSettingsInputError) {
        throw refusal(err.code, err.message);
      }
      if (err instanceof CrucibleConnectionError) {
        throw refusal(err.code, err.message, err.code === 'invalid_address' ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY);
      }
      if (err instanceof CrucibleError || err instanceof Error) {
        const failure = failureOutcome(err, 'That Crucible server');
        throw refusal(failure.outcome, failure.message, HttpStatus.BAD_GATEWAY);
      }
      throw refusal('refused', String(err), HttpStatus.BAD_GATEWAY);
    }
  }

  // ── the list ────────────────────────────────────────────────────────────

  @Get('servers')
  listServers(): Promise<CrucibleServersView> {
    return this.guard(() => {
      const servers = this.registry.list();
      return { servers, routing: this.registry.routingView(), discovered: discoveredRow(servers, this.pairingHost) };
    });
  }

  /** The Crucible on this computer: the offer the pane and (P2) the setup wizard draw. */
  @Get('local')
  local(): Promise<DiscoveredCrucibleRow> {
    return this.guard(() => discoveredRow(this.registry.list(), this.pairingHost));
  }

  @Post('servers')
  addServer(@Body() body: { connectCode?: unknown; discovered?: unknown; name?: unknown }): Promise<{ server: CrucibleServerRow }> {
    return this.guard(async () => {
      const name = typeof body?.name === 'string' ? body.name : undefined;
      if (typeof body?.connectCode === 'string') return { server: await this.connect.addFromConnectCode(body.connectCode, name) };
      if (body?.discovered === true) return { server: await this.connect.addDiscovered(name) };
      throw badRequest('Send {connectCode} or {discovered: true}. To pair by address, use /crucible/pair/start.');
    });
  }

  @Delete('servers/:name')
  removeServer(@Param('name') name: string): Promise<{ removed: CrucibleServerRow }> {
    return this.guard(() => ({ removed: this.registry.remove(name) }));
  }

  /** The cached probe (at most 10 s old): the row's first paint. */
  @Get('servers/:name/probe')
  probe(@Param('name') name: string): Promise<CrucibleProbeAnswer> {
    return this.guard(() => this.probes.reach(name));
  }

  /** The Test button: a probe taken now. */
  @Post('servers/:name/test')
  test(@Param('name') name: string): Promise<CrucibleProbeAnswer> {
    return this.guard(() => this.probes.test(name, true));
  }

  @Post('servers/:name/pause')
  pause(@Param('name') name: string): Promise<RoutingView> {
    return this.guard(() => this.registry.setEnabled(name, false));
  }

  @Post('servers/:name/resume')
  resume(@Param('name') name: string): Promise<RoutingView> {
    return this.guard(() => this.registry.setEnabled(name, true));
  }

  /** Re-rank, and/or set the whole paused set. */
  @Put('routing')
  setRouting(@Body() body: { order?: unknown; disabled?: unknown }): Promise<RoutingView> {
    return this.guard(() => {
      const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
      if (body?.order === undefined && body?.disabled === undefined) throw badRequest('Send {order} and/or {disabled}.');
      if (body.order !== undefined && !isNames(body.order)) throw badRequest('"order" is a list of server names.');
      if (body.disabled !== undefined && !isNames(body.disabled)) throw badRequest('"disabled" is a list of server names.');
      let view = this.registry.routingView();
      if (body.order !== undefined) view = this.registry.setOrder(body.order as string[]);
      if (body.disabled !== undefined) {
        const paused = new Set(body.disabled as string[]);
        for (const name of paused) {
          if (!this.registry.names().includes(name)) throw refusal('unknown_server', `"${name}" is not one of this machine's Crucible servers.`);
        }
        for (const row of this.registry.routingView().ranked) {
          const enabled = !paused.has(row.name);
          if (row.enabled !== enabled) view = this.registry.setEnabled(row.name, enabled);
        }
      }
      return view;
    });
  }

  /** Drop a rank the record keeps for a server that is no longer registered. */
  @Post('routing/forget')
  forget(@Body() body: { name?: unknown }): Promise<RoutingView> {
    return this.guard(() => {
      if (typeof body?.name !== 'string') throw badRequest('Send {name}.');
      return this.registry.forgetRoutingName(body.name);
    });
  }

  // ── device-code pairing ────────────────────────────────────────────────

  @Post('pair/start')
  pairStart(@Body() body: { address?: unknown; name?: unknown }): Promise<CruciblePairingPrompt> {
    return this.guard(() => {
      if (typeof body?.address !== 'string' || body.address.trim() === '') throw badRequest('Send {address}: an IP address, hostname or URL.');
      return this.connect.startPairing(body.address, typeof body.name === 'string' ? body.name : undefined);
    });
  }

  @Post('pair/poll')
  pairPoll(@Body() body: { requestId?: unknown }): Promise<CruciblePairingDecision> {
    return this.guard(() => {
      if (typeof body?.requestId !== 'string') throw badRequest('Send {requestId}.');
      return this.connect.pollPairing(body.requestId);
    });
  }

  @Post('pair/cancel')
  pairCancel(@Body() body: { requestId?: unknown }): Promise<{ cancelled: true }> {
    return this.guard(() => {
      if (typeof body?.requestId !== 'string') throw badRequest('Send {requestId}.');
      this.connect.cancelPairing(body.requestId);
      return { cancelled: true as const };
    });
  }

  // ── connect codes ───────────────────────────────────────────────────────

  /** Read a pasted connect code back with its token masked. Writes nothing. */
  @Post('connect-code/parse')
  parseConnectCode(@Body() body: { connectCode?: unknown }): Promise<ConnectCodeReading> {
    return this.guard(() => {
      if (typeof body?.connectCode !== 'string') throw badRequest('Send {connectCode}.');
      return this.connect.readConnectCode(body.connectCode);
    });
  }

  /** Copy THIS computer's Crucible connect code to the clipboard, for another machine. */
  @Post('connect-code/copy')
  copyLocalConnectCode(): Promise<CopiedConnectCode> {
    return this.guard(() => this.connect.copyLocalConnectCode());
  }

  /** Copy a registered server's connect code to the clipboard. */
  @Post('servers/:name/connect-code/copy')
  copyConnectCode(@Param('name') name: string): Promise<CopiedConnectCode> {
    return this.guard(() => this.connect.copyConnectCode(name));
  }

  // ── that server's own settings ─────────────────────────────────────────

  @Get('servers/:name/settings')
  getSettings(@Param('name') name: string): Promise<CrucibleSettingsView> {
    return this.guard(() => this.settings.get(name));
  }

  @Put('servers/:name/settings')
  putSettings(@Param('name') name: string, @Body() body: unknown): Promise<CrucibleSettingsView> {
    return this.guard(() => this.settings.put(name, body));
  }

  @Post('servers/:name/settings/upstreams/:upstream/test')
  testUpstream(
    @Param('name') name: string,
    @Param('upstream') upstream: string,
    @Body() body: unknown,
  ): Promise<UpstreamTestAnswer> {
    return this.guard(() => this.settings.testUpstream(name, upstream, body));
  }
}
