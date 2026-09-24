/**
 * `/crucible/readiness`: is Crucible there for AI work, and the doors that
 * bring it up (P7). The same answer arrives on Socket.IO `crucible.readiness`.
 *
 *   GET  /crucible/readiness           the current answer
 *   POST /crucible/readiness/refresh   derived again now
 *   POST /crucible/readiness/start     start the Crucible on this computer (answers `starting` at once)
 *   POST /crucible/readiness/decline   "Not now": nothing starts or prompts on its own this session
 */
import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { LoopbackOriginGuard } from './loopback-origin.guard';
import { CrucibleReadinessService } from './readiness.service';
import type { CrucibleReadinessView } from './wire/readiness-wire';

@UseGuards(LoopbackOriginGuard)
@Controller('crucible/readiness')
export class CrucibleReadinessController {
  constructor(private readonly readiness: CrucibleReadinessService) {}

  @Get()
  current(): CrucibleReadinessView {
    return this.readiness.current();
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(): Promise<CrucibleReadinessView> {
    return this.readiness.refresh();
  }

  @Post('start')
  @HttpCode(200)
  start(): Promise<CrucibleReadinessView> {
    return this.readiness.start();
  }

  @Post('decline')
  @HttpCode(200)
  decline(): CrucibleReadinessView {
    return this.readiness.decline();
  }
}
