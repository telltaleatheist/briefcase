/**
 * THE INSTALL AND FIRST-RUN DOOR (P2): what the setup wizard's engine step and
 * the Crucible Servers pane's local-machine door talk to.
 *
 *   GET  /crucible/setup                  the one face, and everything it draws
 *   GET  /crucible/install/plan           host facts, hostability, the steps
 *   GET  /crucible/install                is one running, and what did the last one come to
 *   POST /crucible/install                start one (one at a time); progress on crucible.install-progress
 *   GET  /crucible/install/release        the never-older gate's answer, installing nothing
 *   GET  /crucible/install/door           the Windows host's engine move (crucible.install-door)
 *   POST /crucible/install/door/retry     Try again on that move
 *   GET  /crucible/local/presence         the local engine, as its own control says
 *   POST /crucible/local/start            start it (never stop)
 *   GET  /crucible/coordination           every server's coordination state (crucible.coordination)
 *   POST /crucible/servers/:name/coordinate   coordinate one server now (202; states follow)
 *   POST /crucible/first-run/hold         the wizard opened: hold coordination
 *   POST /crucible/first-run/finish       the wizard finished or was skipped: release it
 *
 * Refusals come back as `{code, message, command, detail}` in the bootstrap
 * package's own words, never renamed.
 */
import { Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { CrucibleCoordinationService } from './coordinate.service';
import { CrucibleRegistryService } from './registry.service';
import { CrucibleInstallService } from './install/install.service';
import { installRefusalOf } from './install/install';
import type {
  CrucibleEnginePresence,
  CrucibleEngineStartOutcome,
  CrucibleInstallPlan,
  CrucibleInstallStatus,
  CrucibleReleaseCheck,
  CrucibleSetupView,
} from './wire/install-wire';
import type { CrucibleInstallDoorStatus } from './wire/install-door-wire';
import type { CrucibleCoordinationMap } from './wire/coordinate-wire';
import { CrucibleRegistryError } from './errors';

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  host_install_running: HttpStatus.CONFLICT,
  crucible_already_latest: HttpStatus.CONFLICT,
  install_older_than_running: HttpStatus.CONFLICT,
  not_hostable: HttpStatus.CONFLICT,
  unknown_server: HttpStatus.NOT_FOUND,
  host_not_installed: HttpStatus.CONFLICT,
  no_install_outcome: HttpStatus.CONFLICT,
};

@Controller('crucible')
export class CrucibleSetupController {
  constructor(
    private readonly install: CrucibleInstallService,
    private readonly coordination: CrucibleCoordinationService,
    private readonly registry: CrucibleRegistryService,
  ) {}

  private async guard<T>(work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof CrucibleRegistryError) {
        throw new HttpException({ code: err.code, message: err.message, command: null, detail: null }, STATUS_BY_CODE[err.code] ?? HttpStatus.BAD_REQUEST);
      }
      const refusal = installRefusalOf(err);
      throw new HttpException(refusal, STATUS_BY_CODE[refusal.code] ?? HttpStatus.BAD_GATEWAY);
    }
  }

  @Get('setup')
  setup(): Promise<CrucibleSetupView> {
    return this.guard(() => this.install.setup());
  }

  @Get('install/plan')
  plan(): Promise<CrucibleInstallPlan> {
    return this.guard(() => this.install.plan());
  }

  @Get('install')
  status(): Promise<CrucibleInstallStatus> {
    return this.guard(() => this.install.status());
  }

  @Post('install')
  @HttpCode(HttpStatus.ACCEPTED)
  start(): Promise<{ started: true; release: string }> {
    return this.guard(() => this.install.start());
  }

  @Get('install/release')
  release(): Promise<CrucibleReleaseCheck> {
    return this.guard(() => this.install.checkRelease());
  }

  @Get('install/door')
  door(): Promise<CrucibleInstallDoorStatus> {
    return this.guard(() => this.install.doorStatus());
  }

  @Post('install/door/retry')
  doorRetry(): Promise<{ retrying: true }> {
    return this.guard(async () => {
      await this.install.doorRetry();
      return { retrying: true as const };
    });
  }

  @Get('local/presence')
  presence(): Promise<CrucibleEnginePresence> {
    return this.guard(() => this.install.presence());
  }

  @Post('local/start')
  startLocal(): Promise<CrucibleEngineStartOutcome> {
    return this.guard(() => this.install.startLocal());
  }

  @Get('coordination')
  coordinationStates(): Promise<CrucibleCoordinationMap> {
    return this.guard(() => this.coordination.all());
  }

  /**
   * Coordinate one server now. Not awaited: preparing can download gigabytes,
   * so the answer is that it started, and the states follow on
   * `crucible.coordination`.
   */
  @Post('servers/:name/coordinate')
  @HttpCode(HttpStatus.ACCEPTED)
  coordinate(@Param('name') name: string): Promise<{ coordinating: string }> {
    return this.guard(() => {
      this.registry.getWithToken(name); // unknown_server, by name, before anything is asked
      void this.coordination.request(name, 'it was asked to');
      return { coordinating: name };
    });
  }

  @Post('first-run/hold')
  hold(): Promise<{ held: true }> {
    return this.guard(() => this.coordination.holdForFirstRun());
  }

  @Post('first-run/finish')
  finish(): Promise<{ released: boolean; coordinating: string[] }> {
    return this.guard(() => this.coordination.finishFirstRun());
  }
}
