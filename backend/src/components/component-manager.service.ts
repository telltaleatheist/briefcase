/**
 * Component Manager Service
 *
 * Download-on-demand for the binaries Briefcase runs itself: ffmpeg/ffprobe and
 * yt-dlp. A resumable, retrying, abortable axios-stream download driven by the
 * published manifest.json catalog, storing into <configDir>/components/<id>/.
 *
 * AI is not here (P7): transcription, the LLM stages and the analysis engine
 * all run on Crucible, which installs its own models. The published
 * binaries-v1 manifest still carries whisper and llama entries for older
 * builds; Briefcase lists only {@link BRIEFCASE_COMPONENTS}.
 *
 * Progress is emitted via EventEmitter2 ('component.download.*') and relayed to
 * the frontend by AppGateway → WebsocketService.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import axios from 'axios';
import {
  Manifest,
  ManifestComponent,
  ComponentArtifact,
  ComponentStatus,
  InstalledManifest,
  InstalledRecord,
} from './component.types';

const MANIFEST_URL =
  'https://github.com/telltaleatheist/briefcase/releases/download/binaries-v1/manifest.json';

/** The manifest components this build uses. Everything else in the manifest is another build's. */
export const BRIEFCASE_COMPONENTS: ReadonlySet<string> = new Set(['ffmpeg-tools', 'yt-dlp']);

@Injectable()
export class ComponentManagerService implements OnModuleInit {
  private readonly logger = new Logger(ComponentManagerService.name);

  private readonly configDir: string;
  private readonly componentsDir: string;
  private readonly installedPath: string;
  private readonly manifestCachePath: string;
  private readonly tmpDir: string;

  private activeDownload: { componentId: string; controller: AbortController } | null = null;

  constructor(private readonly eventEmitter: EventEmitter2) {
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support')
        : path.join(process.env.HOME || os.homedir(), '.config'));

    this.configDir = path.join(userDataPath, 'briefcase');
    this.componentsDir = path.join(this.configDir, 'components');
    this.installedPath = path.join(this.componentsDir, 'installed.json');
    this.manifestCachePath = path.join(this.componentsDir, 'manifest-cache.json');
    this.tmpDir = path.join(this.componentsDir, '.tmp');
  }

  onModuleInit() {
    for (const dir of [this.componentsDir, this.tmpDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.logger.log(`Components directory: ${this.componentsDir}`);
  }

  getComponentsDir(): string {
    return this.componentsDir;
  }

  /** The catalog: the binaries this build uses, from the published manifest. */
  private async getAllComponents(): Promise<ManifestComponent[]> {
    const manifest = await this.getManifest();
    return manifest.components.filter((c) => c.kind === 'binary' && BRIEFCASE_COMPONENTS.has(c.id));
  }

  // ---------- manifest ----------

  /** Live-fetch the manifest, fall back to cache, then to a bundled copy. */
  async getManifest(): Promise<Manifest> {
    // 1. Live fetch
    try {
      const res = await axios.get(MANIFEST_URL, {
        timeout: 8000,
        headers: { 'User-Agent': 'Briefcase/1.0' },
        responseType: 'json',
      });
      const manifest = this.normalize(res.data);
      try {
        fs.writeFileSync(this.manifestCachePath, JSON.stringify(res.data, null, 2), 'utf8');
      } catch {
        // cache write is best-effort
      }
      return manifest;
    } catch (err: any) {
      this.logger.warn(`Live manifest fetch failed (${err.message}); using cache/bundled`);
    }

    // 2. Cache
    if (fs.existsSync(this.manifestCachePath)) {
      try {
        return this.normalize(JSON.parse(fs.readFileSync(this.manifestCachePath, 'utf8')));
      } catch {
        // fall through
      }
    }

    // 3. Bundled fallback
    for (const p of this.bundledManifestCandidates()) {
      if (fs.existsSync(p)) {
        try {
          return this.normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch {
          // try next
        }
      }
    }

    throw new Error('No component manifest available (live fetch, cache, and bundled copy all failed)');
  }

  private bundledManifestCandidates(): string[] {
    const out: string[] = [];
    if (process.env.RESOURCES_PATH) out.push(path.join(process.env.RESOURCES_PATH, 'assets', 'manifest.json'));
    if (process.env.BRIEFCASE_PROJECT_ROOT) out.push(path.join(process.env.BRIEFCASE_PROJECT_ROOT, 'assets', 'manifest.json'));
    return out;
  }

  /** The manifest's components (an older manifest's `models` list is not this build's). */
  private normalize(raw: any): Manifest {
    const components: ManifestComponent[] = Array.isArray(raw?.components) ? raw.components : [];
    return {
      schemaVersion: raw?.schemaVersion ?? 1,
      releaseTag: raw?.releaseTag,
      repo: raw?.repo,
      baseUrl: raw?.baseUrl,
      note: raw?.note,
      components,
    };
  }

  private pickArtifact(component: ManifestComponent): ComponentArtifact | null {
    const platform = process.platform;
    const arch = process.arch;
    return (
      component.artifacts.find(
        (a) => a.platform === platform && (a.arch === arch || a.arch === 'universal'),
      ) || null
    );
  }

  // ---------- installed state ----------

  private loadInstalled(): InstalledManifest {
    if (!fs.existsSync(this.installedPath)) {
      // Genuinely absent (fresh install) — empty manifest is the truth.
      return { components: {} };
    }
    const raw = fs.readFileSync(this.installedPath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      // Corrupt manifest. Returning {} here would report every installed
      // component as uninstalled and let the next recordInstalled() overwrite
      // the recoverable file. Preserve it and fail loudly.
      const corruptPath = `${this.installedPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(this.installedPath, corruptPath);
        this.logger.error(`installed.json is corrupt; backed it up to ${corruptPath}`);
      } catch (backupError) {
        this.logger.error(`installed.json is corrupt and could not be backed up: ${(backupError as Error).message}`);
      }
      throw new Error(
        `Component manifest at ${this.installedPath} is corrupt (${(error as Error).message}). ` +
        `It was backed up alongside the original; restore or delete it, then restart.`,
      );
    }
  }

  private saveInstalled(manifest: InstalledManifest): void {
    fs.writeFileSync(this.installedPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private recordInstalled(record: InstalledRecord): void {
    const installed = this.loadInstalled();
    installed.components[record.id] = record;
    this.saveInstalled(installed);
  }

  isInstalled(id: string): boolean {
    const installed = this.loadInstalled();
    const rec = installed.components[id];
    if (!rec) return false;
    const entryPath = path.join(rec.dir, rec.entry);
    return fs.existsSync(entryPath);
  }

  // ---------- public API ----------

  async listComponents(): Promise<ComponentStatus[]> {
    const components = await this.getAllComponents();
    return components.map((c) => {
      const art = this.pickArtifact(c);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        required: c.required,
        description: c.description,
        supported: art !== null,
        installed: this.isInstalled(c.id),
        sizeBytes: art?.bytes ?? 0,
        installedAt: this.loadInstalled().components[c.id]?.installedAt,
      };
    });
  }

  /** Install a component (download, verify, extract). */
  async install(id: string): Promise<void> {
    const components = await this.getAllComponents();
    const component = components.find((c) => c.id === id);
    if (!component) throw new Error(`Unknown component: ${id}`);

    const artifact = this.pickArtifact(component);
    if (!artifact) throw new Error(`Component ${id} is not available for ${process.platform}/${process.arch}`);

    // Reject if ANY download is active, including the same id — a double-click
    // would otherwise open a second concurrent stream to the same file and
    // corrupt it.
    if (this.activeDownload) {
      throw new Error(`Download already in progress: ${this.activeDownload.componentId}`);
    }

    const controller = new AbortController();
    this.activeDownload = { componentId: id, controller };
    this.emitProgress(id, 'download', 0, artifact.bytes);

    try {
      await this.installBinary(id, artifact, controller.signal);

      this.logger.log(`Component installed: ${id}`);
      this.eventEmitter.emit('component.download.complete', { componentId: id });
      this.activeDownload = null;
    } catch (error: any) {
      const isCancelled =
        axios.isCancel(error) ||
        error.name === 'AbortError' ||
        error.name === 'CanceledError' ||
        error.message === 'aborted' ||
        error.code === 'ERR_CANCELED';

      if (isCancelled) {
        this.logger.log(`Component download cancelled: ${id}`);
        this.eventEmitter.emit('component.download.cancelled', { componentId: id });
      } else {
        this.logger.error(`Component install failed for ${id}: ${error.message}`);
        this.eventEmitter.emit('component.download.error', {
          componentId: id,
          error: error.message || 'Install failed unexpectedly',
        });
      }
      this.activeDownload = null;
      throw error;
    }
  }

  cancel(): boolean {
    if (this.activeDownload) {
      this.activeDownload.controller.abort();
      return true;
    }
    return false;
  }

  async remove(id: string): Promise<void> {
    const installed = this.loadInstalled();
    const rec = installed.components[id];
    if (!rec) return;

    if (rec.kind === 'binary') {
      if (fs.existsSync(rec.dir)) fs.rmSync(rec.dir, { recursive: true, force: true });
    } else {
      // A single-file record (older builds recorded models this way).
      const file = path.join(rec.dir, rec.entry);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    delete installed.components[id];
    this.saveInstalled(installed);
    this.logger.log(`Removed component: ${id}`);
  }

  // ---------- install helpers ----------

  private async installBinary(id: string, artifact: ComponentArtifact, signal: AbortSignal): Promise<void> {
    if (!fs.existsSync(this.tmpDir)) fs.mkdirSync(this.tmpDir, { recursive: true });
    const archivePath = path.join(this.tmpDir, artifact.file || `${id}.archive`);

    await this.downloadToFile(artifact.url, archivePath, id, signal);

    this.emitProgress(id, 'verify', artifact.bytes, artifact.bytes);
    await this.verifySha256(archivePath, artifact.sha256);

    this.emitProgress(id, 'extract', artifact.bytes, artifact.bytes);
    const extractDir = path.join(this.tmpDir, `${id}-extract`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    // bsdtar (macOS/Windows) and gnu tar (Linux) both auto-detect gzip; bsdtar also reads .zip.
    // Our (platform, archive) pairs are always tar.gz on darwin/linux and .zip on win32.
    // execFileSync (argv array) — never a shell string — so a hostile manifest
    // filename can't inject shell commands.
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'pipe' });

    this.emitProgress(id, 'install', artifact.bytes, artifact.bytes);
    const finalDir = path.join(this.componentsDir, id);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(extractDir, finalDir);

    if (process.platform !== 'win32') {
      this.chmodRecursive(finalDir);
      if (process.platform === 'darwin') {
        try {
          execFileSync('xattr', ['-cr', finalDir], { stdio: 'pipe' });
        } catch {
          // best-effort quarantine clear
        }
      }
    }

    fs.rmSync(archivePath, { force: true });
    this.recordInstalled({
      id,
      kind: 'binary',
      dir: finalDir,
      entry: artifact.entry,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      installedAt: new Date().toISOString(),
    });
  }

  private chmodRecursive(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.chmodRecursive(full);
      } else {
        try {
          fs.chmodSync(full, 0o755);
        } catch {
          // ignore
        }
      }
    }
  }

  private async verifySha256(filePath: string, expected: string): Promise<void> {
    if (!expected) return;
    const actual = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      fs.rmSync(filePath, { force: true });
      throw new Error(`Checksum mismatch (expected ${expected}, got ${actual})`);
    }
  }

  /**
   * Resumable, retrying, abortable streamed download. Emits
   * 'component.download.progress' (phase 'download') as bytes arrive.
   */
  private async downloadToFile(
    url: string,
    destPath: string,
    componentId: string,
    signal: AbortSignal,
    retryCount = 0,
  ): Promise<void> {
    const MAX_RETRIES = 3;

    let resumeFromByte = 0;
    if (fs.existsSync(destPath) && retryCount > 0) {
      resumeFromByte = fs.statSync(destPath).size;
      this.logger.log(`Resuming ${componentId} from byte ${resumeFromByte}`);
    }

    try {
      const headers: Record<string, string> = { 'User-Agent': 'Briefcase/1.0' };
      if (resumeFromByte > 0) headers['Range'] = `bytes=${resumeFromByte}-`;

      const response = await axios.get(url, {
        responseType: 'stream',
        signal,
        timeout: 30000,
        maxRedirects: 5,
        headers,
      });

      // If we asked to resume (Range) but the server replied 200 (full body,
      // not 206 Partial Content), appending would corrupt the file. Restart from
      // byte 0 and truncate.
      if (resumeFromByte > 0 && response.status !== 206) {
        this.logger.warn(`${componentId}: server ignored Range (status ${response.status}); restarting from 0`);
        resumeFromByte = 0;
      }

      // Newer axios (1.20) types lowercase common headers as AxiosHeaderValue
      // (string | number | string[] | ...), so narrow before parsing.
      const rawContentLength = response.headers['content-length'];
      const contentLength =
        typeof rawContentLength === 'string' || typeof rawContentLength === 'number'
          ? parseInt(String(rawContentLength), 10) || 0
          : 0;
      const totalBytes = resumeFromByte + contentLength;
      let downloadedBytes = resumeFromByte;
      let lastTime = Date.now();
      let lastBytes = resumeFromByte;

      const writeStream = fs.createWriteStream(destPath, {
        highWaterMark: 16 * 1024 * 1024,
        flags: resumeFromByte > 0 ? 'a' : 'w',
      });

      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        const elapsed = now - lastTime;
        let speed: string | undefined;
        let eta: string | undefined;
        if (elapsed >= 1000) {
          const bps = ((downloadedBytes - lastBytes) / elapsed) * 1000;
          speed = `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
          // Only compute an ETA when we know the total and are making progress,
          // otherwise a missing content-length / stalled second yields "Infinityh".
          if (totalBytes > 0 && bps > 0) {
            const remaining = (totalBytes - downloadedBytes) / bps;
            eta = remaining < 60 ? `${Math.ceil(remaining)}s` : remaining < 3600 ? `${Math.ceil(remaining / 60)}m` : `${Math.ceil(remaining / 3600)}h`;
          }
          lastTime = now;
          lastBytes = downloadedBytes;
        }
        this.emitProgress(componentId, 'download', downloadedBytes, totalBytes, speed, eta);
      });

      response.data.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
        };
        writeStream.on('finish', () => { done(); resolve(); });
        writeStream.on('error', (err) => { done(); reject(err); });
        response.data.on('error', (err: Error) => { done(); writeStream.destroy(); reject(err); });
        signal.addEventListener('abort', () => {
          done();
          response.data.destroy();
          writeStream.destroy();
          reject(new Error('aborted'));
        });
      });

      // Reject a truncated/short download instead of accepting it as success.
      if (totalBytes > 0) {
        const finalSize = fs.statSync(destPath).size;
        if (finalSize !== totalBytes) {
          throw new Error(`${componentId}: downloaded ${finalSize} bytes but expected ${totalBytes}`);
        }
      }
    } catch (error: any) {
      const isCancelled =
        axios.isCancel(error) ||
        error.name === 'AbortError' ||
        error.name === 'CanceledError' ||
        error.message === 'aborted' ||
        error.code === 'ERR_CANCELED';
      if (isCancelled) {
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
        throw error;
      }

      const isRetryable =
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EAI_AGAIN' ||
        error.response?.status >= 500 ||
        error.message?.includes('socket hang up') ||
        error.message?.includes('network');

      if (isRetryable && retryCount < MAX_RETRIES) {
        this.logger.log(`Retrying ${componentId} download in 5s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, 5000));
        return this.downloadToFile(url, destPath, componentId, signal, retryCount + 1);
      }

      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      throw error;
    }
  }

  private emitProgress(
    componentId: string,
    phase: 'download' | 'verify' | 'extract' | 'install',
    downloadedBytes: number,
    totalBytes: number,
    speed?: string,
    eta?: string,
  ): void {
    const MB = 1024 * 1024;
    this.eventEmitter.emit('component.download.progress', {
      componentId,
      phase,
      progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 1000) / 10 : 0,
      downloadedMB: Math.round((downloadedBytes / MB) * 10) / 10,
      totalMB: Math.round((totalBytes / MB) * 10) / 10,
      speed,
      eta,
    });
  }
}
