/**
 * The quit path runs once (review follow-up 6): one listener per signal, one
 * run however many signals arrive, every Nest hook (the Crucible quit sweep
 * among them) once, the Ollama release beside the hooks, and a hard exit under
 * Electron's 12 s kill.
 */
import { EventEmitter } from 'events';
import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { gracefulShutdown, installGracefulShutdown, SHUTDOWN_DEADLINE_MS } from '../../src/common/graceful-shutdown';

@Injectable()
class Sweeper implements BeforeApplicationShutdown {
  runs = 0;
  holdMs = 0;
  async beforeApplicationShutdown(): Promise<void> {
    this.runs += 1;
    await new Promise((r) => setTimeout(r, this.holdMs));
  }
}

const quiet = { info: () => undefined, warn: () => undefined };

async function nestApp() {
  const moduleRef = await Test.createTestingModule({ providers: [Sweeper] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, sweeper: app.get(Sweeper) };
}

describe('REGRESSION: the quit path runs every shutdown hook exactly once', () => {
  it('SIGTERM twice and a SIGINT: one close, one sweep, one exit', async () => {
    const { app, sweeper } = await nestApp();
    const proc = new EventEmitter();
    const exit = jest.fn();
    const handler = installGracefulShutdown({ close: () => app.close(), releaseOllama: async () => undefined, exit, log: quiet }, ['SIGTERM', 'SIGINT'], proc as never);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await handler('SIGTERM');
    expect(sweeper.runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('the Ollama release runs beside the hooks, not before them', async () => {
    const { app, sweeper } = await nestApp();
    sweeper.holdMs = 150;
    const exit = jest.fn();
    const began = Date.now();
    await gracefulShutdown({
      close: () => app.close(),
      releaseOllama: () => new Promise((r) => setTimeout(r, 150)),
      exit,
      log: quiet,
    })('SIGTERM');
    expect(Date.now() - began).toBeLessThan(280);
    expect(sweeper.runs).toBe(1);
  });

  it('a hook that hangs cannot keep the process past the deadline, which is under Electron\'s 12 s kill', async () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(12_000);
    const exit = jest.fn();
    void gracefulShutdown({ close: () => new Promise(() => undefined), releaseOllama: async () => undefined, exit, log: quiet, deadlineMs: 50 })('SIGTERM');
    await new Promise((r) => setTimeout(r, 120));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
