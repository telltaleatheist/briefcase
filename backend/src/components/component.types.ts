/**
 * Types for the download-on-demand component system.
 *
 * The manifest is the catalog published alongside the GitHub binaries release
 * (manifest.json). Each component has per-(platform, arch) artifacts. This
 * build uses its ffmpeg-tools and yt-dlp binaries (AI runs on Crucible).
 */

/**
 * 'binary' is every component this build installs. The other kinds are read
 * only: install records older builds wrote (whisper and llama models, the NLI
 * environment) keep their kind in installed.json.
 */
export type ComponentKind = 'binary' | 'whisper-model' | 'llama-model' | 'python-env';

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
