/**
 * SPAWNING THE WINDOWS HOST'S `crucible.cmd`: the one thing
 * `@crucible/bootstrap`'s own runner cannot do from Electron's Node.
 *
 * Ported from BookForge's electron/crucible/host-runner.ts. Node's fix for
 * CVE-2024-27980 makes `child_process.spawn` refuse a `.cmd`/`.bat` target
 * (EINVAL) unless it goes through a shell, and the package's `processRunner()`
 * spawns with no shell. `%LOCALAPPDATA%\Crucible\host\crucible.cmd` is the
 * Windows host's entry point, so the local status/start controls and the
 * install door would throw EINVAL on the first real press. BookForge measured
 * it on Electron 33's Node.
 *
 * The form is `cmd.exe /d /s /c ""<program>" "<arg>" …"` with
 * `windowsVerbatimArguments`: `/d` skips AutoRun, `/s` makes the quoting one
 * rule (strip the outer pair, take the rest verbatim), every token is quoted,
 * and libuv is told not to re-quote. `shell: true` is not used because it
 * builds the line by string concatenation, which is the injection hole.
 *
 * A token carrying `"`, `%` or a line break is REFUSED, never escaped: a quote
 * is indistinguishable from the end of a token, and `%` is expanded as cmd.exe
 * reads the line, so the path would silently become a different path.
 *
 * Everything that is not a win32 `.cmd`/`.bat` target is the package's own
 * runner, unchanged.
 */
import { spawn } from 'child_process';
import {
  decodeWslBytes,
  incompleteTailBytes,
  processRunner,
  splitLines,
  type OutputStream,
  type RunOptions,
  type RunResult,
  type Runner,
  type StreamOptions,
} from '@crucible/bootstrap';
import { CrucibleInstallError } from './install';

export const SHELL_SCRIPT_EXTENSIONS = ['.cmd', '.bat'] as const;

const FORBIDDEN = /["%\r\n\u0000]/;

/** How one argv is actually spawned on this platform. Pure, so a spec can assert it. */
export interface CrucibleSpawnPlan {
  program: string;
  args: string[];
  /** True only for the cmd.exe form: the args are exactly what cmd.exe must receive. */
  verbatim: boolean;
}

export function needsCommandProcessor(program: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const lower = program.toLowerCase();
  return SHELL_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The spawn plan for one argv, or a refusal (`host_runner_bad_path`) naming the token that cannot be carried. */
export function crucibleSpawnPlan(argv: readonly string[], platform: NodeJS.Platform = process.platform): CrucibleSpawnPlan {
  const program = argv[0];
  if (program === undefined) {
    throw new CrucibleInstallError('host_runner_bad_path', 'an empty argv reached the runner, so there is no program to run.');
  }
  if (!needsCommandProcessor(program, platform)) return { program, args: [...argv.slice(1)], verbatim: false };
  for (const token of argv) {
    if (FORBIDDEN.test(token)) {
      throw new CrucibleInstallError(
        'host_runner_bad_path',
        `"${token}" cannot be passed to the Windows command processor: it contains a quote, a percent sign or a `
          + 'line break, and cmd.exe would read it as a different path. It is refused rather than escaped.',
        { detail: 'LOCALAPPDATA is read from the environment, so this is a fact about the machine.' },
      );
    }
  }
  const line = argv.map((token) => `"${token}"`).join(' ');
  return { program: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** The runner Briefcase hands `@crucible/bootstrap`: the package's own, plus the `.cmd` case. */
export function crucibleProcessRunner(): Runner {
  const base = processRunner();
  return {
    ...base,
    run: (argv, options) => {
      const plan = crucibleSpawnPlan(argv, base.platform);
      return plan.verbatim ? launchVerbatim(plan, options) : base.run(argv, options);
    },
    stream: (argv, options) => {
      const plan = crucibleSpawnPlan(argv, base.platform);
      return plan.verbatim ? launchVerbatim(plan, options, options.onLine) : base.stream(argv, options);
    },
  };
}

/** One `cmd.exe /d /s /c` run. Never throws: the `Runner` contract reports failure in the result. */
function launchVerbatim(plan: CrucibleSpawnPlan, options: RunOptions, onLine?: StreamOptions['onLine']): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const pending: Record<OutputStream, string> = { stdout: '', stderr: '' };
    const carry: Record<OutputStream, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.program, plan.args, {
        cwd: options.cwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      });
    } catch (spawnError) {
      resolve({ code: null, stdout: '', stderr: '', failure: (spawnError as Error).message });
      return;
    }

    const finish = (code: number | null, failure: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onLine !== undefined) {
        for (const stream of ['stdout', 'stderr'] as const) {
          const tail = carry[stream].length === 0 ? '' : decodeWslBytes(carry[stream]);
          const text = pending[stream] + tail;
          if (text.trim().length > 0) onLine(text, stream);
        }
      }
      resolve({ code, stdout: decodeWslBytes(Buffer.concat(out)), stderr: decodeWslBytes(Buffer.concat(err)), failure });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null, `timed out after ${options.timeoutMs} ms`);
    }, options.timeoutMs);

    const take = (chunk: Buffer, stream: OutputStream): void => {
      (stream === 'stdout' ? out : err).push(chunk);
      if (onLine === undefined) return;
      const whole = carry[stream].length === 0 ? chunk : Buffer.concat([carry[stream], chunk]);
      const hold = incompleteTailBytes(whole);
      carry[stream] = hold === 0 ? Buffer.alloc(0) : Buffer.from(whole.subarray(whole.length - hold));
      const usable = hold === 0 ? whole : whole.subarray(0, whole.length - hold);
      const split = splitLines(pending[stream] + decodeWslBytes(usable));
      pending[stream] = split.rest;
      for (const line of split.lines) if (line.trim().length > 0) onLine(line, stream);
    };

    child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'stderr'));
    child.on('error', (childError) => finish(null, childError.message));
    child.on('close', (code) => finish(code, null));
  });
}
