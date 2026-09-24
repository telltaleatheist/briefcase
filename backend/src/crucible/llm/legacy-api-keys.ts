/**
 * BRIEFCASE'S OLD api-keys.json, for ONE thing only: the explicit, one-time
 * "copy my keys to Crucible" action (crucible-ai.service `copyKeys`).
 *
 * Before P7 Briefcase called Claude and OpenAI itself with keys it kept in
 * `<userData>/briefcase/api-keys.json`. That road is gone (keys live on the
 * Crucible that serves the call). Nothing here ever sends a key anywhere or
 * writes the file: it reads what an older Briefcase left behind so the user
 * can move it with one press, and deletes the file once the Crucible on this
 * computer has confirmed every key.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';

/** The file as older Briefcase versions wrote it. Only the two keys are read. */
interface LegacyKeysFile {
  claudeApiKey?: unknown;
  openaiApiKey?: unknown;
}

/** `<configDir>/api-keys.json`, where every older Briefcase wrote it. */
export function legacyApiKeysPath(): string {
  return path.join(getBriefcaseConfigDir(), 'api-keys.json');
}

@Injectable()
export class LegacyApiKeys {
  private readonly logger = new Logger('LegacyApiKeys');
  /** Replaceable by a spec: the real one is the user's own file. */
  file: string = legacyApiKeysPath();

  /**
   * The raw keys, read fresh each time. Backend-internal: never returned by a
   * controller. An unreadable file reads as no keys (and says so in the log):
   * it is never rewritten, so nothing in it is lost.
   */
  keysForCopy(): { claude?: string; openai?: string } {
    let parsed: LegacyKeysFile;
    try {
      if (!fs.existsSync(this.file)) return {};
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as LegacyKeysFile;
    } catch (error) {
      this.logger.warn(`${this.file} could not be read (${(error as Error).message}); it was left as it is.`);
      return {};
    }
    const key = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
    const claude = key(parsed?.claudeApiKey);
    const openai = key(parsed?.openaiApiKey);
    return { ...(claude ? { claude } : {}), ...(openai ? { openai } : {}) };
  }

  /** Delete api-keys.json, after the Crucible on this computer confirmed it holds every key. */
  forgetKeysAndDeleteFile(): void {
    if (fs.existsSync(this.file)) fs.rmSync(this.file, { force: true });
    this.logger.log('API keys moved to Crucible; api-keys.json deleted');
  }
}
