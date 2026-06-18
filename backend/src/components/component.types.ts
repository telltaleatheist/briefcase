/**
 * Types for the download-on-demand component system.
 *
 * The manifest is the catalog published alongside the GitHub binaries release
 * (manifest.json). It lists binary components (ffmpeg, whisper, yt-dlp, llama)
 * and, optionally, whisper models (single-file downloads from a Hugging Face
 * mirror). Each component has per-(platform, arch) artifacts.
 */

export type ComponentKind = 'binary' | 'whisper-model';

export interface ComponentArtifact {
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64' | 'universal';
  url: string;
  file?: string;
  sha256: string;
  bytes: number;
  /** Executable/file to invoke, relative to the extracted component dir. */
  entry: string;
}

export interface ManifestComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  artifacts: ComponentArtifact[];
}

export interface Manifest {
  schemaVersion: number;
  releaseTag?: string;
  repo?: string;
  baseUrl?: string;
  note?: string;
  components: ManifestComponent[];
  /** Optional model entries (whisper ggml-*). Normalized into components at load. */
  models?: ManifestComponent[];
}

/** A record written to components/installed.json after a successful install. */
export interface InstalledRecord {
  id: string;
  kind: ComponentKind;
  /** Absolute directory the component was installed into. */
  dir: string;
  /** Executable/file relative to dir. */
  entry: string;
  sha256: string;
  bytes: number;
  installedAt: string;
}

export interface InstalledManifest {
  components: Record<string, InstalledRecord>;
}

/** Shape returned to the frontend by listComponents(). */
export interface ComponentStatus {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  /** True if a (platform, arch) artifact exists for the current machine. */
  supported: boolean;
  installed: boolean;
  sizeBytes: number;
  installedAt?: string;
}
