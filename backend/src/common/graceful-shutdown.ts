/**
 * THE ONE QUIT PATH.
 *
 * Electron sends SIGTERM and SIGKILLs 12 s later. Nest's `enableShutdownHooks()`
 * used to run beside a SIGTERM handler of our own that also called
 * `app.close()`, so every shutdown hook ran twice, the Crucible quit sweep
 * (8 s ceiling) included.
 *
 * Now there is one listener per signal, one run however many signals arrive,
 * `app.close()` (every hook, the Crucible quit sweep among them) once, and a
 * hard exit at {@link SHUTDOWN_DEADLINE_MS} so the parent never has to kill us.
 * (Before P7 an Ollama unload ran beside the hooks; Briefcase no longer loads
 * anything in Ollama itself, and what it holds on a Crucible the sweep gives back.)
 */

/** Our own ceiling, under Electron's 12 s SIGKILL. */
export const SHUTDOWN_DEADLINE_MS = 10_500;

export interface GracefulShutdownDeps {
  /** `app.close()`: destroy, before-shutdown (the quit sweep) and shutdown hooks. */
  close(): Promise<void>;
  exit(code: number): void;
  log: { info(message: string): void; warn(message: string): void };
  deadlineMs?: number;
}

/** A handler that runs the shutdown once, whichever signal (and however many) asks for it. */
export function gracefulShutdown(deps: GracefulShutdownDeps): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (signal: string): Promise<void> => {
    running ??= (async () => {
      const deadlineMs = deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
      deps.log.info(`Received ${signal}: releasing resources before exit...`);
      const hard = setTimeout(() => {
        deps.log.warn(`Shutdown still running after ${Math.round(deadlineMs / 100) / 10} s; exiting now`);
        deps.exit(0);
      }, deadlineMs);
      hard.unref?.();
      await Promise.resolve().then(() => deps.close()).catch((error: unknown) => deps.log.warn(`Error closing Nest application: ${(error as Error).message}`));
      clearTimeout(hard);
      deps.log.info('Graceful shutdown complete');
      deps.exit(0);
    })();
    return running;
  };
}

/** One listener per signal, all sharing one run. Returns the handler (for a spec). */
export function installGracefulShutdown(
  deps: GracefulShutdownDeps,
  signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
  proc: Pick<NodeJS.Process, 'on'> = process,
): (signal: string) => Promise<void> {
  const handler = gracefulShutdown(deps);
  for (const signal of signals) proc.on(signal, () => void handler(signal));
  return handler;
}
