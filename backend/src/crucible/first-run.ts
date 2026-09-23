/**
 * HOLD COORDINATION UNTIL THE FIRST-RUN WIZARD FINISHES.
 *
 * Ported from BookForge's electron/crucible/first-run-models.ts. While the
 * wizard is open, the user has not yet said which AI they want (this
 * computer's GPU, Claude, ChatGPT, or none), and coordination would start
 * multi-gigabyte pulls for a choice nobody has made. So the wizard holds
 * coordination on entry and releases it on finish or skip.
 *
 * The hold is a MARKER FILE, not a flag, so it survives a restart mid-wizard:
 * a user who quits during setup and relaunches still has not chosen.
 *
 * Briefcase differs from BookForge in who decides "setup is needed": the
 * renderer opens the wizard (when essential tools are missing), so the renderer
 * takes the hold (`POST /crucible/first-run/hold`) rather than the backend
 * guessing at boot.
 */
import * as fs from 'fs';
import * as path from 'path';

export const FIRST_RUN_MARKER = 'crucible-first-run.pending';

export class FirstRunGate {
  constructor(private readonly marker: string) {}

  static inDir(dir: string): FirstRunGate {
    return new FirstRunGate(path.join(dir, FIRST_RUN_MARKER));
  }

  /** True while the wizard holds coordination back. Read from disk each time: the file is the state. */
  get held(): boolean {
    return fs.existsSync(this.marker);
  }

  /** Take the hold. Idempotent. */
  hold(): void {
    if (this.held) return;
    fs.mkdirSync(path.dirname(this.marker), { recursive: true });
    fs.writeFileSync(this.marker, 'Finish Briefcase setup before Crucible prepares models.\n');
  }

  /** Release the hold. True when there was one to release. */
  release(): boolean {
    if (!this.held) return false;
    fs.unlinkSync(this.marker);
    return true;
  }
}
