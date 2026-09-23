/**
 * Write text to the system clipboard from the backend process.
 *
 * The backend runs under ELECTRON_RUN_AS_NODE, so Electron's `clipboard` is not
 * available here. A connect code carries a bearer token, and copying it here is
 * what keeps that token out of the renderer entirely: the renderer asks, the
 * backend copies, the renderer is told what was copied with the token elided.
 *
 * The text goes to the tool on STDIN, never on its command line, so it never
 * appears in a process listing.
 */
import { spawn } from 'child_process';

export type ClipboardWriter = (text: string) => Promise<void>;

function commandsFor(platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  return [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
}

function pipeTo(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.stdin.end(text, 'utf-8');
  });
}

export const systemClipboard: ClipboardWriter = async (text) => {
  let last: unknown = null;
  for (const [command, args] of commandsFor(process.platform)) {
    try {
      await pipeTo(command, args, text);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No clipboard tool answered on ${process.platform}: ${(last as Error)?.message ?? 'none found'}`);
};
