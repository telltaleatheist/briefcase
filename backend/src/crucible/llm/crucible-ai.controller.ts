/**
 * `/crucible/ai/*`: the connected server's models, the
 * one-time key copy and per-task models. Every refusal is `{code, message}`,
 * and no response carries a key.
 */
import { Body, Controller, Get, HttpException, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';
import { LoopbackOriginGuard } from '../loopback-origin.guard';
import { CrucibleError } from '@crucible/client';
import { failureOutcome } from '../probe';
import { CrucibleRegistryError, CrucibleRoutingError } from '../errors';
import { CrucibleSettingsInputError } from '../settings-bridge.service';
import type { AiModelsView, AiTaskModels, KeyCopyOutcome, LegacyKeysView } from '../wire/ai-wire';
import { CrucibleAiInputError, CrucibleAiService } from './crucible-ai.service';

@UseGuards(LoopbackOriginGuard)
@Controller('crucible/ai')
export class CrucibleAiController {
  constructor(private readonly ai: CrucibleAiService) {}

  private async guard<T>(work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof CrucibleAiInputError || err instanceof CrucibleSettingsInputError) {
        throw new HttpException({ code: err.code, message: err.message }, err.code === 'unknown_server' ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST);
      }
      if (err instanceof CrucibleRegistryError || err instanceof CrucibleRoutingError) {
        throw new HttpException({ code: err.code, message: err.message }, HttpStatus.CONFLICT);
      }
      if (err instanceof CrucibleError || err instanceof Error) {
        const failure = failureOutcome(err, 'That Crucible server');
        throw new HttpException({ code: failure.outcome, message: failure.message }, HttpStatus.BAD_GATEWAY);
      }
      throw new HttpException({ code: 'refused', message: String(err) }, HttpStatus.BAD_GATEWAY);
    }
  }

  /** The analysis-model options, and what each stored `values` choice is among them: `?values=a,b`. */
  @Get('models')
  models(@Query('server') server?: string, @Query('values') values?: string): Promise<AiModelsView> {
    return this.guard(() => this.ai.models(server || undefined, typeof values === 'string' && values !== '' ? values.split(',') : []));
  }

  /** Drop cached model lists after the pane saved a server's settings. */
  @Post('models/refresh')
  refresh(@Body() body: { server?: unknown }): Promise<{ refreshed: true }> {
    return this.guard(() => {
      this.ai.forget(typeof body?.server === 'string' ? body.server : undefined);
      return { refreshed: true as const };
    });
  }

  @Get('keys/legacy')
  legacyKeys(): Promise<LegacyKeysView> {
    return this.guard(() => this.ai.legacyKeys());
  }

  @Post('keys/copy')
  copyKeys(@Body() body: { server?: unknown }): Promise<KeyCopyOutcome> {
    return this.guard(() => {
      if (typeof body?.server !== 'string' || body.server === '') throw new CrucibleAiInputError('invalid_request', 'Name the server to copy the keys to.');
      return this.ai.copyKeys(body.server);
    });
  }

  @Get('task-models')
  taskModels(): Promise<AiTaskModels> {
    return this.guard(() => this.ai.taskModels());
  }

  @Put('task-models')
  setTaskModels(@Body() body: Record<string, unknown>): Promise<AiTaskModels> {
    return this.guard(() => this.ai.setTaskModels(body ?? {}));
  }
}
